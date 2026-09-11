import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import Redis from 'ioredis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { terminateChild } from './helpers/compact-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3131;
const VALKEY = 'redis://127.0.0.1:6379/7';
let proc; let client; let redis;

async function waitForHealth(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  redis = new Redis(VALKEY);
  await redis.flushdb();
  proc = spawn(process.execPath, [join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), VALKEY_URL: VALKEY }, stdio: 'pipe',
  });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  await waitForHealth(PORT);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
}, 60000);

afterAll(async () => {
  await client?.close?.(); await redis.flushdb(); await redis.quit();
  if (proc) await terminateChild(proc);
});

const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

describe('hybrid memory_search', () => {
  it('finds an entry whose wording differs from the query', async () => {
    await call('memory_set', {
      id: 'authority', title: 'Decision authority',
      body: 'Josh is the final decision authority. Escalate when unsure whether to act.',
      type: 'decision', tags: ['test'],
    });
    const out = await call('memory_search', { query: 'who decides if I am not sure I should proceed', limit: 5 });
    const hit = out.results.find((r) => r.id === 'authority');
    expect(hit).toBeDefined();
    expect(hit.vectorScore).toBeGreaterThan(0.3);
    expect(hit.textScore).toBe(0);        // shares no wording
    expect(hit.excerpt).toContain('decision authority');
    expect(hit.chunkRange).toHaveProperty('start');
  }, 120000);

  it('still finds an exact id by substring', async () => {
    await call('memory_set', {
      id: 'audit-rule-abc-20260809-004118', title: 'junk', body: 'machine exhaust',
      type: 'reference', tags: ['test'],
    });
    const out = await call('memory_search', { query: 'audit-rule-abc-20260809-004118', limit: 5 });
    expect(out.results.some((r) => r.id === 'audit-rule-abc-20260809-004118')).toBe(true);
  }, 120000);

  it('applies tag filters before scoring', async () => {
    const out = await call('memory_search', { tags: ['nonexistent-tag'], query: 'decision authority' });
    expect(out.results).toEqual([]);
  }, 120000);

  it('behaves exactly as before with no query', async () => {
    const out = await call('memory_search', { tags: ['test'] });
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r).not.toHaveProperty('vectorScore');
      expect(r).not.toHaveProperty('excerpt');
    }
  });

  it('degrades to keyword-only and says so when the embedder fails', async () => {
    // The spec promises a worse answer rather than a failed one. Replace the
    // embedding library in the spawned process so embedQuery throws.
    const breaker = pathToFileURL(join(__dirname, 'helpers', 'break-embedder.mjs')).href;
    const bad = spawn(process.execPath, ['--import', breaker, join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT + 1), VALKEY_URL: VALKEY },
      stdio: 'pipe',
    });
    bad.stdout.on('data', () => {}); bad.stderr.on('data', () => {});
    try {
      await waitForHealth(PORT + 1);
      const c2 = new Client({ name: 'degraded', version: '1.0.0' });
      await c2.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT + 1}/mcp`)));
      const raw = await c2.callTool({ name: 'memory_search', arguments: { query: 'decision authority', limit: 5 } });
      const out = JSON.parse(raw.content[0].text);
      expect(out.degraded).toMatch(/semantic search unavailable/);
      // Keyword still works: the entry whose title contains the phrase is found.
      expect(out.results.some((r) => r.id === 'authority')).toBe(true);
      await c2.close?.();
    } finally {
      await terminateChild(bad);
    }
  }, 120000);

  it('re-indexes when an entry body changes', async () => {
    await call('memory_set', {
      id: 'mutable', title: 'M', body: 'the camper trailer needs new tyres',
      type: 'reference', tags: ['test'],
    });
    const before = await call('memory_search', { query: 'vehicle wheels need replacing', limit: 10 });
    expect(before.results.some((r) => r.id === 'mutable')).toBe(true);

    await call('memory_set', {
      id: 'mutable', title: 'M', body: 'postgres connection pooling settings',
      type: 'reference', tags: ['test'],
    });
    const after = await call('memory_search', { query: 'database pool configuration', limit: 10 });
    const hit = after.results.find((r) => r.id === 'mutable');
    expect(hit).toBeDefined();
    expect(hit.excerpt).toContain('postgres');
  }, 120000);

  it('serves a store where only some entries have vectors', async () => {
    // The live store is full of entries written before this feature existed.
    // Write one the way the Lua script does, with no chunks behind it, and
    // check a search over the mixed store neither throws nor loses anything.
    const now = new Date().toISOString();
    await redis.hset('mem:legacy-no-vectors', {
      title: 'Legacy uncompacted entry',
      body: 'kubernetes ingress annotations for the homelab',
      type: 'reference', tags: 'legacy', source: 'test', project: '',
      created: now, updated: now, hits: '0', ttl: '',
    });
    await redis.sadd('tag:legacy', 'mem:legacy-no-vectors');
    await redis.sadd('type:reference', 'mem:legacy-no-vectors');
    await redis.sadd('project:', 'mem:legacy-no-vectors');
    expect(await redis.exists('memchunks:legacy-no-vectors')).toBe(0);

    // Reachable by keyword, exactly as it was before query became a score.
    const kw = await call('memory_search', { query: 'kubernetes ingress annotations', limit: 20 });
    const hit = kw.results.find((r) => r.id === 'legacy-no-vectors');
    expect(hit).toBeDefined();
    expect(hit.vectorScore).toBe(0);
    expect(hit.textScore).toBeGreaterThan(0);
    expect(hit).not.toHaveProperty('excerpt');

    // Reachable with no query at all, alongside the indexed entries.
    const listed = await call('memory_search', { limit: 50 });
    expect(listed.results.some((r) => r.id === 'legacy-no-vectors')).toBe(true);
    expect(listed.results.some((r) => r.id === 'authority')).toBe(true);

    // And an un-indexed entry in the store does not break scoring for the rest.
    const mixed = await call('memory_search', { query: 'who decides if I am not sure I should proceed', limit: 20 });
    expect(mixed.degraded).toBeUndefined();
    expect(mixed.results.some((r) => r.id === 'authority')).toBe(true);
  }, 120000);

  it('orders a queried search by relevance, not by hits', async () => {
    await call('memory_set', {
      id: 'ranking-relevant', title: 'Rolling back a bad deployment',
      body: 'When a release goes wrong in production, revert to the previous version and drain traffic away from the new pods.',
      type: 'pattern', tags: ['ranking'],
    });
    await call('memory_set', {
      id: 'ranking-popular', title: 'Sourdough starter feeding schedule',
      body: 'Feed the starter equal parts flour and water each morning, and discard half of it before it doubles.',
      type: 'pattern', tags: ['ranking'],
    });
    // hits move only through memory_get, so this is the only way to build the
    // entry the old hits sort would have put first.
    for (let i = 0; i < 5; i += 1) await call('memory_get', { id: 'ranking-popular' });

    const out = await call('memory_search', {
      tags: ['ranking'], query: 'how do I undo a broken production release', limit: 10,
    });
    expect(out.results).toHaveLength(2);
    const [first, second] = out.results;
    // The fixture only proves anything if the two orderings genuinely disagree:
    // the entry that must come first is the one with fewer hits.
    expect(first.hits).toBe(0);
    expect(second.hits).toBeGreaterThan(first.hits);
    expect(first.id).toBe('ranking-relevant');
    expect(second.id).toBe('ranking-popular');
    expect(first.score).toBeGreaterThan(second.score);
    expect(first.vectorScore).toBeGreaterThan(second.vectorScore);
  }, 120000);

  it('re-indexes after a rollback so search cannot quote the abandoned body', async () => {
    await call('memory_set', {
      id: 'rolled', title: 'Api notes', body: 'postgres connection pooling settings for the api',
      type: 'reference', tags: ['rollback'],
    });
    await call('memory_set', {
      id: 'rolled', title: 'Api notes', body: 'nginx reverse proxy timeouts for the api',
      type: 'reference', tags: ['rollback'],
    });

    const history = await call('memory_history', { id: 'rolled', limit: 10 });
    const index = history.versions.findIndex((v) => (v.body || '').includes('postgres'));
    expect(index).toBeGreaterThanOrEqual(0);
    const rollback = await call('memory_rollback', { id: 'rolled', version_index: index });
    expect(rollback.ok).toBe(true);

    // Findable by the body it now has, quoting the body it now has.
    const fresh = await call('memory_search', { query: 'database connection pool tuning', limit: 20 });
    const freshHit = fresh.results.find((r) => r.id === 'rolled');
    expect(freshHit).toBeDefined();
    expect(freshHit.excerpt).toContain('postgres');

    // And never quoting the body the rollback abandoned.
    const stale = await call('memory_search', { query: 'nginx reverse proxy timeouts', limit: 20 });
    const staleHit = stale.results.find((r) => r.id === 'rolled');
    expect(staleHit?.excerpt || '').not.toContain('nginx');

    // Nothing in the store still holds the abandoned text either.
    const chunkKeys = await redis.smembers('memchunks:rolled');
    expect(chunkKeys.length).toBeGreaterThan(0);
    for (const key of chunkKeys) {
      expect(await redis.hget(key, 'text')).not.toContain('nginx');
    }
  }, 120000);

  it('drops the previous vectors when an update cannot be embedded', async () => {
    // Write the first body through the healthy server, so the entry really is
    // indexed before anything goes wrong.
    await call('memory_set', {
      id: 'stale-vectors', title: 'Trailer notes',
      body: 'the camper trailer needs new tyres before the desert crossing',
      type: 'reference', tags: ['stale'],
    });
    expect((await redis.smembers('memchunks:stale-vectors')).length).toBeGreaterThan(0);

    // Update the same entry through a server whose embedding model is gone.
    // The write must still land, and the vectors for the body it just
    // abandoned must not survive it.
    const breaker = pathToFileURL(join(__dirname, 'helpers', 'break-embedder.mjs')).href;
    const bad = spawn(process.execPath, ['--import', breaker, join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT + 2), VALKEY_URL: VALKEY },
      stdio: 'pipe',
    });
    bad.stdout.on('data', () => {}); bad.stderr.on('data', () => {});
    try {
      await waitForHealth(PORT + 2);
      const c3 = new Client({ name: 'broken-writer', version: '1.0.0' });
      await c3.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT + 2}/mcp`)));
      const raw = await c3.callTool({
        name: 'memory_set',
        arguments: {
          id: 'stale-vectors', title: 'Trailer notes',
          body: 'postgres connection pooling settings for the api',
          type: 'reference', tags: ['stale'],
        },
      });
      expect(JSON.parse(raw.content[0].text).ok).toBe(true);
      await c3.close?.();
    } finally {
      await terminateChild(bad);
    }

    // Nothing in the store still holds a vector for the abandoned body, and
    // the entry is queued for repair.
    expect(await redis.keys('memchunk:stale-vectors:*')).toEqual([]);
    expect(await redis.exists('memchunks:stale-vectors')).toBe(0);
    expect(await redis.sismember('memdirty', 'stale-vectors')).toBe(1);

    // So a healthy server can neither rank it on, nor quote, text it no
    // longer has.
    const stale = await call('memory_search', { query: 'vehicle wheels need replacing', limit: 20 });
    const staleHit = stale.results.find((r) => r.id === 'stale-vectors');
    expect(staleHit?.excerpt || '').not.toContain('tyres');
    expect(staleHit?.vectorScore || 0).toBe(0);

    // Temporarily unfindable by vector is the trade. The entry stays reachable
    // by keyword on the body it actually has.
    const kw = await call('memory_search', { query: 'postgres connection pooling settings', limit: 20 });
    const hit = kw.results.find((r) => r.id === 'stale-vectors');
    expect(hit).toBeDefined();
    expect(hit.textScore).toBeGreaterThan(0);
  }, 120000);

  it('re-indexes after a rollback at the remaining ttl, not the configured one', async () => {
    await call('memory_set', {
      id: 'ttl-rolled', title: 'Ttl notes', body: 'first body about valkey eviction policies',
      type: 'reference', tags: ['ttl'], ttl: 600,
    });
    await call('memory_set', {
      id: 'ttl-rolled', title: 'Ttl notes', body: 'second body about disk snapshot scheduling',
      type: 'reference', tags: ['ttl'], ttl: 600,
    });

    // Shorten the live expiry without touching the `ttl` field, which records
    // the configured lifetime and never counts down. Every entry drifts into
    // this state as its life elapses; the gap is just exaggerated here so the
    // two readings cannot be mistaken for each other.
    await redis.expire('mem:ttl-rolled', 30);
    expect(await redis.hget('mem:ttl-rolled', 'ttl')).toBe('600');

    const history = await call('memory_history', { id: 'ttl-rolled', limit: 10 });
    const index = history.versions.findIndex((v) => (v.body || '').includes('eviction'));
    expect(index).toBeGreaterThanOrEqual(0);
    expect((await call('memory_rollback', { id: 'ttl-rolled', version_index: index })).ok).toBe(true);

    // Chunks must not outlive the entry they describe.
    const keys = await redis.smembers('memchunks:ttl-rolled');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of [...keys, 'memchunks:ttl-rolled']) {
      const remaining = await redis.ttl(key);
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(30);
    }
  }, 120000);

  it('leaves no chunk keys behind when an entry is deleted', async () => {
    await call('memory_set', {
      id: 'deletable', title: 'Temporary', body: 'a body long enough to produce at least one chunk vector',
      type: 'reference', tags: ['deletable'],
    });
    expect((await redis.smembers('memchunks:deletable')).length).toBeGreaterThan(0);

    const out = await call('memory_delete', { id: 'deletable' });
    expect(out.ok).toBe(true);

    expect(await redis.keys('memchunk:deletable:*')).toEqual([]);
    expect(await redis.exists('memchunks:deletable')).toBe(0);
  }, 120000);
});
