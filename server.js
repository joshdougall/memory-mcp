// memory-mcp server.js
// Valkey-backed shared agent memory MCP server

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createServer } from 'node:http';
import Redis from 'ioredis';
import {
  Registry,
  Gauge,
  Counter,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = parseInt(process.env.PORT || '8000', 10);
const VALKEY_URL = process.env.VALKEY_URL || 'redis://valkey:6379';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const MAX_ENTRIES_WARN = parseInt(process.env.MAX_ENTRIES_WARN || '300', 10);
const MAX_VERSIONS_PER_ENTRY = parseInt(process.env.MAX_VERSIONS_PER_ENTRY || '20', 10);
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(1024 * 1024), 10);
const OPERATION_ID_TTL_SECONDS = parseInt(process.env.OPERATION_ID_TTL_SECONDS || String(7 * 24 * 60 * 60), 10);

if (AUTH_TOKEN) {
  console.log('[memory-mcp] auth: bearer token required');
} else {
  console.log('[memory-mcp] auth: disabled (set AUTH_TOKEN to enable)');
}

// ============================================================================
// REDIS / VALKEY CLIENT
// ============================================================================

const redis = new Redis(VALKEY_URL, {
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

redis.on('error', (err) => console.error('[redis] error:', err.message));
redis.on('connect', () => console.log('[redis] connected to', maskUrl(VALKEY_URL)));

// ============================================================================
// HELPERS
// ============================================================================

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

// ============================================================================
// PROMETHEUS METRICS
// ============================================================================

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'memory_mcp_process_' });

const metricEntriesTotal = new Gauge({
  name: 'memory_entries_total',
  help: 'Total number of memory entries in Valkey',
  registers: [registry],
});

const metricSearchDuration = new Histogram({
  name: 'memory_search_duration_seconds',
  help: 'Latency of memory_search operations',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
  registers: [registry],
});

const metricSearchTotal = new Counter({
  name: 'memory_search_total',
  help: 'Total number of memory_search calls',
  registers: [registry],
});

const metricSearchEmptyTotal = new Counter({
  name: 'memory_search_empty_total',
  help: 'Number of memory_search calls that returned 0 results',
  registers: [registry],
});

const metricWriteTotal = new Counter({
  name: 'memory_write_total',
  help: 'Total number of memory write operations (create + update)',
  registers: [registry],
});

const metricConflictTotal = new Counter({
  name: 'memory_conflict_total',
  help: 'Total number of memory_set calls rejected by an if_version mismatch',
  registers: [registry],
});

const metricHitsZeroCount = new Gauge({
  name: 'memory_hits_zero_count',
  help: 'Number of memory entries with 0 hits (bloat indicator)',
  registers: [registry],
});

async function refreshGauges() {
  try {
    const keys = await scanKeys('mem:*');
    metricEntriesTotal.set(keys.length);

    let zeroHits = 0;
    for (const key of keys) {
      const hits = await redis.hget(key, 'hits');
      if (!hits || parseInt(hits, 10) === 0) zeroHits++;
    }
    metricHitsZeroCount.set(zeroHits);
  } catch (err) {
    console.error('[metrics] gauge refresh error:', err.message);
  }
}

setInterval(refreshGauges, 60_000);

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

function checkAuth(req, res) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers['authorization'] || '';
  if (header === `Bearer ${AUTH_TOKEN}`) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

// ============================================================================
// HELPERS
// ============================================================================

function nowIso() {
  return new Date().toISOString().slice(0, 10);
}

