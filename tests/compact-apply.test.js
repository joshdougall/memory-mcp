import { describe, it, expect } from 'vitest';
import { applyOne } from '../compact/compact.js';
import { planEntry } from '../compact/plan.js';
import { buildGraph } from '../compact/graph.js';

const bounded = (promise) => promise;
function harness() {
  const records = [];
  return { records, safeRecord: (kind, fields) => records.push({ kind, ...fields }), skipped: [] };
}
function entryRow(id, over = {}) {
  return { id, title: id, body: '', type: 'reference', tags: [], source: 'test',
           project: '', created: '2026-08-01', updated: '2026-08-01', hits: 0, ttl: '', ...over };
}

// A stub client: `gets` is consumed one per getEntry call, `sets` one per setEntry.
// setEntry also records the full args it was called with, in call order, on
// `__setCalls`, so a test can prove the caller behaved correctly rather than
// merely that it received the canned result back.
function stubClient({ gets, sets }) {
  return { __gets: [...gets], __sets: [...sets], __setCalls: [] };
}
const stubStore = {
  getEntry: async (c) => c.__gets.shift(),
  setEntry: async (c, args) => { c.__setCalls.push(args); return c.__sets.shift(); },
};

describe('applyOne', () => {
  it('retries once after a conflict and succeeds on the second attempt', async () => {
    const row = entryRow('x', { project: '""' });
    const p = planEntry(row, buildGraph([row]));
    const h = harness();
    const client = stubClient({
      gets: [{ entry: row, revision: 1 }, { entry: row, revision: 2 }],
      sets: [{ ok: false, error: 'conflict', current_revision: 2 }, { ok: true, revision: 3 }],
    });
    await applyOne(client, p, [row], bounded, h.safeRecord, h.skipped, stubStore);
    expect(h.records.filter((r) => r.kind === 'rejected')).toHaveLength(1);
    expect(h.records.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(h.skipped).toEqual([]);
    // Each attempt must carry its own operation_id: a retry that reuses the
    // first attempt's id would replay as a silent no-op against a server that
    // treats operation_id as an idempotency key, reporting success without
    // ever repairing the entry.
    const opIds = client.__setCalls.map((args) => args.operation_id);
    expect(opIds).toHaveLength(2);
    expect(opIds[0]).toBeTruthy();
    expect(opIds[1]).toBeTruthy();
    expect(opIds[0]).not.toBe(opIds[1]);
    // Every write is a compare-and-set against the revision the immediately
    // preceding read returned. Without it a write would clobber whatever a
    // concurrent writer put there between the read and the write, which is the
    // single most important data-safety guard in the pass. The retry must carry
    // the SECOND read's revision, not the first: replaying the stale one would
    // conflict forever.
    expect(client.__setCalls.map((args) => args.if_version)).toEqual([1, 2]);
  });

  it('skips and reports after two conflicts', async () => {
    const row = entryRow('x', { project: '""' });
    const p = planEntry(row, buildGraph([row]));
    const h = harness();
    const client = stubClient({
      gets: [{ entry: row, revision: 1 }, { entry: row, revision: 2 }],
      sets: [{ ok: false, error: 'conflict' }, { ok: false, error: 'conflict' }],
    });
    await applyOne(client, p, [row], bounded, h.safeRecord, h.skipped, stubStore);
    expect(h.records.filter((r) => r.kind === 'applied')).toHaveLength(0);
    expect(h.records.some((r) => r.kind === 'skip' && r.reason === 'conflict-twice')).toBe(true);
    expect(h.skipped).toHaveLength(1);
    // Both doomed attempts still guarded, each against its own fresh read.
    expect(client.__setCalls.map((args) => args.if_version)).toEqual([1, 2]);
  });

  it('skips when the fresh read shows the entry no longer qualifies', async () => {
    const stale = entryRow('x', { project: '""' });
    const p = planEntry(stale, buildGraph([stale]));
    const repaired = entryRow('x', { project: '' }); // someone fixed it first
    const h = harness();
    const client = stubClient({ gets: [{ entry: repaired, revision: 9 }], sets: [] });
    await applyOne(client, p, [stale], bounded, h.safeRecord, h.skipped, stubStore);
    expect(h.records.some((r) => r.kind === 'skip' && r.reason === 'eligibility-changed')).toBe(true);
    expect(h.records.filter((r) => r.kind === 'intent')).toHaveLength(0);
  });

  it('skips when the entry vanished between census and write', async () => {
    const row = entryRow('x', { project: '""' });
    const p = planEntry(row, buildGraph([row]));
    const h = harness();
    const client = stubClient({ gets: [null], sets: [] });
    await applyOne(client, p, [row], bounded, h.safeRecord, h.skipped, stubStore);
    expect(h.skipped[0]).toMatch(/vanished/);
    expect(h.records.filter((r) => r.kind === 'intent')).toHaveLength(0);
  });

  it('records an intent before every write attempt', async () => {
    const row = entryRow('x', { project: '""' });
    const p = planEntry(row, buildGraph([row]));
    const h = harness();
    const client = stubClient({
      gets: [{ entry: row, revision: 1 }, { entry: row, revision: 2 }],
      sets: [{ ok: false, error: 'conflict' }, { ok: true, revision: 3 }],
    });
    await applyOne(client, p, [row], bounded, h.safeRecord, h.skipped, stubStore);
    const intents = h.records.filter((r) => r.kind === 'intent');
    expect(intents).toHaveLength(2);
    // and each intent carries a restorable preimage
    for (const rec of intents) {
      expect(rec.preimage.project).toBe('""');
    }
    // Tie each logged intent to the actual setEntry call it preceded, rather
    // than assuming the log and the call agree: same operation_id per attempt,
    // and the two attempts must not share one.
    const setOpIds = client.__setCalls.map((args) => args.operation_id);
    expect(setOpIds).toHaveLength(2);
    for (let i = 0; i < intents.length; i += 1) {
      expect(setOpIds[i]).toBeTruthy();
      expect(intents[i].operation_id).toBe(setOpIds[i]);
    }
    expect(setOpIds[0]).not.toBe(setOpIds[1]);
    // The guarded revision must match the read that produced the preimage
    // logged alongside it, attempt for attempt.
    expect(client.__setCalls.map((args) => args.if_version)).toEqual([1, 2]);
    expect(h.records.filter((r) => r.kind === 'applied')[0].prior_revision).toBe(2);
  });
});
