import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startEnv } from './helpers/compact-env.js';
import { connect, census, getEntry, setEntry, health, withDeadline, TruncatedCensusError, DeadlineError } from '../compact/store.js';

let env, client;
beforeAll(async () => {
  env = await startEnv({ db: 13 });
  client = await connect({ url: env.mcpUrl, token: '' });
});
afterAll(async () => { await client?.close?.(); await env?.stop(); });

const uid = () => 'store-' + Math.random().toString(36).slice(2);
const row = (id, over = {}) => ({ id, title: 't', body: '', type: 'reference', tags: [], project: '', ...over });

describe('store', () => {
  it('health reports true for a live server', async () => {
    expect(await health(env.base)).toBe(true);
  });

  it('withDeadline rejects a stalled promise and passes a fast one through', async () => {
    await expect(withDeadline(new Promise(() => {}), 20, 'stall')).rejects.toBeInstanceOf(DeadlineError);
    await expect(withDeadline(Promise.resolve('ok'), 1000, 'fast')).resolves.toBe('ok');
  });

  it('health reports false for a dead port', async () => {
    expect(await health('http://127.0.0.1:9')).toBe(false);
  });

  it('round-trips an entry and returns its revision', async () => {
    const id = uid();
    const set = await setEntry(client, row(id, { body: 'b', tags: ['x'] }));
    expect(set.ok).toBe(true);
    const got = await getEntry(client, id);
    expect(got.entry.title).toBe('t');
    expect(got.entry.tags).toEqual(['x']);
    expect(got.revision).toBe(set.revision);
  });

  it('returns null for a missing id', async () => {
    expect(await getEntry(client, uid())).toBeNull();
  });

  it('census exposes ttl as a string', async () => {
    const id = uid();
    await setEntry(client, { ...row(id), ttl: 600 });
    expect((await census(client)).find((r) => r.id === id).ttl).toBe('600');
  });

  it('throws when the census hits the cap', async () => {
    await expect(census(client, 1)).rejects.toBeInstanceOf(TruncatedCensusError);
  });

  it('returns a typed conflict rather than throwing', async () => {
    const id = uid();
    const first = await setEntry(client, row(id));
    await setEntry(client, { ...row(id, { title: 't2' }), if_version: first.revision });
    const stale = await setEntry(client, { ...row(id, { title: 't3' }), if_version: first.revision });
    expect(stale.ok).toBe(false);
    expect(stale.error).toBe('conflict');
    expect(stale.current_revision).toBeGreaterThan(first.revision);
  });

  it('reports a replay', async () => {
    const id = uid();
    const op = 'op-' + Math.random().toString(36).slice(2);
    await setEntry(client, { ...row(id), operation_id: op });
    const again = await setEntry(client, { ...row(id), operation_id: op });
    expect(again.ok).toBe(true);
    expect(again.replayed).toBe(true);
  });

  it('creates with if_version 0 and conflicts on an existing id', async () => {
    const id = uid();
    expect((await setEntry(client, { ...row(id), if_version: 0 })).ok).toBe(true);
    expect((await setEntry(client, { ...row(id), if_version: 0 })).ok).toBe(false);
  });
});