async function scanKeys(pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

async function pushVersion(id, fields, operation, rev) {
  const snapshot = JSON.stringify({
    title: fields.title || '',
    body: fields.body || '',
    type: fields.type || '',
    tags: fields.tags ? fields.tags.split(',').filter(Boolean) : [],
    source: fields.source || 'unknown',
    project: fields.project || '',
    updated: nowIso(),
    operation,
    rev,
  });
  await redis.lpush(`memver:${id}`, snapshot);
  await redis.ltrim(`memver:${id}`, 0, MAX_VERSIONS_PER_ENTRY - 1);
}

async function removeFromIndexes(id, fields) {
  const pipeline = redis.pipeline();
  if (fields.type) pipeline.srem(`type:${fields.type}`, `mem:${id}`);
  pipeline.srem(`project:${fields.project || ''}`, `mem:${id}`);
  const tags = fields.tags ? fields.tags.split(',').filter(Boolean) : [];
  for (const tag of tags) {
    pipeline.srem(`tag:${tag}`, `mem:${id}`);
  }
  await pipeline.exec();
}

async function addToIndexes(id, type, project, tags) {
  const pipeline = redis.pipeline();
  if (type) pipeline.sadd(`type:${type}`, `mem:${id}`);
  pipeline.sadd(`project:${project}`, `mem:${id}`);
  for (const tag of tags) {
    if (tag) pipeline.sadd(`tag:${tag}`, `mem:${id}`);
  }
  await pipeline.exec();
}

function entryToObject(raw) {
  return {
    title: raw.title || '',
    body: raw.body || '',
    type: raw.type || '',
    tags: raw.tags ? raw.tags.split(',').filter(Boolean) : [],
    source: raw.source || '',
    project: raw.project || '',
    created: raw.created || '',
    updated: raw.updated || '',
    hits: parseInt(raw.hits || '0', 10),
    ttl: raw.ttl || '',
  };
}

// ============================================================================
// LUA: ATOMIC memory_set
// ============================================================================

// A pipeline batches round trips but is not atomic, and a compare-and-set needs
// to read the revision and conditionally abort in the same breath. EVAL is
// atomic in Valkey, so the replay check, the revision check and the write either
// all happen or none do.
//
// KEYS: 1 mem:<id>  2 memver:<id>  3 memrev:<id>  4 memop:<operation_id> ('' when unused)
// ARGV: 1 id  2 title  3 body  4 type  5 tagsCsv  6 tagsJson  7 source
//       8 project  9 now  10 ttl  11 maxVersions  12 ifVersion  13 hasOp  14 opTtl
//
// Index set names are derived inside the script rather than passed as keys. This
// server already assumes a single (non-cluster) Valkey: memory_search SINTERs
// across tag: keys that would hash to different slots.
const MEMORY_SET_LUA = `
local memKey, verKey, revKey, opKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]

local id          = ARGV[1]
local title       = ARGV[2]
local body        = ARGV[3]
local mtype       = ARGV[4]
local tagsCsv     = ARGV[5]
local tagsJson    = ARGV[6]
local source      = ARGV[7]
local project     = ARGV[8]
local now         = ARGV[9]
local ttl         = ARGV[10]
local maxVersions = tonumber(ARGV[11])
local ifVersion   = ARGV[12]
local hasOp       = ARGV[13] == '1'
local opTtl       = tonumber(ARGV[14])

local function splitCsv(csv)
  local out = {}
  for item in string.gmatch(csv or '', '([^,]+)') do out[#out + 1] = item end
  return out
end

-- 1. Replay: an already recorded operation_id returns its outcome and writes nothing.
if hasOp then
  local rec = redis.call('HMGET', opKey, 'memory_id', 'revision', 'action')
  if rec[1] then
    return cjson.encode({
      status = 'replayed',
      id = rec[1],
      revision = tonumber(rec[2]),
      operation = rec[3],
    })
  end
end

-- 2. Compare-and-set. A missing counter reads as 0, so if_version 0 means
--    "create if absent", and also upgrades a legacy entry that predates this field.
local currentRev = tonumber(redis.call('GET', revKey) or '0')
if ifVersion ~= '' and currentRev ~= tonumber(ifVersion) then
  return cjson.encode({
    status = 'conflict',
    id = id,
    current_revision = currentRev,
    expected_version = tonumber(ifVersion),
  })
end

-- 3. Apply.
local flat = redis.call('HGETALL', memKey)
local prev = {}
for i = 1, #flat, 2 do prev[flat[i]] = flat[i + 1] end
local isNew = prev.title == nil
local operation = isNew and 'created' or 'modified'

if not isNew then
  if prev.type and prev.type ~= '' then redis.call('SREM', 'type:' .. prev.type, memKey) end
  redis.call('SREM', 'project:' .. (prev.project or ''), memKey)
  for _, t in ipairs(splitCsv(prev.tags)) do redis.call('SREM', 'tag:' .. t, memKey) end
end

local newRev = redis.call('INCR', revKey)

redis.call('HSET', memKey,
  'title', title,
  'body', body,
  'type', mtype,
  'source', source,
  'project', project,
  'updated', now,
  'hits', isNew and '0' or (prev.hits or '0'),
  'ttl', ttl,
  'tags', tagsCsv,
  'created', isNew and now or (prev.created or now))

if ttl ~= '' then
  redis.call('EXPIRE', memKey, tonumber(ttl))
elseif not isNew then
  redis.call('PERSIST', memKey)
end

if mtype ~= '' then redis.call('SADD', 'type:' .. mtype, memKey) end
redis.call('SADD', 'project:' .. project, memKey)
for _, t in ipairs(splitCsv(tagsCsv)) do redis.call('SADD', 'tag:' .. t, memKey) end

-- tagsJson arrives pre-encoded from the caller: cjson encodes an empty Lua table
-- as {} rather than [], which would corrupt the tags array in history.
redis.call('LPUSH', verKey, string.format(
  '{"title":%s,"body":%s,"type":%s,"tags":%s,"source":%s,"project":%s,"updated":%s,"operation":%s,"rev":%d}',
  cjson.encode(title), cjson.encode(body), cjson.encode(mtype), tagsJson,
  cjson.encode(source), cjson.encode(project), cjson.encode(now), cjson.encode(operation), newRev))
redis.call('LTRIM', verKey, 0, maxVersions - 1)

if hasOp then
  redis.call('HSET', opKey, 'memory_id', id, 'revision', newRev, 'action', operation)
  redis.call('EXPIRE', opKey, opTtl)
end

return cjson.encode({ status = 'ok', id = id, revision = newRev, operation = operation })
`;

redis.defineCommand('memorySetAtomic', { numberOfKeys: 4, lua: MEMORY_SET_LUA });

// ============================================================================
// MCP SERVER
// ============================================================================

function buildMcpServer() {
  const server = new McpServer({
    name: 'memory-mcp',
    version: '1.0.0',
  });

  server.tool(
    'memory_search',
    'Search memories by tag intersection, type, project, or text substring. Returns entries sorted by hits desc then updated desc.',
    {
      tags: z.array(z.string()).optional().describe('Tag names to intersect (all must match)'),
      type: z.string().optional().describe('Filter by memory type (pattern, decision, reference, feedback, incident, project, entity, state)'),
      project: z.string().optional().describe('Filter by project name (empty string for cross-project)'),
      query: z.string().optional().describe('Substring to match against title and body'),
      limit: z.number().int().positive().optional().default(20).describe('Maximum results to return'),
    },
    async ({ tags, type, project, query, limit }) => {
      const end = metricSearchDuration.startTimer();
      metricSearchTotal.inc();

      try {
        let candidateKeys = null;

        if (tags && tags.length > 0) {
          const tagKeys = tags.map((t) => `tag:${t}`);
          if (tagKeys.length === 1) {
            const members = await redis.smembers(tagKeys[0]);
            candidateKeys = new Set(members);
          } else {
            const members = await redis.sinter(...tagKeys);
            candidateKeys = new Set(members);
          }
        }

        if (type) {
          const typeMembers = await redis.smembers(`type:${type}`);
          const typeSet = new Set(typeMembers);
          candidateKeys === null
            ? (candidateKeys = typeSet)
            : candidateKeys.forEach((k) => { if (!typeSet.has(k)) candidateKeys.delete(k); });
        }

        if (project !== undefined && project !== null) {
          const projMembers = await redis.smembers(`project:${project}`);
          const projSet = new Set(projMembers);
          candidateKeys === null
            ? (candidateKeys = projSet)
            : candidateKeys.forEach((k) => { if (!projSet.has(k)) candidateKeys.delete(k); });
        }

        if (candidateKeys === null) {
          const allKeys = await scanKeys('mem:*');
          candidateKeys = new Set(allKeys);
        }

        const results = [];
        for (const key of candidateKeys) {
          const raw = await redis.hgetall(key);
          if (!raw || !raw.title) continue;

          if (query) {
            const q = query.toLowerCase();
            if (!raw.title.toLowerCase().includes(q) && !(raw.body || '').toLowerCase().includes(q)) {
              continue;
            }
          }

          const id = key.replace(/^mem:/, '');
          results.push({ id, ...entryToObject(raw) });
        }

        results.sort((a, b) => {
          if (b.hits !== a.hits) return b.hits - a.hits;
          return (b.updated || '').localeCompare(a.updated || '');
        });

        const limited = results.slice(0, limit || 20);
        if (limited.length === 0) metricSearchEmptyTotal.inc();

        return {
          content: [{ type: 'text', text: JSON.stringify({ count: limited.length, results: limited }, null, 2) }],
        };
      } finally {
        end();
      }
    }
  );

  server.tool(
    'memory_get',
    'Retrieve a single memory entry by ID. Increments the hit counter.',
    { id: z.string().describe('Memory entry ID (without mem: prefix)') },
    async ({ id }) => {
      const raw = await redis.hgetall(`mem:${id}`);
      if (!raw || !raw.title) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Not found: ${id}` }) }] };
      }
      const pipe = await redis.pipeline()
        .hincrby(`mem:${id}`, 'hits', 1)
        .get(`memrev:${id}`)
        .exec();
      const revision = parseInt((pipe && pipe[1] && pipe[1][1]) || '0', 10);
      const entry = entryToObject(raw);
      entry.hits += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ id, ...entry, revision }, null, 2) }] };
    }
  );

  server.tool(
    'memory_set',
    'Create or update a memory entry. Creates a version snapshot on every write.',
    {
      id: z.string().describe('Unique memory ID (slug-style, e.g. ansible-vault-pattern)'),
      title: z.string().describe('Short descriptive title'),
      body: z.string().describe('Full memory content'),
      type: z.string().describe('Memory type: pattern, decision, reference, feedback, incident, project, entity, state'),
      tags: z.array(z.string()).describe('Tags for indexing and retrieval'),
      source: z.string().optional().default('unknown').describe('Who created/updated this entry'),
      project: z.string().optional().default('').describe('Project scope (empty = cross-project)'),
      ttl: z.number().int().positive().optional().describe('Seconds until expiry (omit for permanent)'),
      if_version: z.number().int().min(0).optional().describe('Compare-and-set: apply only if the current revision equals this. 0 means create-if-absent. Omit for an unconditional write.'),
      operation_id: z.string().min(1).max(200).optional().describe('Idempotency key. Replaying a recorded id returns the original result and writes nothing. Retained for 7 days.'),
    },
    async ({ id, title, body, type, tags, source, project, ttl, if_version, operation_id }) => {
      const result = JSON.parse(await redis.memorySetAtomic(
        `mem:${id}`,
        `memver:${id}`,
        `memrev:${id}`,
        operation_id ? `memop:${operation_id}` : '',
        id,
        title,
        body,
        type,
        tags.join(','),
        JSON.stringify(tags),
        source || 'unknown',
        project || '',
        nowIso(),
        ttl ? String(ttl) : '',
        String(MAX_VERSIONS_PER_ENTRY),
        if_version === undefined ? '' : String(if_version),
        operation_id ? '1' : '0',
        String(OPERATION_ID_TTL_SECONDS)
      ));

      if (result.status === 'conflict') {
        metricConflictTotal.inc();
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'conflict', id, current_revision: result.current_revision, expected_version: result.expected_version }, null, 2) }] };
      }

      if (result.status === 'replayed') {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: result.id, operation: result.operation, revision: result.revision, replayed: true }, null, 2) }] };
      }

      metricWriteTotal.inc();

      const totalKeys = await scanKeys('mem:*');
      const warning = totalKeys.length > MAX_ENTRIES_WARN
        ? `Entry count (${totalKeys.length}) exceeds soft cap of ${MAX_ENTRIES_WARN}. Consider running memory_prune_candidates.`
        : null;

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, operation: result.operation, revision: result.revision, warning }, null, 2) }] };
    }
  );

  server.tool(
    'memory_list',
    'List memory entries with optional filters. Sorted by hits or last updated.',
    {
      type: z.string().optional().describe('Filter by memory type'),
      project: z.string().optional().describe('Filter by project'),
      sort: z.enum(['hits', 'updated']).optional().default('hits').describe('Sort order'),
      limit: z.number().int().positive().optional().default(50).describe('Maximum results'),
    },
    async ({ type, project, sort, limit }) => {
      let candidateKeys = null;

      if (type) {
        candidateKeys = new Set(await redis.smembers(`type:${type}`));
      }

      if (project !== undefined && project !== null) {
        const projSet = new Set(await redis.smembers(`project:${project}`));
        candidateKeys === null
          ? (candidateKeys = projSet)
          : candidateKeys.forEach((k) => { if (!projSet.has(k)) candidateKeys.delete(k); });
      }

      if (candidateKeys === null) {
        candidateKeys = new Set(await scanKeys('mem:*'));
      }

      const results = [];
      for (const key of candidateKeys) {
        const raw = await redis.hgetall(key);
        if (!raw || !raw.title) continue;
        const id = key.replace(/^mem:/, '');
        results.push({ id, ...entryToObject(raw) });
      }

      results.sort((a, b) => {
        if (sort === 'updated') return (b.updated || '').localeCompare(a.updated || '');
        if (b.hits !== a.hits) return b.hits - a.hits;
        return (b.updated || '').localeCompare(a.updated || '');
      });

      return { content: [{ type: 'text', text: JSON.stringify({ count: results.slice(0, limit || 50).length, results: results.slice(0, limit || 50) }, null, 2) }] };
    }
  );

  server.tool(
    'memory_delete',
    'Delete a memory entry. Writes a tombstone version, removes from all indexes.',
    { id: z.string().describe('Memory entry ID to delete') },
    async ({ id }) => {
      const existing = await redis.hgetall(`mem:${id}`);
      if (!existing || !existing.title) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Not found: ${id}` }) }] };
      }
      await pushVersion(id, existing, 'deleted');
      await removeFromIndexes(id, existing);
      await redis.del(`mem:${id}`);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, operation: 'deleted' }, null, 2) }] };
    }
  );

  server.tool(
    'memory_history',
    'Retrieve version history for a memory entry. Returns versions newest-first.',
    {
      id: z.string().describe('Memory entry ID'),
      limit: z.number().int().positive().optional().default(10).describe('Number of versions to return'),
    },
    async ({ id, limit }) => {
      const raw = await redis.lrange(`memver:${id}`, 0, (limit || 10) - 1);
      const versions = raw.map((v, i) => {
        try { return { index: i, ...JSON.parse(v) }; }
        catch { return { index: i, raw: v }; }
      });
      return { content: [{ type: 'text', text: JSON.stringify({ id, count: versions.length, versions }, null, 2) }] };
    }
  );

  server.tool(
    'memory_rollback',
    'Restore a memory entry to a previous version. The rollback itself is recorded as a new version.',
    {
      id: z.string().describe('Memory entry ID to roll back'),
      version_index: z.number().int().min(0).describe('Index from memory_history (0 = most recent)'),
    },
    async ({ id, version_index }) => {
      const raw = await redis.lindex(`memver:${id}`, version_index);
      if (!raw) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Version ${version_index} not found for ${id}` }) }] };
      }

      let version;
      try { version = JSON.parse(raw); }
      catch { return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not parse version snapshot' }) }] }; }

      const existing = await redis.hgetall(`mem:${id}`);
      if (existing && existing.title) await removeFromIndexes(id, existing);

      const tags = Array.isArray(version.tags) ? version.tags : [];
      const fields = {
        title: version.title || '',
        body: version.body || '',
        type: version.type || '',
        source: version.source || 'unknown',
        project: version.project || '',
        updated: nowIso(),
        hits: existing ? (existing.hits || '0') : '0',
        ttl: existing ? (existing.ttl || '') : '',
        tags: tags.join(','),
      };

      await redis.hset(`mem:${id}`, fields);
      await addToIndexes(id, fields.type, fields.project, tags);
      await pushVersion(id, { ...fields }, `rollback_to_${version_index}`);
      metricWriteTotal.inc();

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, operation: `rollback_to_${version_index}`, restored_from: version.updated || 'unknown' }, null, 2) }] };
    }
  );

  server.tool(
    'memory_prune_candidates',
    'List memory entries with 0 hits that have not been updated within the threshold. For human review only, does not delete anything.',
    { days: z.number().int().positive().optional().default(30).describe('Entries not updated in this many days are candidates') },
    async ({ days }) => {
      const cutoff = new Date(Date.now() - (days || 30) * 86400000).toISOString().slice(0, 10);
      const keys = await scanKeys('mem:*');
      const candidates = [];

      for (const key of keys) {
        const raw = await redis.hgetall(key);
        if (!raw || !raw.title) continue;
        if (parseInt(raw.hits || '0', 10) !== 0) continue;
        if ((raw.updated || '') >= cutoff) continue;
        candidates.push({ id: key.replace(/^mem:/, ''), ...entryToObject(raw) });
      }

      candidates.sort((a, b) => (a.updated || '').localeCompare(b.updated || ''));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: candidates.length, threshold_days: days || 30, cutoff_date: cutoff, candidates }, null, 2),
        }],
      };
    }
  );

  return server;
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const httpServer = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/metrics') {
    try {
      const metrics = await registry.metrics();
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(metrics);
    } catch (err) {
      res.writeHead(500);
      res.end(err.message);
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    try {
      await redis.ping();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Valkey unavailable' }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    if (!checkAuth(req, res)) return;

    let body = '';
    let bodySize = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_BYTES) { tooLarge = true; return; }
      body += chunk;
    });
    req.on('end', async () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Request too large' }, id: null }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
        return;
      }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = buildMcpServer();
      await mcpServer.connect(transport);

      try {
        await transport.handleRequest(req, res, parsed);
      } catch (err) {
        console.error('[mcp] request error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
        }
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[memory-mcp] listening on port ${PORT}`);
  console.log(`[memory-mcp] MCP endpoint:  POST http://0.0.0.0:${PORT}/mcp`);
  console.log(`[memory-mcp] Health:        GET  http://0.0.0.0:${PORT}/health`);
  console.log(`[memory-mcp] Metrics:       GET  http://0.0.0.0:${PORT}/metrics`);
  console.log(`[memory-mcp] Valkey:        ${maskUrl(VALKEY_URL)}`);
  refreshGauges();
});
