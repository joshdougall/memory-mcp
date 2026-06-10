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
const BODY_PREVIEW_CHARS = parseInt(process.env.BODY_PREVIEW_CHARS || '300', 10);
const SWEEP_INTERVAL_SECONDS = parseInt(process.env.SWEEP_INTERVAL_SECONDS || '600', 10);

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

// Atomically remove members of an index set whose mem:<id> hash no longer
// exists (TTL expiry leaves index members behind). Lua keeps the
// check-then-remove free of races with concurrent writes.
redis.defineCommand('sweepIndexSet', {
  numberOfKeys: 1,
  lua: `
    local removed = 0
    for _, m in ipairs(redis.call('SMEMBERS', KEYS[1])) do
      if redis.call('EXISTS', m) == 0 then
        redis.call('SREM', KEYS[1], m)
        removed = removed + 1
      end
    end
    return removed
  `,
});

// Drop a reverse-index key once its entry is gone. Atomic with the
// existence check so a concurrent recreate (which rewrites memidx)
// cannot lose its fresh reverse index.
redis.defineCommand('sweepReverseIndex', {
  numberOfKeys: 1,
  lua: `
    local id = string.sub(KEYS[1], 8)
    if redis.call('EXISTS', 'mem:' .. id) == 0 then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `,
});

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

const metricHitsZeroCount = new Gauge({
  name: 'memory_hits_zero_count',
  help: 'Number of memory entries with 0 hits (bloat indicator)',
  registers: [registry],
});

// Entry count cache: refreshed by the 60s gauge scan, adjusted inline on
// create/delete so the soft-cap warning never needs a keyspace scan.
let entryCount = 0;

async function refreshGauges() {
  try {
    const keys = await scanKeys('mem:*');
    entryCount = keys.length;
    metricEntriesTotal.set(keys.length);

    let zeroHits = 0;
    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      for (const key of keys) pipeline.hget(key, 'hits');
      const replies = await pipeline.exec();
      for (const [err, hits] of replies) {
        if (!err && (!hits || parseInt(hits, 10) === 0)) zeroHits++;
      }
    }
    metricHitsZeroCount.set(zeroHits);
  } catch (err) {
    console.error('[metrics] gauge refresh error:', err.message);
  }
}

setInterval(refreshGauges, 60_000);

async function sweepOrphanedIndexes() {
  try {
    const indexKeys = [
      ...(await scanKeys('tag:*')),
      ...(await scanKeys('type:*')),
      ...(await scanKeys('project:*')),
    ];
    let removed = 0;
    for (const key of indexKeys) {
      removed += await redis.sweepIndexSet(key);
    }

    // Reverse indexes are swept after the sets: a recreate landing
    // between the two phases rewrites memidx, which the Lua existence
    // check then leaves in place.
    for (const key of await scanKeys('memidx:*')) {
      removed += await redis.sweepReverseIndex(key);
    }

    if (removed > 0) console.log(`[sweep] removed ${removed} orphaned index record(s)`);
  } catch (err) {
    console.error('[sweep] error:', err.message);
  }
}

setInterval(sweepOrphanedIndexes, SWEEP_INTERVAL_SECONDS * 1000);

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
  return new Date().toISOString();
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

// Batch-fetch entry hashes in one round trip instead of one HGETALL per key.
// Returns [{ key, raw }] preserving input order; raw is null on a per-key error.
async function fetchEntries(keys) {
  const keyList = [...keys];
  if (keyList.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const key of keyList) pipeline.hgetall(key);
  const replies = await pipeline.exec();
  return keyList.map((key, i) => ({ key, raw: replies[i][0] ? null : replies[i][1] }));
}

async function incrementHits(ids) {
  if (ids.length === 0) return;
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hincrby(`mem:${id}`, 'hits', 1);
  await pipeline.exec();
}

function withBodyPreview(entry, full) {
  if (full) return entry;
  const { body, ...rest } = entry;
  const truncated = body.length > BODY_PREVIEW_CHARS;
  return { ...rest, body_preview: truncated ? body.slice(0, BODY_PREVIEW_CHARS) : body, truncated };
}

