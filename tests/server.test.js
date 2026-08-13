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

  it('an entry with no tags round-trips as an empty array, not an object', async () => {
    // Regression guard. The version snapshot's tags array is encoded in JS and
    // passed into the Lua script pre-encoded, because cjson encodes an empty Lua
    // table as {} rather than []. Encoding it inside the script would silently
    // turn a tagless entry's history into an object.
    const c = await client();
    const id = uid();

    const created = await call(c, 'memory_set', {
      id, title: 'No tags', body: 'b', type: 'pattern',
      tags: [], source: 'test-suite', project: 'memory-mcp-test',
    });
    expect(created.ok).toBe(true);

    const got = await call(c, 'memory_get', { id });
    expect(Array.isArray(got.tags)).toBe(true);
    expect(got.tags).toEqual([]);

    const history = await call(c, 'memory_history', { id });
    expect(Array.isArray(history.versions[0].tags)).toBe(true);
    expect(history.versions[0].tags).toEqual([]);

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

  // --------------------------------------------------------------------------
  // conflict isolation
  // --------------------------------------------------------------------------

  it('a conflict touches nothing and is counted as a conflict, not a write', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();
    const tag = uid();

    await call(c, 'memory_set', {
      id, title: 'Untouchable', body: 'original', type: 'pattern',
      tags: [tag], source: 'test-suite', project: 'memory-mcp-test', ttl: 600,
    });
    await call(c, 'memory_get', { id }); // hits -> 1

    const before = {
      hash: await raw.hgetall(`mem:${id}`),
      versions: await raw.lrange(`memver:${id}`, 0, -1),
      tagMembers: await raw.smembers(`tag:${tag}`),
      typeMembers: await raw.smembers('type:pattern'),
      rev: await raw.get(`memrev:${id}`),
      ttl: await raw.ttl(`mem:${id}`),
      writes: await metric(BASE, 'memory_write_total'),
      conflicts: await metric(BASE, 'memory_conflict_total'),
    };

    const conflict = await call(c, 'memory_set', {
      id, title: 'Rejected', body: 'must not land', type: 'decision',
      tags: [uid()], source: 'test-suite', project: 'other-project',
      if_version: 42,
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toBe('conflict');

    const after = {
      hash: await raw.hgetall(`mem:${id}`),
      versions: await raw.lrange(`memver:${id}`, 0, -1),
      tagMembers: await raw.smembers(`tag:${tag}`),
      typeMembers: await raw.smembers('type:pattern'),
      rev: await raw.get(`memrev:${id}`),
      ttl: await raw.ttl(`mem:${id}`),
      writes: await metric(BASE, 'memory_write_total'),
      conflicts: await metric(BASE, 'memory_conflict_total'),
    };

    // No hash field moved, including hits.
    expect(after.hash).toEqual(before.hash);
    // No version pushed.
    expect(after.versions).toEqual(before.versions);
    // No index set touched.
    expect(after.tagMembers.sort()).toEqual(before.tagMembers.sort());
    expect(after.typeMembers.sort()).toEqual(before.typeMembers.sort());
    // Revision did not move.
    expect(after.rev).toBe(before.rev);
    // TTL was not refreshed or cleared.
    expect(after.ttl).toBeLessThanOrEqual(before.ttl);
    expect(after.ttl).toBeGreaterThan(0);
    // Counted as a conflict, not a write.
    expect(after.writes).toBe(before.writes);
    expect(after.conflicts).toBe(before.conflicts + 1);

    await raw.quit();
    await c.close();
  });

  // --------------------------------------------------------------------------
  // concurrency
  // --------------------------------------------------------------------------

  it('N concurrent writers holding the same revision produce exactly one winner', async () => {
    const setup = await client();
    const id = uid();
    await call(setup, 'memory_set', {
      id, title: 'Contended', body: 'base', type: 'pattern',
      tags: ['race'], source: 'test-suite', project: 'memory-mcp-test',
    });
    await setup.close();

    const WRITERS = 8;
    const clients = await Promise.all(
      Array.from({ length: WRITERS }, () => client())
    );

    const results = await Promise.all(
      clients.map((c, i) => call(c, 'memory_set', {
        id, title: `writer-${i}`, body: `body-${i}`, type: 'pattern',
        tags: ['race'], source: 'test-suite', project: 'memory-mcp-test',
        if_version: 1,
      }))
    );

    await Promise.all(clients.map((c) => c.close()));

    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(WRITERS - 1);
    expect(winners[0].revision).toBe(2);
    losers.forEach((l) => {
      expect(l.error).toBe('conflict');
      expect(l.expected_version).toBe(1);
      expect(l.current_revision).toBe(2);
    });

    // The stored entry is exactly one writer's, with no interleaved fields.
    const verify = await client();
    const final = await call(verify, 'memory_get', { id });
    await verify.close();

    expect(final.revision).toBe(2);
    // The stored title and body must come from the same writer. If the fields
    // interleaved, title would name one writer and body another.
    expect(final.title).toMatch(/^writer-\d+$/);
    const writerIndex = final.title.replace('writer-', '');
    expect(final.body).toBe(`body-${writerIndex}`);
  });

  it('concurrent unconditional writers leave no interleaved index state', async () => {
    // The previous test passes even if the requests happen to serialise. This one
    // does not: it targets the read-then-reindex sequence that the old pipeline
    // performed non-atomically. Each writer swaps the entry onto its own tag, so
    // afterwards exactly one tag set may contain the entry. A non-atomic path can
    // interleave an SREM of one writer's tag with another's SADD and strand the
    // entry in several tag sets at once.
    const WRITERS = 10;
    const id = uid();
    const tags = Array.from({ length: WRITERS }, () => uid());

    const setup = await client();
    await call(setup, 'memory_set', {
      id, title: 'Reindexed concurrently', body: 'base', type: 'pattern',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
    });
    await setup.close();

    const clients = await Promise.all(
      Array.from({ length: WRITERS }, () => client())
    );

    const results = await Promise.all(
      clients.map((c, i) => call(c, 'memory_set', {
        id, title: `writer-${i}`, body: `body-${i}`, type: 'pattern',
        tags: [tags[i]], source: 'test-suite', project: 'memory-mcp-test',
      }))
    );
    await Promise.all(clients.map((c) => c.close()));

    // Every write applied, and each got its own revision: no two writers can
    // observe the same counter value.
    results.forEach((r) => expect(r.ok).toBe(true));
    const revisions = results.map((r) => r.revision).sort((a, b) => a - b);
    expect(new Set(revisions).size).toBe(WRITERS);
    expect(revisions).toEqual(Array.from({ length: WRITERS }, (_, i) => i + 2));

    // Exactly one tag set still points at the entry.
    const raw = rawClient();
    const memberships = [];
    for (const tag of tags) {
      if (await raw.sismember(`tag:${tag}`, `mem:${id}`)) memberships.push(tag);
    }
    await raw.quit();

    expect(memberships).toHaveLength(1);

    // And it is the tag belonging to whichever writer landed last.
    const verify = await client();
    const final = await call(verify, 'memory_get', { id });
    await verify.close();

    expect(final.tags).toEqual(memberships);
    expect(final.revision).toBe(WRITERS + 1);
  });

  // --------------------------------------------------------------------------
  // lifecycle: memrev/memver share a TTL entry's lifetime
  // --------------------------------------------------------------------------

  it('a TTL entry expires together with its revision counter and history', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Ephemeral', body: 'b', type: 'state',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test', ttl: 1,
    });
    expect(await raw.ttl(`memrev:${id}`)).toBeGreaterThan(0);
    expect(await raw.ttl(`memver:${id}`)).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 1400));
    expect(await raw.exists(`mem:${id}`, `memrev:${id}`, `memver:${id}`)).toBe(0);

    // With the counter gone, create-if-absent works again as documented.
    const recreated = await call(c, 'memory_set', {
      id, title: 'Fresh start', body: 'b', type: 'state',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(recreated.ok).toBe(true);
    expect(recreated.operation).toBe('created');
    expect(recreated.revision).toBe(1);

    await raw.quit();
    await c.close();
  });

  it('removing a TTL persists the revision counter and history alongside the entry', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Expiring', body: 'b', type: 'state',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test', ttl: 600,
    });
    await call(c, 'memory_set', {
      id, title: 'Permanent', body: 'b', type: 'state',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
    });

    expect(await raw.ttl(`mem:${id}`)).toBe(-1);
    expect(await raw.ttl(`memrev:${id}`)).toBe(-1);
    expect(await raw.ttl(`memver:${id}`)).toBe(-1);

    await raw.quit();
    await c.close();
  });

  it('memory_delete persists a TTL entry\'s counter and tombstone history', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Doomed but remembered', body: 'b', type: 'state',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test', ttl: 600,
    });

    const del = await call(c, 'memory_delete', { id });
    expect(del.ok).toBe(true);

    // The tombstone and the ABA counter must outlive the entry's old deadline.
    expect(await raw.ttl(`memver:${id}`)).toBe(-1);
    expect(await raw.ttl(`memrev:${id}`)).toBe(-1);
    const tombstone = JSON.parse(await raw.lindex(`memver:${id}`, 0));
    expect(tombstone.operation).toBe('deleted');

    await raw.quit();
    await c.close();
  });

  // --------------------------------------------------------------------------
  // operation_id: reuse across different ids
  // --------------------------------------------------------------------------

  it('reusing an operation_id for a different id is an error, not a silent replay', async () => {
    const c = await client();
    const idA = uid();
    const idB = uid();
    const opId = 'op-' + uid();

    const first = await call(c, 'memory_set', {
      id: idA, title: 'first', body: 'b', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });
    expect(first.ok).toBe(true);

    const second = await call(c, 'memory_set', {
      id: idB, title: 'second', body: 'b', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('operation_id_mismatch');
    expect(second.recorded_id).toBe(idA);

    // The mismatched write must not have landed anywhere.
    const gone = await call(c, 'memory_get', { id: idB });
    expect(gone.error).toMatch(/Not found/);

    await c.close();
  });

  // --------------------------------------------------------------------------
  // atomicity: delete and rollback against concurrent writers
  // --------------------------------------------------------------------------

  it('concurrent set and delete leave no stale index memberships', async () => {
    const raw = rawClient();

    for (let round = 0; round < 5; round++) {
      const id = uid();
      const WRITERS = 8;
      const DELETERS = 3;
      const tags = Array.from({ length: WRITERS }, () => uid());

      const setup = await client();
      await call(setup, 'memory_set', {
        id, title: 'base', body: 'b', type: 'pattern',
        tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
      });
      await setup.close();

      const clients = await Promise.all(
        Array.from({ length: WRITERS + DELETERS }, () => client())
      );
      await Promise.all([
        ...tags.map((tag, i) => call(clients[i], 'memory_set', {
          id, title: `writer-${i}`, body: 'b', type: 'pattern',
          tags: [tag], source: 'test-suite', project: 'memory-mcp-test',
        })),
        ...Array.from({ length: DELETERS }, (_, i) =>
          call(clients[WRITERS + i], 'memory_delete', { id })),
      ]);
      await Promise.all(clients.map((c) => c.close()));

      // Whatever the interleaving, index membership must match the final entry:
      // alive means exactly its own tag, deleted means no memberships at all.
      const alive = (await raw.exists(`mem:${id}`)) === 1;
      const entryTags = alive
        ? ((await raw.hget(`mem:${id}`, 'tags')) || '').split(',').filter(Boolean)
        : [];
      for (const tag of tags) {
        const member = (await raw.sismember(`tag:${tag}`, `mem:${id}`)) === 1;
        expect(member, `round ${round}: tag ${tag} membership=${member} alive=${alive}`).toBe(
          alive && entryTags.includes(tag)
        );
      }
    }

    await raw.quit();
  });

  it('concurrent set and rollback keep history and indexes consistent', async () => {
    const raw = rawClient();

    for (let round = 0; round < 8; round++) {
      const id = uid();
      const WRITERS = 8;
      const ROLLBACKERS = 6;
      const tags = Array.from({ length: WRITERS }, () => uid());

      const setup = await client();
      await call(setup, 'memory_set', {
        id, title: 'v1', body: 'b1', type: 'pattern',
        tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
      });
      await call(setup, 'memory_set', {
        id, title: 'v2', body: 'b2', type: 'pattern',
        tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
      });
      await setup.close();

      const clients = await Promise.all(
        Array.from({ length: WRITERS + ROLLBACKERS }, () => client())
      );
      // Interleave the dispatch order so writes and rollbacks overlap in flight.
      const ops = [];
      for (let i = 0; i < Math.max(WRITERS, ROLLBACKERS); i++) {
        if (i < WRITERS) {
          ops.push(call(clients[i], 'memory_set', {
            id, title: `writer-${i}`, body: 'b', type: 'pattern',
            tags: [tags[i]], source: 'test-suite', project: 'memory-mcp-test',
          }));
        }
        if (i < ROLLBACKERS) {
          ops.push(call(clients[WRITERS + i], 'memory_rollback', { id, version_index: 0 }));
        }
      }
      await Promise.all(ops);
      await Promise.all(clients.map((c) => c.close()));

      // History must be written in revision order: every mutation is atomic, so
      // no snapshot can be pushed beneath one with a higher revision.
      const revs = (await raw.lrange(`memver:${id}`, 0, -1)).map((v) => JSON.parse(v).rev);
      for (let i = 1; i < revs.length; i++) {
        expect(revs[i], `round ${round}: history revs ${revs.join(',')}`).toBeLessThan(revs[i - 1]);
      }

      // Index membership matches the final entry state.
      const entryTags = ((await raw.hget(`mem:${id}`, 'tags')) || '').split(',').filter(Boolean);
      for (const tag of tags) {
        const member = (await raw.sismember(`tag:${tag}`, `mem:${id}`)) === 1;
        expect(member, `round ${round}: tag ${tag}`).toBe(entryTags.includes(tag));
      }

      // The served revision agrees with the counter.
      const verify = await client();
      const final = await call(verify, 'memory_get', { id });
      await verify.close();
      expect(final.revision).toBe(parseInt(await raw.get(`memrev:${id}`), 10));
    }

    await raw.quit();
  });

  // --------------------------------------------------------------------------
  // tag validation
  // --------------------------------------------------------------------------

  it('memory_set rejects a tag containing a comma', async () => {
    const c = await client();
    const id = uid();

    const outcome = await c.callTool({
      name: 'memory_set',
      arguments: {
        id, title: 'comma tag', body: 'b', type: 'pattern',
        tags: ['foo,bar'], source: 'test-suite', project: 'memory-mcp-test',
      },
    }).then((r) => r, (e) => e);

    // Whether surfaced as a protocol error or an isError result, the write
    // must be refused: the CSV wire format cannot represent a comma tag.
    if (!(outcome instanceof Error)) expect(outcome.isError).toBe(true);
    const gone = await call(c, 'memory_get', { id });
    expect(gone.error).toMatch(/Not found/);

    await c.close();
  });

  it('memory_set rejects an empty-string tag', async () => {
    const c = await client();
    const id = uid();

    const outcome = await c.callTool({
      name: 'memory_set',
      arguments: {
        id, title: 'empty tag', body: 'b', type: 'pattern',
        tags: ['', 'real-tag'], source: 'test-suite', project: 'memory-mcp-test',
      },
    }).then((r) => r, (e) => e);

    if (!(outcome instanceof Error)) expect(outcome.isError).toBe(true);
    const gone = await call(c, 'memory_get', { id });
    expect(gone.error).toMatch(/Not found/);

    await c.close();
  });

  // --------------------------------------------------------------------------
  // memory_get error surfacing
  // --------------------------------------------------------------------------

  it('memory_get surfaces a storage error instead of fabricating a success', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Corruptible', body: 'b', type: 'pattern',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
    });
    // Sabotage the hit counter so the pipelined HINCRBY fails.
    await raw.hset(`mem:${id}`, 'hits', 'not-a-number');

    const outcome = await c.callTool({
      name: 'memory_get',
      arguments: { id },
    }).then((r) => r, (e) => e);

    if (!(outcome instanceof Error)) expect(outcome.isError).toBe(true);

    await raw.quit();
    await c.close();
  });

  // --------------------------------------------------------------------------
  // memory_get atomicity
  // --------------------------------------------------------------------------

  it('concurrent memory_get calls each report a distinct, authoritative hit count', async () => {
    // Previously memory_get read the entry, then incremented in a second round
    // trip, and synthesised the response as raw.hits + 1. Concurrent readers all
    // saw the same starting value, so N callers reported the same count while the
    // store advanced by N.
    const setup = await client();
    const id = uid();
    await call(setup, 'memory_set', {
      id, title: 'Contended read', body: 'b', type: 'pattern',
      tags: ['get-race'], source: 'test-suite', project: 'memory-mcp-test',
    });
    await setup.close();

    const READERS = 10;
    const clients = await Promise.all(Array.from({ length: READERS }, () => client()));
    const results = await Promise.all(clients.map((c) => call(c, 'memory_get', { id })));
    await Promise.all(clients.map((c) => c.close()));

    const reported = results.map((r) => r.hits).sort((a, b) => a - b);
    expect(reported).toEqual(Array.from({ length: READERS }, (_, i) => i + 1));

    // And the last reported value matches what is actually stored.
    const raw = rawClient();
    expect(parseInt(await raw.hget(`mem:${id}`, 'hits'), 10)).toBe(READERS);
    await raw.quit();
  });

  it('memory_get on a missing id creates no key', async () => {
    // The increment must be conditional on the entry existing. An unconditional
    // HINCRBY would create a mem:<id> hash holding only hits, with no title and
    // no TTL, which every read and cleanup path then treats as absent while the
    // mem:* scan still counts it. Nothing in the API can remove such a key.
    const c = await client();
    const raw = rawClient();
    const id = uid();

    const missing = await call(c, 'memory_get', { id });
    expect(missing.error).toMatch(/Not found/);
    expect(await raw.exists(`mem:${id}`)).toBe(0);

    await raw.quit();
    await c.close();
  });

  it('memory_get does not revive an entry deleted between the read and the increment', async () => {
    // The race itself cannot be interleaved through the public API, so this
    // asserts the invariant it produces: after a delete, no amount of reading
    // brings the key back in any form.
    const c = await client();
    const raw = rawClient();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Doomed read target', body: 'b', type: 'pattern',
      tags: ['get-ghost'], source: 'test-suite', project: 'memory-mcp-test',
    });
    await call(c, 'memory_delete', { id });
    expect(await raw.exists(`mem:${id}`)).toBe(0);

    for (let i = 0; i < 5; i++) {
      const got = await call(c, 'memory_get', { id });
      expect(got.error).toMatch(/Not found/);
    }

    // No ghost, and nothing for the entry gauge to over-count.
    expect(await raw.exists(`mem:${id}`)).toBe(0);
    expect(await raw.hgetall(`mem:${id}`)).toEqual({});

    await raw.quit();
    await c.close();
  });
});

