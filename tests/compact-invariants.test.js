import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEnv } from './helpers/compact-env.js';
import { run, EXIT } from '../compact/compact.js';
import { connect, census, setEntry, getEntry } from '../compact/store.js';
import { TOMBSTONE_TAG } from '../compact/disposition.js';
import { parseLinks } from '../compact/graph.js';

let env, client;
beforeAll(async () => {
  env = await startEnv({ db: 15 });
  client = await connect({ url: env.mcpUrl, token: '' });
});
afterAll(async () => { await client?.close?.(); await env?.stop(); });
beforeEach(async () => { await env.flush(); });

const opts = (over = {}) => ({ dir: env.dir, url: env.mcpUrl, base: env.base, token: '', budgetMs: 60000, ...over });
const uid = (p) => `inv-${p}-` + Math.random().toString(36).slice(2);
const junkId = () => `audit-rule-${crypto.randomUUID()}-20260809-112759`;
const row = (id, over = {}) => ({ id, title: 't', body: '', type: 'reference', tags: [], project: '', ...over });
const find = async (id) => (await census(client)).find((r) => r.id === id);
const logLines = () =>
  readFileSync(join(env.dir, 'log', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
const raw = (id) => client.callTool({ name: 'memory_get', arguments: { id } });

describe('invariants', () => {
  it('increments hits only for entries it read, by exactly the logged read count', async () => {
    await setEntry(client, row(uid('a'), { project: '""' }));
    await setEntry(client, row(uid('b')));
    const before = Object.fromEntries((await census(client)).map((r) => [r.id, r.hits]));
    await run(opts());
    const reads = {};
    for (const rec of logLines()) if (rec.kind === 'read') reads[rec.id] = (reads[rec.id] || 0) + 1;
    for (const r of await census(client)) {
      if (!(r.id in before)) continue;
      expect(r.hits - before[r.id]).toBe(reads[r.id] || 0);
    }
  });

  it('does not touch a foreign TTL even when cited', async () => {
    const eph = uid('eph');
    await setEntry(client, { ...row(eph, { type: 'state' }), ttl: 3600 });
    await setEntry(client, row(uid('citer'), { body: `[[${eph}]]` }));
    const rev = (await getEntry(client, eph)).revision;
    await run(opts());
    expect((await find(eph)).ttl).toBe('3600');
    expect((await getEntry(client, eph)).revision).toBe(rev);
  });

  it('rescues a tombstone that gains a live citation, dropping tag and expiry', async () => {
    const junk = junkId();
    await setEntry(client, row(junk, { type: 'audit' }));
    await run(opts());
    expect((await find(junk)).ttl).toBe('2592000');

    await setEntry(client, row(uid('rescuer'), { body: `[[${junk}]]` }));
    await run(opts());
    const after = await find(junk);
    expect(after.ttl).toBe('');
    expect(after.tags).not.toContain(TOMBSTONE_TAG);
    // The expiry must be gone from the entry itself, not merely from the field.
    const ttlRemaining = await env.redis.ttl(`mem:${junk}`);
    expect(ttlRemaining).toBe(-1);
    expect(await env.redis.ttl(`memver:${junk}`)).toBe(-1);
    expect(await env.redis.ttl(`memrev:${junk}`)).toBe(-1);
  });

  it('does not let two tombstones rescue each other', async () => {
    // Seeded as already-tagged tombstones. Created uncited then cross-cited they
    // would be `hold`, never `tombstone`, and this would test nothing.
    const a = junkId();
    const b = junkId();
    await setEntry(client, { ...row(a, { type: 'audit', tags: [TOMBSTONE_TAG], body: `[[${b}]]` }), ttl: 2592000 });
    await setEntry(client, { ...row(b, { type: 'audit', tags: [TOMBSTONE_TAG], body: `[[${a}]]` }), ttl: 2592000 });
    await run(opts());
    for (const id of [a, b]) {
      const r = await find(id);
      expect(r.tags).toContain(TOMBSTONE_TAG);
      expect(r.ttl).toBe('2592000');
    }
  });

  it('does not re-arm the countdown across runs', async () => {
    const junk = junkId();
    await setEntry(client, row(junk, { type: 'audit' }));
    await run(opts());
    const rev = (await getEntry(client, junk)).revision;
    await run(opts());
    await run(opts());
    expect((await getEntry(client, junk)).revision).toBe(rev);
  });

  it('keeps backlink blocks stable over three runs', async () => {
    const hub = uid('hub');
    await setEntry(client, row(hub));
    await setEntry(client, row(uid('c1'), { body: `[[${hub}]]` }));
    await setEntry(client, row(uid('c2'), { body: `[[${hub}]]` }));
    await run(opts());
    const rev = (await getEntry(client, hub)).revision;
    await run(opts());
    await run(opts());
    expect((await getEntry(client, hub)).revision).toBe(rev);
  });

  it('removes a backlink block when inbound falls below threshold', async () => {
    const hub = uid('hub');
    const c1 = uid('c1');
    await setEntry(client, row(hub));
    await setEntry(client, row(c1, { body: `[[${hub}]]` }));
    await setEntry(client, row(uid('c2'), { body: `[[${hub}]]` }));
    await run(opts());
    expect((await getEntry(client, hub)).entry.body).toContain('compaction:backlinks:start');

    const stale = await getEntry(client, c1);
    await setEntry(client, { ...row(c1, { body: 'no longer cites it' }), if_version: stale.revision });
    await run(opts());
    expect((await getEntry(client, hub)).entry.body).not.toContain('compaction:backlinks:start');
  });

  it('creates a stub that is never rewritten on later runs', async () => {
    const ghost = uid('ghost');
    await setEntry(client, row(uid('citer'), { body: `[[${ghost}]]` }));
    await run(opts());
    const created = await getEntry(client, ghost);
    expect(parseLinks(created.entry.body)).toEqual([]);
    await run(opts());
    await run(opts());
    expect((await getEntry(client, ghost)).revision).toBe(created.revision);
  });

  it('skips a stub whose id has a retained revision counter and never resurrects it', async () => {
    const ghost = uid('ghost');
    await setEntry(client, row(ghost));
    await client.callTool({ name: 'memory_delete', arguments: { id: ghost } });
    await setEntry(client, row(uid('citer'), { body: `[[${ghost}]]` }));
    await run(opts());
    expect(await getEntry(client, ghost)).toBeNull();
    expect(readFileSync(join(env.dir, 'report.md'), 'utf8')).toContain(ghost);
  });

  it('records a preimage that restores content fields and not server-managed ones', async () => {
    const id = uid('preimage');
    await setEntry(client, row(id, { project: '""', body: 'original body' }));
    const originalHits = (await find(id)).hits;
    await run(opts());
    const intent = logLines().find((r) => r.kind === 'intent' && r.id === id);
    expect(intent.preimage.project).toBe('""');

    const current = await getEntry(client, id);
    const pre = intent.preimage;
    await setEntry(client, {
      id, title: pre.title, body: pre.body, type: pre.type, tags: pre.tags,
      source: pre.source, project: pre.project, if_version: current.revision,
    });
    const restored = await getEntry(client, id);
    expect(restored.entry.project).toBe('""');
    expect(restored.entry.body).toBe('original body');
    // created/updated/hits are server-managed and are NOT restored.
    expect(restored.entry.hits).not.toBe(originalHits);
  });
});