async function pushVersion(id, fields, operation) {
  const content = {
    title: fields.title || '',
    body: fields.body || '',
    type: fields.type || '',
    tags: fields.tags ? fields.tags.split(',').filter(Boolean) : [],
    source: fields.source || 'unknown',
    project: fields.project || '',
  };

  // Idempotent re-saves are common for agents; don't burn a version slot
  // when nothing changed.
  if (operation === 'modified') {
    const latest = await redis.lindex(`memver:${id}`, 0);
    if (latest) {
      try {
        const prev = JSON.parse(latest);
        delete prev.updated;
        delete prev.operation;
        if (JSON.stringify(prev) === JSON.stringify(content)) return;
      } catch {
        // unparseable snapshot — push a fresh one
      }
    }
  }

  const snapshot = JSON.stringify({ ...content, updated: nowIso(), operation });
  await redis.lpush(`memver:${id}`, snapshot);
  await redis.ltrim(`memver:${id}`, 0, MAX_VERSIONS_PER_ENTRY - 1);
}

// Remove an ID's current index memberships. The reverse index at
// memidx:<id> is authoritative because it outlives a TTL'd entry: a
// recreated ID must clean up memberships left by its expired
// predecessor, whose hash (and field data) no longer exists. Falls back
// to the live hash for entries written before memidx existed.
async function clearIndexMemberships(id, existing) {
  let type, project, tags;

  const raw = await redis.get(`memidx:${id}`);
  if (raw) {
    try {
      ({ type, project, tags } = JSON.parse(raw));
    } catch {
      // corrupted reverse index — fall back to the hash below
    }
  }
  if (tags === undefined && existing && existing.title) {
    type = existing.type;
    project = existing.project || '';
    tags = existing.tags ? existing.tags.split(',').filter(Boolean) : [];
  }
  if (tags === undefined) return;

  const pipeline = redis.pipeline();
  if (type) pipeline.srem(`type:${type}`, `mem:${id}`);
  pipeline.srem(`project:${project || ''}`, `mem:${id}`);
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
  pipeline.set(
    `memidx:${id}`,
    JSON.stringify({ type: type || '', project: project || '', tags: tags.filter(Boolean) })
  );
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
// MCP SERVER
// ============================================================================

function buildMcpServer() {
  const server = new McpServer({
    name: 'memory-mcp',
    version: '1.0.0',
  });

  server.tool(
    'memory_search',
    'Search memories by tag intersection, type, project, or text substring. Returns entries sorted by hits desc then updated desc, with a body_preview by default (pass full: true for complete bodies). Returned entries count as hits.',
    {
      tags: z.array(z.string()).optional().describe('Tag names to intersect (all must match)'),
      type: z.string().optional().describe('Filter by memory type (pattern, decision, reference, feedback, incident, project, entity, state)'),
      project: z.string().optional().describe('Filter by project name (empty string for cross-project)'),
      query: z.string().optional().describe('Substring to match against title and body'),
      limit: z.number().int().positive().optional().default(20).describe('Maximum results to return'),
      full: z.boolean().optional().default(false).describe('Return complete bodies instead of body_preview'),
    },
    async ({ tags, type, project, query, limit, full }) => {
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
        for (const { key, raw } of await fetchEntries(candidateKeys)) {
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

        await incrementHits(limited.map((r) => r.id));
        const payload = limited.map((r) => withBodyPreview({ ...r, hits: r.hits + 1 }, full));

        return {
          content: [{ type: 'text', text: JSON.stringify({ count: payload.length, results: payload }, null, 2) }],
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
      await redis.hincrby(`mem:${id}`, 'hits', 1);
      const entry = entryToObject(raw);
      entry.hits += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ id, ...entry }, null, 2) }] };
    }
  );

  server.tool(
    'memory_set',
    'Create or update a memory entry. Creates a version snapshot on every content change (identical re-saves are not versioned).',
    {
      id: z.string().describe('Unique memory ID (slug-style, e.g. ansible-vault-pattern)'),
      title: z.string().describe('Short descriptive title'),
      body: z.string().describe('Full memory content'),
      type: z.string().describe('Memory type: pattern, decision, reference, feedback, incident, project, entity, state'),
      tags: z.array(z.string()).describe('Tags for indexing and retrieval'),
      source: z.string().optional().default('unknown').describe('Who created/updated this entry'),
      project: z.string().optional().default('').describe('Project scope (empty = cross-project)'),
      ttl: z.number().int().positive().optional().describe('Seconds until expiry (omit for permanent)'),
    },
    async ({ id, title, body, type, tags, source, project, ttl }) => {
      const existing = await redis.hgetall(`mem:${id}`);
      const isNew = !existing || !existing.title;
      const operation = isNew ? 'created' : 'modified';
      const now = nowIso();

      // Always clear: a "new" ID may be reusing an expired entry's slot
      // whose index memberships are still present.
      await clearIndexMemberships(id, existing);

      const fields = {
        title, body, type,
        source: source || 'unknown',
        project: project || '',
        updated: now,
        hits: isNew ? '0' : (existing.hits || '0'),
        ttl: ttl ? String(ttl) : '',
        tags: tags.join(','),
        created: isNew ? now : (existing.created || now),
      };

      const pipeline = redis.pipeline();
      pipeline.hset(`mem:${id}`, fields);
      if (ttl) {
        pipeline.expire(`mem:${id}`, ttl);
      } else if (!isNew) {
        pipeline.persist(`mem:${id}`);
      }
      await pipeline.exec();

      await addToIndexes(id, type, project || '', tags);
      await pushVersion(id, { ...fields }, operation);

      // Version history shares the entry's lifetime: expire alongside a
      // TTL'd entry, persist when the TTL is removed. Persist even on
      // isNew — a recreated ID may inherit a live TTL from its expired
      // predecessor's history.
      if (ttl) {
        await redis.expire(`memver:${id}`, ttl);
      } else {
        await redis.persist(`memver:${id}`);
      }

      metricWriteTotal.inc();
      if (isNew) entryCount++;

      const warning = entryCount > MAX_ENTRIES_WARN
        ? `Entry count (${entryCount}) exceeds soft cap of ${MAX_ENTRIES_WARN}. Consider running memory_prune_candidates.`
        : null;

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, operation, warning }, null, 2) }] };
    }
  );

  server.tool(
    'memory_list',
    'List memory entries with optional filters. Sorted by hits or last updated. Returns a body_preview by default (pass full: true for complete bodies). Listing does not count as hits.',
    {
      type: z.string().optional().describe('Filter by memory type'),
      project: z.string().optional().describe('Filter by project'),
      sort: z.enum(['hits', 'updated']).optional().default('hits').describe('Sort order'),
      limit: z.number().int().positive().optional().default(50).describe('Maximum results'),
      full: z.boolean().optional().default(false).describe('Return complete bodies instead of body_preview'),
    },
    async ({ type, project, sort, limit, full }) => {
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
      for (const { key, raw } of await fetchEntries(candidateKeys)) {
        if (!raw || !raw.title) continue;
        const id = key.replace(/^mem:/, '');
        results.push({ id, ...entryToObject(raw) });
      }

      results.sort((a, b) => {
        if (sort === 'updated') return (b.updated || '').localeCompare(a.updated || '');
        if (b.hits !== a.hits) return b.hits - a.hits;
        return (b.updated || '').localeCompare(a.updated || '');
      });

      const payload = results.slice(0, limit || 50).map((r) => withBodyPreview(r, full));
      return { content: [{ type: 'text', text: JSON.stringify({ count: payload.length, results: payload }, null, 2) }] };
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
      await clearIndexMemberships(id, existing);
      await redis.del(`mem:${id}`, `memidx:${id}`);
      entryCount = Math.max(0, entryCount - 1);
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
      await clearIndexMemberships(id, existing);

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

      for (const { key, raw } of await fetchEntries(keys)) {
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
  sweepOrphanedIndexes();
});
