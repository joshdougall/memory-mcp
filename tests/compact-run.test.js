import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEnv } from './helpers/compact-env.js';
import { run, EXIT } from '../compact/compact.js';
import { connect, census, setEntry, getEntry } from '../compact/store.js';

let env, client;
beforeAll(async () => {
  env = await startEnv({ db: 14 });
  client = await connect({ url: env.mcpUrl, token: '' });
});
afterAll(async () => { await client?.close?.(); await env?.stop(); });
beforeEach(async () => { await env.flush(); });

const opts = (over = {}) => ({ dir: env.dir, url: env.mcpUrl, base: env.base, token: '', budgetMs: 60000, ...over });
const uid = (p) => `run-${p}-` + Math.random().toString(36).slice(2);
const junkId = () => `audit-rule-${crypto.randomUUID()}-20260809-112759`;
const row = (id, over = {}) => ({ id, title: 't', body: '', type: 'reference', tags: [], project: '', ...over });
const find = async (id) => (await census(client)).find((r) => r.id === id);
const report = () => readFileSync(join(env.dir, 'report.md'), 'utf8');
const logLines = () =>
  readFileSync(join(env.dir, 'log', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));

describe('run', () => {
  it('creates a stub for a dangling target with no wikilinks in it', async () => {
    const ghost = uid('ghost');
    await setEntry(client, row(uid('citer'), { body: `see [[${ghost}]]` }));
    expect(await run(opts())).toBe(EXIT.OK);
    const made = await getEntry(client, ghost);
    expect(made.entry.type).toBe('entity');
    expect(made.entry.tags).toContain('stub');
    expect(made.entry.body).not.toContain('[[');
  });

  it('tombstones uncited machine exhaust and never re-arms it', async () => {
    const junk = junkId();
    await setEntry(client, row(junk, { type: 'audit' }));
    expect(await run(opts())).toBe(EXIT.OK);
    expect((await find(junk)).ttl).toBe('2592000');
    const rev = (await getEntry(client, junk)).revision;
    expect(await run(opts())).toBe(EXIT.OK);
    expect((await getEntry(client, junk)).revision).toBe(rev);
  });

  it('is idempotent store-wide, including stubs', async () => {
    const ghost = uid('ghost');
    await setEntry(client, row(uid('citer'), { body: `see [[${ghost}]]` }));
    await setEntry(client, row(uid('b'), { project: '""' }));
    await run(opts());
    const seen = logLines().length;
    await run(opts());
    // Asserted from the run log: `updated` is date-only so it cannot detect a
    // same-day write, and census rows carry no revision.
    const second = logLines().slice(seen);
    expect(second.filter((r) => ['intent', 'applied'].includes(r.kind))).toEqual([]);
  });

  it('dry run writes nothing and reports actions, stubs and dispositions', async () => {
    const junk = junkId();
    const ghost = uid('ghost');
    await setEntry(client, row(junk, { type: 'audit' }));
    await setEntry(client, row(uid('citer'), { body: `see [[${ghost}]]` }));
    const rev = (await getEntry(client, junk)).revision;
    expect(await run(opts({ dryRun: true }))).toBe(EXIT.OK);
    expect((await getEntry(client, junk)).revision).toBe(rev);
    expect(await getEntry(client, ghost)).toBeNull();
    const text = report();
    expect(text).toContain('Intended actions');
    expect(text).toContain('tombstone: 1');
    expect(text).toContain('upper bound');
    expect(text).toContain('Dispositions');
  });

  it('dry run counts match what the real run then does', async () => {
    const junk = junkId();
    await setEntry(client, row(junk, { type: 'audit' }));
    await setEntry(client, row(uid('b'), { project: '""' }));
    await run(opts({ dryRun: true }));
    const planned = report().match(/^- (\w+): (\d+)$/gm).join('\n');
    const seen = logLines().length;
    await run(opts());
    const applied = logLines().slice(seen).filter((r) => r.kind === 'applied').length;
    expect(planned).toContain('schema: 1');
    expect(planned).toContain('tombstone: 1');
    expect(applied).toBe(2);
  });

  it('returns EXIT.MCP when the server is unreachable and nothing was written', async () => {
    expect(await run(opts({ url: 'http://127.0.0.1:9/mcp', base: 'http://127.0.0.1:9' }))).toBe(EXIT.MCP);
  });

  it('returns EXIT.TRUNCATED with zero writes when the census hits the cap', async () => {
    const junk = junkId();
    await setEntry(client, row(junk, { type: 'audit' }));
    const rev = (await getEntry(client, junk)).revision;
    expect(await run(opts({ censusCap: 1 }))).toBe(EXIT.TRUNCATED);
    expect((await getEntry(client, junk)).revision).toBe(rev);
  });

  it('returns EXIT.BUDGET when the budget expires before any write', async () => {
    await setEntry(client, row(uid('x'), { project: '""' }));
    expect(await run(opts({ budgetMs: 1 }))).toBe(EXIT.BUDGET);
  });

  it('returns EXIT.LOCAL when the log directory cannot be created', async () => {
    expect(await run(opts({ dir: '/proc/nope/nowhere' }))).toBe(EXIT.LOCAL);
  });
});
