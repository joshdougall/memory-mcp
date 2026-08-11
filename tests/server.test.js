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

// Direct Valkey access, for asserting raw keys the MCP API does not expose.
function rawClient() {
  return new Redis(VALKEY_URL, { lazyConnect: false });
}

// Scrape a single unlabelled counter/gauge value from /metrics.
async function metric(base, name) {
  const res = await fetch(`${base}/metrics`);
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? parseFloat(line.split(' ')[1]) : 0;
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
  // revision counter
  // --------------------------------------------------------------------------

  it('memory_set starts revision at 1 and increments once per write', async () => {
    const c = await client();
    const id = uid();

    const created = await call(c, 'memory_set', {
      id, title: 'Rev 1', body: 'b', type: 'pattern',
      tags: ['rev-test'], source: 'test-suite', project: 'memory-mcp-test',
    });
    expect(created.ok).toBe(true);
    expect(created.revision).toBe(1);

    const modified = await call(c, 'memory_set', {
      id, title: 'Rev 2', body: 'b', type: 'pattern',
      tags: ['rev-test'], source: 'test-suite', project: 'memory-mcp-test',
    });
    expect(modified.ok).toBe(true);
    expect(modified.revision).toBe(2);

    await c.close();
  });

  it('memory_get returns revision and does not move it despite counting hits', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Get rev', body: 'b', type: 'pattern',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
    });

    const first = await call(c, 'memory_get', { id });
    expect(first.revision).toBe(1);
    expect(first.hits).toBe(1);

    const second = await call(c, 'memory_get', { id });
    expect(second.revision).toBe(1);
    expect(second.hits).toBe(2);

    await c.close();
  });

  it('version snapshots record the revision they were written at', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Snap 1', body: 'b1', type: 'pattern',
      tags: ['snap'], source: 'test-suite', project: 'memory-mcp-test',
    });
    await call(c, 'memory_set', {
      id, title: 'Snap 2', body: 'b2', type: 'pattern',
      tags: ['snap'], source: 'test-suite', project: 'memory-mcp-test',
    });

    const history = await call(c, 'memory_history', { id });
    await c.close();

    expect(history.versions[0].rev).toBe(2);
    expect(history.versions[1].rev).toBe(1);
  });

  it('memory_set preserves created date, tags array and index membership across updates', async () => {
    const c = await client();
    const id = uid();
    const oldTag = uid();
    const newTag = uid();

    await call(c, 'memory_set', {
      id, title: 'Indexed', body: 'b', type: 'pattern',
      tags: [oldTag], source: 'test-suite', project: 'memory-mcp-test',
    });
    const before = await call(c, 'memory_get', { id });

    await call(c, 'memory_set', {
      id, title: 'Reindexed', body: 'b', type: 'decision',
      tags: [newTag], source: 'test-suite', project: 'memory-mcp-test',
    });
    const after = await call(c, 'memory_get', { id });

    // created date carries over, tags round-trip as an array
    expect(after.created).toBe(before.created);
    expect(after.tags).toEqual([newTag]);

    // old tag index no longer points at the entry, new one does
    const oldSearch = await call(c, 'memory_search', { tags: [oldTag] });
    expect(oldSearch.results.map((r) => r.id)).not.toContain(id);
    const newSearch = await call(c, 'memory_search', { tags: [newTag] });
    expect(newSearch.results.map((r) => r.id)).toContain(id);

    await c.close();
  });

  it('memory_set with a ttl sets an expiry, and a later write without one clears it', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Expiring', body: 'b', type: 'state',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test', ttl: 600,
    });
    expect(await raw.ttl(`mem:${id}`)).toBeGreaterThan(0);

    await call(c, 'memory_set', {
      id, title: 'Permanent', body: 'b', type: 'state',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
    });
    expect(await raw.ttl(`mem:${id}`)).toBe(-1);

    await raw.quit();
    await c.close();
  });

  // --------------------------------------------------------------------------
  // if_version
  // --------------------------------------------------------------------------

  it('if_version applies the write when it matches the current revision', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'v1', body: 'b1', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
    });

    const result = await call(c, 'memory_set', {
      id, title: 'v2', body: 'b2', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(2);

    const after = await call(c, 'memory_get', { id });
    expect(after.body).toBe('b2');

    await c.close();
  });

  it('if_version returns a conflict and writes nothing when it does not match', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'v1', body: 'original', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
    });

    const result = await call(c, 'memory_set', {
      id, title: 'stale', body: 'should not land', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 99,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('conflict');
    expect(result.id).toBe(id);
    expect(result.current_revision).toBe(1);
    expect(result.expected_version).toBe(99);

    const after = await call(c, 'memory_get', { id });
    expect(after.body).toBe('original');
    expect(after.revision).toBe(1);

    await c.close();
  });

  it('if_version 0 creates when absent and conflicts when already versioned', async () => {
    const c = await client();
    const id = uid();

    const created = await call(c, 'memory_set', {
      id, title: 'fresh', body: 'b', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(created.ok).toBe(true);
    expect(created.operation).toBe('created');
    expect(created.revision).toBe(1);

    const again = await call(c, 'memory_set', {
      id, title: 'duplicate', body: 'b', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(again.ok).toBe(false);
    expect(again.error).toBe('conflict');
    expect(again.current_revision).toBe(1);

    await c.close();
  });

  it('if_version 0 upgrades a legacy entry that has no revision counter', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();

    // Seed an entry the way a pre-1.1.0 server would have: hash only, no memrev key.
    await raw.hset(`mem:${id}`, {
      title: 'Legacy entry',
      body: 'written by an older server',
      type: 'reference',
      tags: 'legacy',
      source: 'test-suite',
      project: 'memory-mcp-test',
      created: '2026-01-01',
      updated: '2026-01-01',
      hits: '7',
    });
    expect(await raw.exists(`memrev:${id}`)).toBe(0);

    const upgraded = await call(c, 'memory_set', {
      id, title: 'Upgraded', body: 'now versioned', type: 'reference',
      tags: ['legacy'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(upgraded.ok).toBe(true);
    expect(upgraded.operation).toBe('modified');
    expect(upgraded.revision).toBe(1);

    // A second if_version 0 now conflicts: the entry is versioned.
    const second = await call(c, 'memory_set', {
      id, title: 'again', body: 'b', type: 'reference',
      tags: ['legacy'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('conflict');

    await raw.quit();
    await c.close();
  });

  // --------------------------------------------------------------------------
  // operation_id
  // --------------------------------------------------------------------------

  it('replaying an operation_id returns the prior result and writes nothing', async () => {
    const c = await client();
    const id = uid();
    const opId = 'op-' + uid();

    const first = await call(c, 'memory_set', {
      id, title: 'once', body: 'first body', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });
    expect(first.ok).toBe(true);
    expect(first.revision).toBe(1);
    expect(first.replayed).toBeUndefined();

    // Same operation_id, different content: must be a no-op returning the first outcome.
    const replay = await call(c, 'memory_set', {
      id, title: 'twice', body: 'second body', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.revision).toBe(1);
    expect(replay.operation).toBe('created');

    // Nothing moved: body unchanged, revision unchanged, no second version.
    const after = await call(c, 'memory_get', { id });
    expect(after.body).toBe('first body');
    expect(after.revision).toBe(1);

    const history = await call(c, 'memory_history', { id });
    expect(history.count).toBe(1);

    await c.close();
  });

  it('a replay wins over a stale if_version rather than conflicting', async () => {
    const c = await client();
    const id = uid();
    const opId = 'op-' + uid();

    await call(c, 'memory_set', {
      id, title: 'v1', body: 'b', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
    });

    // A conditional write that succeeds, carrying an operation_id.
    const applied = await call(c, 'memory_set', {
      id, title: 'v2', body: 'b2', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 1, operation_id: opId,
    });
    expect(applied.ok).toBe(true);
    expect(applied.revision).toBe(2);

    // The client never saw the ack and retries verbatim. if_version 1 is now
    // stale, but the recorded operation_id must short-circuit ahead of the CAS.
    const retry = await call(c, 'memory_set', {
      id, title: 'v2', body: 'b2', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 1, operation_id: opId,
    });
    expect(retry.ok).toBe(true);
    expect(retry.replayed).toBe(true);
    expect(retry.revision).toBe(2);

    await c.close();
  });

  it('operation_id records expire after the retention window', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();
    const opId = 'op-' + uid();

    await call(c, 'memory_set', {
      id, title: 'ttl check', body: 'b', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });

    const ttl = await raw.ttl(`memop:${opId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60);

    const recorded = await raw.hgetall(`memop:${opId}`);
    expect(recorded.memory_id).toBe(id);
    expect(recorded.revision).toBe('1');
    expect(recorded.action).toBe('created');

    await raw.quit();
    await c.close();
  });

  // --------------------------------------------------------------------------
  // revision movement on delete and rollback
  // --------------------------------------------------------------------------

  it('memory_rollback moves the revision', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Original', body: 'original body', type: 'pattern',
      tags: ['rb-rev'], source: 'test-suite', project: 'memory-mcp-test',
    });
    await call(c, 'memory_set', {
      id, title: 'Modified', body: 'modified body', type: 'pattern',
      tags: ['rb-rev'], source: 'test-suite', project: 'memory-mcp-test',
    });

    const rollback = await call(c, 'memory_rollback', { id, version_index: 1 });
    expect(rollback.ok).toBe(true);
    expect(rollback.revision).toBe(3);

    const after = await call(c, 'memory_get', { id });
    expect(after.body).toBe('original body');
    expect(after.revision).toBe(3);

    await c.close();
  });

  it('memory_delete moves the revision and the tombstone carries it', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Doomed', body: 'b', type: 'pattern',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
    });

    const del = await call(c, 'memory_delete', { id });
    expect(del.ok).toBe(true);
    expect(del.revision).toBe(2);

    const history = await call(c, 'memory_history', { id });
    expect(history.versions[0].operation).toBe('deleted');
    expect(history.versions[0].rev).toBe(2);

    await c.close();
  });

  it('delete then re-create continues the revision sequence and rejects a stale if_version', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'First life', body: 'b', type: 'pattern',
      tags: ['aba'], source: 'test-suite', project: 'memory-mcp-test',
    });
    // A client reads revision 1 and holds it.
    const held = await call(c, 'memory_get', { id });
    expect(held.revision).toBe(1);

    await call(c, 'memory_delete', { id });

    // The stale expectation must not win: delete moved the revision to 2.
    const stale = await call(c, 'memory_set', {
      id, title: 'Resurrected by a stale writer', body: 'b', type: 'pattern',
      tags: ['aba'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 1,
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toBe('conflict');
    expect(stale.current_revision).toBe(2);

    // if_version 0 is also stale after a delete: the counter outlives the entry.
    const asNew = await call(c, 'memory_set', {
      id, title: 'Assumed new', body: 'b', type: 'pattern',
      tags: ['aba'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(asNew.ok).toBe(false);
    expect(asNew.error).toBe('conflict');
    expect(asNew.current_revision).toBe(2);

    // Retrying with the revision the conflict reported succeeds, and the
    // sequence continues rather than restarting at 1.
    const recreated = await call(c, 'memory_set', {
      id, title: 'Second life', body: 'b2', type: 'pattern',
      tags: ['aba'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 2,
    });
    expect(recreated.ok).toBe(true);
    expect(recreated.operation).toBe('created');
    expect(recreated.revision).toBe(3);

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
