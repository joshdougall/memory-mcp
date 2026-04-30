import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