// ============================================================================
// CONFIGURED SERVER TESTS (port 3109, MAX_ENTRIES_WARN=0, OPERATION_ID_TTL_SECONDS=3600)
// ============================================================================

describe('memory-mcp configured retention and soft cap', () => {
  let proc;
  const BASE = 'http://127.0.0.1:3109';

  beforeAll(async () => {
    proc = spawnServer(3109, { MAX_ENTRIES_WARN: '0', OPERATION_ID_TTL_SECONDS: '3600' });
    await waitReady(BASE);
  });

  afterAll(async () => {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.on('exit', r));
  });

  it('the operation_id description reflects the configured retention window', async () => {
    const c = await client(3109);
    const tools = await c.listTools();
    const memSet = tools.tools.find((t) => t.name === 'memory_set');
    expect(memSet.inputSchema.properties.operation_id.description).toContain('3600 seconds');
    await c.close();
  });

  it('a replayed write still carries the soft-cap warning', async () => {
    const c = await client(3109);
    const id = uid();
    const opId = 'op-' + uid();

    const first = await call(c, 'memory_set', {
      id, title: 'warned', body: 'b', type: 'pattern',
      tags: ['warn'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });
    expect(first.warning).toMatch(/soft cap/);

    const replay = await call(c, 'memory_set', {
      id, title: 'warned', body: 'b', type: 'pattern',
      tags: ['warn'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.warning).toMatch(/soft cap/);

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
