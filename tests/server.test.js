import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Redis from 'ioredis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.js');
const VALKEY_URL = process.env.VALKEY_URL || 'redis://127.0.0.1:6379';

// ============================================================================
// HELPERS
// ============================================================================

async function waitReady(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${base} did not become ready within ${timeoutMs}ms`);
}

function spawnServer(port, env = {}) {
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      VALKEY_URL,
      ...env,
    },
    stdio: 'pipe',
  });
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});
  return proc;
}

async function client(port = 3107) {
  const c = new Client({ name: 'test', version: '1.0.0' });
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await c.connect(t);
  return c;
}

async function call(c, name, args = {}) {
  const result = await c.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
}

function uid() {
  return 'test-' + Math.random().toString(36).slice(2);
}

// ============================================================================
// MAIN SERVER TESTS (port 3107, no auth)
// ============================================================================

describe('memory-mcp server', () => {
  let proc;
  const BASE = 'http://127.0.0.1:3107';

  beforeAll(async () => {
    proc = spawnServer(3107);
    await waitReady(BASE);
  });

  afterAll(async () => {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.on('exit', r));
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  it('GET /health returns { ok: true }', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  // --------------------------------------------------------------------------
  // memory_set — create
  // --------------------------------------------------------------------------

  it('memory_set creates a new entry', async () => {
    const c = await client();
    const id = uid();
    const result = await call(c, 'memory_set', {
      id,
      title: 'Test entry',
      body: 'Test body content',
      type: 'reference',
      tags: ['test', 'vitest'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });
    await c.close();

    expect(result.ok).toBe(true);
    expect(result.id).toBe(id);
    expect(result.operation).toBe('created');
  });

  // --------------------------------------------------------------------------
  // memory_set — update
  // --------------------------------------------------------------------------

  it('memory_set updates an existing entry', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Original title',
      body: 'Original body',
      type: 'pattern',
      tags: ['test'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const result = await call(c, 'memory_set', {
      id,
      title: 'Updated title',
      body: 'Updated body',
      type: 'pattern',
      tags: ['test', 'updated'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });
    await c.close();

    expect(result.ok).toBe(true);
    expect(result.id).toBe(id);
    expect(result.operation).toBe('modified');
  });

  // --------------------------------------------------------------------------
  // memory_get
  // --------------------------------------------------------------------------

  it('memory_get returns correct fields including tags array and increments hits', async () => {
    const c = await client();
    const id = uid();
    const tags = ['get-test', 'vitest'];

    await call(c, 'memory_set', {
      id,
      title: 'Get test entry',
      body: 'Body for get test',
      type: 'decision',
      tags,
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const first = await call(c, 'memory_get', { id });
    expect(first.id).toBe(id);
    expect(first.title).toBe('Get test entry');
    expect(first.body).toBe('Body for get test');
    expect(first.type).toBe('decision');
    expect(Array.isArray(first.tags)).toBe(true);
    expect(first.hits).toBe(1);

    const second = await call(c, 'memory_get', { id });
    expect(second.hits).toBe(2);
    await c.close();
  });

  // --------------------------------------------------------------------------
  // memory_search — by tag intersection
  // --------------------------------------------------------------------------

  it('memory_search by tag returns matching entries', async () => {
    const c = await client();
    const tag = uid();
    const id1 = uid();
    const id2 = uid();
    const idOther = uid();

    await call(c, 'memory_set', {
      id: id1,
      title: 'Tagged entry 1',
      body: 'body',
      type: 'reference',
      tags: [tag, 'extra'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });
    await call(c, 'memory_set', {
      id: id2,
      title: 'Tagged entry 2',
      body: 'body',
      type: 'reference',
      tags: [tag],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });
    await call(c, 'memory_set', {
      id: idOther,
      title: 'Unrelated entry',
      body: 'body',
      type: 'reference',
      tags: ['other-tag'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const result = await call(c, 'memory_search', { tags: [tag] });
    await c.close();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).not.toContain(idOther);
  });

  // --------------------------------------------------------------------------
  // memory_search — by type
  // --------------------------------------------------------------------------

  it('memory_search by type returns only matching type', async () => {
    const c = await client();
    const uniqueType = 'incident'; // use a deterministic type that is testable
    const id = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Incident entry',
      body: 'body',
      type: uniqueType,
      tags: [uid()], // unique tag to not pollute
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const result = await call(c, 'memory_search', { type: uniqueType, limit: 100 });
    await c.close();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(id);
    result.results.forEach((r) => expect(r.type).toBe(uniqueType));
  });

  // --------------------------------------------------------------------------
  // memory_search — by project
  // --------------------------------------------------------------------------

  it('memory_search by project returns only matching project', async () => {
    const c = await client();
    const project = 'proj-' + uid();
    const id = uid();
    const idOther = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Project entry',
      body: 'body',
      type: 'reference',
      tags: [uid()],
      source: 'test-suite',
      project,
    });
    await call(c, 'memory_set', {
      id: idOther,
      title: 'Other project entry',
      body: 'body',
      type: 'reference',
      tags: [uid()],
      source: 'test-suite',
      project: 'other-project-' + uid(),
    });

    const result = await call(c, 'memory_search', { project });
    await c.close();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(id);
    expect(ids).not.toContain(idOther);
  });

  // --------------------------------------------------------------------------
  // memory_search — by empty project (cross-project)
  // --------------------------------------------------------------------------

  it('memory_search by project "" returns cross-project entries', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Cross-project entry',
      body: 'body',
      type: 'pattern',
      tags: [uid()],
      source: 'test-suite',
      project: '',
    });

    const result = await call(c, 'memory_search', { project: '' });
    await c.close();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(id);
  });

  // --------------------------------------------------------------------------
  // memory_search — by text query
  // --------------------------------------------------------------------------

  it('memory_search by text query matches title and body', async () => {
    const c = await client();
    const needle = 'uniquestring' + uid();
    const id = uid();

    await call(c, 'memory_set', {
      id,
      title: `Entry with ${needle} in title`,
      body: 'plain body',
      type: 'reference',
      tags: [uid()],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const result = await call(c, 'memory_search', { query: needle });
    await c.close();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(id);
  });

  // --------------------------------------------------------------------------
  // memory_delete
  // --------------------------------------------------------------------------

  it('memory_delete removes entry and cleans up tag index', async () => {
    const c = await client();
    const id = uid();
    const tag = uid();

    await call(c, 'memory_set', {
      id,
      title: 'To be deleted',
      body: 'body',
      type: 'reference',
      tags: [tag],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const del = await call(c, 'memory_delete', { id });
    expect(del.ok).toBe(true);
    expect(del.operation).toBe('deleted');

    // Entry should not be retrievable
    const get = await call(c, 'memory_get', { id });
    expect(get.error).toMatch(/Not found/);

    // Tag index should not contain the deleted entry
    const search = await call(c, 'memory_search', { tags: [tag] });
    const ids = search.results.map((r) => r.id);
    expect(ids).not.toContain(id);

    await c.close();
  });

  // --------------------------------------------------------------------------
  // memory_history
  // --------------------------------------------------------------------------

  it('memory_history records versions in order (newest first)', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Version 1',
      body: 'body v1',
      type: 'pattern',
      tags: ['hist-test'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    await call(c, 'memory_set', {
      id,
      title: 'Version 2',
      body: 'body v2',
      type: 'pattern',
      tags: ['hist-test'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const history = await call(c, 'memory_history', { id });
    await c.close();

    expect(history.count).toBeGreaterThanOrEqual(2);
    // Newest first — index 0 should be the modified operation
    expect(history.versions[0].operation).toBe('modified');
    expect(history.versions[1].operation).toBe('created');
  });

  // --------------------------------------------------------------------------
  // memory_rollback
  // --------------------------------------------------------------------------

  it('memory_rollback restores a previous version', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Original',
      body: 'original body',
      type: 'pattern',
      tags: ['rollback-test'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    await call(c, 'memory_set', {
      id,
      title: 'Modified',
      body: 'modified body',
      type: 'pattern',
      tags: ['rollback-test'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    // Version index 1 is the 'created' snapshot (original)
    const rollback = await call(c, 'memory_rollback', { id, version_index: 1 });
    expect(rollback.ok).toBe(true);
    expect(rollback.operation).toBe('rollback_to_1');

    const after = await call(c, 'memory_get', { id });
    expect(after.title).toBe('Original');
    expect(after.body).toBe('original body');

    await c.close();
  });

  // --------------------------------------------------------------------------
  // memory_search — body preview
  // --------------------------------------------------------------------------

  it('memory_search returns body_preview by default and full body on request', async () => {
    const c = await client();
    const id = uid();
    const tag = uid();
    const longBody = 'x'.repeat(500);

    await call(c, 'memory_set', {
      id,
      title: 'Preview test entry',
      body: longBody,
      type: 'reference',
      tags: [tag],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const preview = await call(c, 'memory_search', { tags: [tag] });
    const entry = preview.results.find((r) => r.id === id);
    expect(entry.body).toBeUndefined();
    expect(entry.body_preview).toBe('x'.repeat(300));
    expect(entry.truncated).toBe(true);

    const full = await call(c, 'memory_search', { tags: [tag], full: true });
    const fullEntry = full.results.find((r) => r.id === id);
    expect(fullEntry.body).toBe(longBody);
    expect(fullEntry.body_preview).toBeUndefined();

    await c.close();
  });

  it('memory_search short bodies are not marked truncated', async () => {
    const c = await client();
    const id = uid();
    const tag = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Short body entry',
      body: 'short body',
      type: 'reference',
      tags: [tag],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const result = await call(c, 'memory_search', { tags: [tag] });
    const entry = result.results.find((r) => r.id === id);
    expect(entry.body_preview).toBe('short body');
    expect(entry.truncated).toBe(false);

    await c.close();
  });

  // --------------------------------------------------------------------------
  // memory_search — hit counting
  // --------------------------------------------------------------------------

  it('memory_search increments hit counters of returned entries', async () => {
    const c = await client();
    const id = uid();
    const tag = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Hit count entry',
      body: 'body',
      type: 'reference',
      tags: [tag],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const first = await call(c, 'memory_search', { tags: [tag] });
    expect(first.results.find((r) => r.id === id).hits).toBe(1);

    const second = await call(c, 'memory_search', { tags: [tag] });
    expect(second.results.find((r) => r.id === id).hits).toBe(2);

    // memory_get sees the search-accumulated hits and adds its own
    const got = await call(c, 'memory_get', { id });
    expect(got.hits).toBe(3);

    await c.close();
  });

  it('memory_search does not increment hits of entries beyond the limit', async () => {
    const c = await client();
    const tag = uid();
    const idA = uid();
    const idB = uid();

    for (const [id, title] of [[idA, 'A'], [idB, 'B']]) {
      await call(c, 'memory_set', {
        id,
        title,
        body: 'body',
        type: 'reference',
        tags: [tag],
        source: 'test-suite',
        project: 'memory-mcp-test',
      });
    }

    // limit 1 returns one entry; the other must keep hits at 0
    const result = await call(c, 'memory_search', { tags: [tag], limit: 1 });
    expect(result.results.length).toBe(1);
    const returnedId = result.results[0].id;
    const otherId = returnedId === idA ? idB : idA;

    const other = await call(c, 'memory_get', { id: otherId });
    expect(other.hits).toBe(1); // 0 from search + 1 from this get

    await c.close();
  });

  // --------------------------------------------------------------------------
  // timestamps
  // --------------------------------------------------------------------------

  it('entries and versions carry full ISO timestamps', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Timestamp entry',
      body: 'body',
      type: 'reference',
      tags: [uid()],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });

    const entry = await call(c, 'memory_get', { id });
    expect(entry.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(entry.updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const history = await call(c, 'memory_history', { id });
    expect(history.versions[0].updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await c.close();
  });

  // --------------------------------------------------------------------------
  // version dedupe
  // --------------------------------------------------------------------------

  it('re-saving identical content does not add a version; changed content does', async () => {
    const c = await client();
    const id = uid();
    const entry = {
      id,
      title: 'Dedupe entry',
      body: 'same body',
      type: 'pattern',
      tags: ['dedupe-test'],
      source: 'test-suite',
      project: 'memory-mcp-test',
    };

    await call(c, 'memory_set', entry);
    await call(c, 'memory_set', entry); // identical re-save

    let history = await call(c, 'memory_history', { id });
    expect(history.count).toBe(1);
    expect(history.versions[0].operation).toBe('created');

    await call(c, 'memory_set', { ...entry, body: 'different body' });
    history = await call(c, 'memory_history', { id });
    expect(history.count).toBe(2);
    expect(history.versions[0].operation).toBe('modified');

    await c.close();
  });

  // --------------------------------------------------------------------------
  // memory_list — body preview
  // --------------------------------------------------------------------------

  it('memory_list returns body_preview by default and full body on request', async () => {
    const c = await client();
    const id = uid();
    const project = 'proj-' + uid();

    await call(c, 'memory_set', {
      id,
      title: 'List preview entry',
      body: 'y'.repeat(500),
      type: 'reference',
      tags: [uid()],
      source: 'test-suite',
      project,
    });

    const preview = await call(c, 'memory_list', { project });
    expect(preview.results[0].body).toBeUndefined();
    expect(preview.results[0].body_preview).toBe('y'.repeat(300));

    const full = await call(c, 'memory_list', { project, full: true });
    expect(full.results[0].body).toBe('y'.repeat(500));

    await c.close();
  });
});

// ============================================================================
// TTL CLEANUP + SOFT CAP TESTS (port 3109, fast sweep, warn cap 0)
// ============================================================================

describe('memory-mcp ttl cleanup and soft cap', () => {
  let proc;
  let redis;
  const BASE = 'http://127.0.0.1:3109';

  beforeAll(async () => {
    proc = spawnServer(3109, { SWEEP_INTERVAL_SECONDS: '1', MAX_ENTRIES_WARN: '0' });
    redis = new Redis(VALKEY_URL);
    await waitReady(BASE);
  });

  afterAll(async () => {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.on('exit', r));
    redis.disconnect();
  });

  it('memory_set warns when entry count exceeds the soft cap', async () => {
    const c = await client(3109);
    const result = await call(c, 'memory_set', {
      id: uid(),
      title: 'Cap test entry',
      body: 'body',
      type: 'reference',
      tags: [uid()],
      source: 'test-suite',
      project: 'memory-mcp-test',
    });
    await c.close();

    expect(result.warning).toMatch(/soft cap/);
  });

  it('TTL expiry removes version history and index members', async () => {
    const c = await client(3109);
    const id = uid();
    const tag = uid();

    await call(c, 'memory_set', {
      id,
      title: 'Ephemeral entry',
      body: 'body',
      type: 'state',
      tags: [tag],
      source: 'test-suite',
      project: 'memory-mcp-test',
      ttl: 1,
    });

    // Entry, version history, and index member all exist while alive
    expect(await redis.exists(`mem:${id}`)).toBe(1);
    expect(await redis.exists(`memver:${id}`)).toBe(1);
    expect(await redis.sismember(`tag:${tag}`, `mem:${id}`)).toBe(1);

    // Wait past the 1s TTL plus a sweep cycle
    await new Promise((r) => setTimeout(r, 3000));

    expect(await redis.exists(`mem:${id}`)).toBe(0);
    expect(await redis.exists(`memver:${id}`)).toBe(0);
    expect(await redis.sismember(`tag:${tag}`, `mem:${id}`)).toBe(0);

    await c.close();
  });
});

// ============================================================================
// AUTH SERVER TESTS (port 3108, AUTH_TOKEN=test-secret)
// ============================================================================

describe('memory-mcp auth', () => {
  let proc;
  const BASE = 'http://127.0.0.1:3108';

  beforeAll(async () => {
    proc = spawnServer(3108, { AUTH_TOKEN: 'test-secret' });
    await waitReady(BASE);
  });

  afterAll(async () => {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.on('exit', r));
  });

  it('POST /mcp without token returns 401', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('POST /mcp with valid Bearer token succeeds', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer test-secret',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    // Auth passed — server processed the request (not 401)
    expect(res.status).not.toBe(401);
  });
});
