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
function stubClient({ gets, sets }) {
  return { __gets: [...gets], __sets: [...sets] };
}
const stubStore = {
  getEntry: async (c) => c.__gets.shift(),
  setEntry: async (c) => c.__sets.shift(),
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
    expect(h.records.filter((r) => r.kind === 'intent')).toHaveLength(2);
    // and each intent carries a restorable preimage
    for (const rec of h.records.filter((r) => r.kind === 'intent')) {
      expect(rec.preimage.project).toBe('""');
    }
  });
});
