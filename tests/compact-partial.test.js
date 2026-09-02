import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEnv } from './helpers/compact-env.js';

// Injects a failure into ONE point of the real pass: the store write. Everything
// else (health, connect, census, get) is the genuine article talking to a real
// server, so the run reaches the write loop, lands a real write, and then dies
// the way it would if the server went away mid-run. `failFrom` is 1-based over
// setEntry calls; Infinity means never fail, which is what seeding needs.
const inject = vi.hoisted(() => ({ calls: 0, failFrom: Infinity }));
vi.mock('../compact/store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    setEntry: async (client, args) => {
      inject.calls += 1;
      if (inject.calls >= inject.failFrom) throw new Error('injected store failure');
      return actual.setEntry(client, args);
    },
  };
});

const { run, EXIT } = await import('../compact/compact.js');
const { connect, census, setEntry, getEntry } = await import('../compact/store.js');

let env, client;
beforeAll(async () => {
  env = await startEnv({ db: 11 });
  client = await connect({ url: env.mcpUrl, token: '' });
});
afterAll(async () => { await client?.close?.(); await env?.stop(); });
beforeEach(async () => {
  await env.flush();
  inject.calls = 0;
  inject.failFrom = Infinity;
});

const opts = (over = {}) => ({ dir: env.dir, url: env.mcpUrl, base: env.base, token: '', budgetMs: 60000, ...over });
const uid = (p) => `partial-${p}-` + Math.random().toString(36).slice(2);
const row = (id, over = {}) => ({ id, title: 't', body: '', type: 'reference', tags: [], project: '', ...over });
const logLines = () =>
  readFileSync(join(env.dir, 'log', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));

describe('exit code precedence', () => {
  // 4 outranks every other non-zero code. A run that changed the store and then
  // failed to finish must not report the reason it stopped (1/2/3/6) as though
  // nothing had been written: the half-applied store is the more serious fact
  // and is what a monitor has to act on.
  it('returns EXIT.PARTIAL when a write lands and the run then fails to complete', async () => {
    const a = uid('a');
    const b = uid('b');
    await setEntry(client, row(a, { project: '""' }));
    await setEntry(client, row(b, { project: '""' }));
    const before = {
      [a]: (await getEntry(client, a)).revision,
      [b]: (await getEntry(client, b)).revision,
    };

    inject.calls = 0;
    inject.failFrom = 2; // first repair lands, second throws

    const seen = (() => { try { return logLines().length; } catch { return 0; } })();
    const code = await run(opts());

    // The precedence line itself: without it this run returns EXIT.MCP, which
    // is the bare reason it stopped and says nothing about the store changing.
    expect(code).toBe(EXIT.PARTIAL);
    expect(code).not.toBe(EXIT.MCP);

    // And the premises the precedence line depends on really held: the run
    // failed, and at least one write genuinely landed in the store.
    const lines = logLines().slice(seen);
    expect(lines.some((r) => r.kind === 'error' && r.stage === 'run')).toBe(true);
    const end = lines.filter((r) => r.kind === 'end').at(-1);
    expect(end.writes_landed).toBeGreaterThan(0);

    const after = await census(client);
    const changed = after.filter((r) => (r.id === a || r.id === b) && r.project === '');
    expect(changed).toHaveLength(1);
    expect((await getEntry(client, changed[0].id)).revision).toBeGreaterThan(before[changed[0].id]);
  });

  it('returns the plain failure code when the run fails before any write', async () => {
    // The control for the assertion above: an identical class of failure that
    // records no intent at all returns the bare reason, not 4. Note the pass
    // deliberately counts an intent with no outcome as landed, because a write
    // whose response was lost may still have committed, so "no write" here has
    // to mean the run never got as far as intending one.
    await setEntry(client, row(uid('c'), { project: '""' }));
    const seen = logLines().length;
    expect(await run(opts({ url: 'http://127.0.0.1:9/mcp', base: 'http://127.0.0.1:9' }))).toBe(EXIT.MCP);
    const end = logLines().slice(seen).filter((r) => r.kind === 'end').at(-1);
    expect(end.writes_landed).toBe(0);
  });
});
