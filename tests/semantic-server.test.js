import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import Redis from 'ioredis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
  proc?.kill('SIGTERM');
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
      bad.kill('SIGTERM');
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
});
