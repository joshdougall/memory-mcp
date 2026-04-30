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
redis.on('connect', () => console.log('[redis] connected to', VALKEY_URL));

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

async function refreshGauges() {
  try {
    const keys = await redis.keys('mem:*');
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

async function pushVersion(id, fields, operation) {
  const snapshot = JSON.stringify({
    title: fields.title || '',
    body: fields.body || '',
    type: fields.type || '',
    tags: fields.tags ? fields.tags.split(',').filter(Boolean) : [],
    source: fields.source || 'unknown',
    project: fields.project || '',
    updated: nowIso(),
    operation,
  });
  await redis.lpush(`memver:${id}`, snapshot);
  await redis.ltrim(`memver:${id}`, 0, MAX_VERSIONS_PER_ENTRY - 1);
}

async function removeFromIndexes(id, fields) {
  const pipeline = redis.pipeline();
  if (fields.type) pipeline.srem(`type:${fields.type}`, `mem:${id}`);
  if (fields.project) pipeline.srem(`project:${fields.project}`, `mem:${id}`);
  const tags = fields.tags ? fields.tags.split(',').filter(Boolean) : [];
  for (const tag of tags) {
    pipeline.srem(`tag:${tag}`, `mem:${id}`);
  }
  await pipeline.exec();
}

async function addToIndexes(id, type, project, tags) {
  const pipeline = redis.pipeline();
  if (type) pipeline.sadd(`type:${type}`, `mem:${id}`);
  if (project) pipeline.sadd(`project:${project}`, `mem:${id}`);
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
          const allKeys = await redis.keys('mem:*');
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
      await redis.hincrby(`mem:${id}`, 'hits', 1);
      const entry = entryToObject(raw);
      entry.hits += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ id, ...entry }, null, 2) }] };
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
    },
    async ({ id, title, body, type, tags, source, project, ttl }) => {
      const existing = await redis.hgetall(`mem:${id}`);
      const isNew = !existing || !existing.title;
      const operation = isNew ? 'created' : 'modified';
      const now = nowIso();

      if (!isNew) await removeFromIndexes(id, existing);

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
      if (isNew && ttl) pipeline.expire(`mem:${id}`, ttl);
      await pipeline.exec();

      await addToIndexes(id, type, project || '', tags);
      await pushVersion(id, { ...fields }, operation);
      metricWriteTotal.inc();

      const totalKeys = await redis.keys('mem:*');
      const warning = totalKeys.length > MAX_ENTRIES_WARN
        ? `Entry count (${totalKeys.length}) exceeds soft cap of ${MAX_ENTRIES_WARN}. Consider running memory_prune_candidates.`
        : null;

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, operation, warning }, null, 2) }] };
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
        candidateKeys = new Set(await redis.keys('mem:*'));
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
      const keys = await redis.keys('mem:*');
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    if (!checkAuth(req, res)) return;

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
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
  console.log(`[memory-mcp] Valkey:        ${VALKEY_URL}`);
  refreshGauges();
});
