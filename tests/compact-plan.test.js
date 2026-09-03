import { describe, it, expect } from 'vitest';
import { planEntry, planStubs } from '../compact/plan.js';
import { buildGraph, BACKLINK_START, parseLinks } from '../compact/graph.js';
import { TOMBSTONE_TAG, TOMBSTONE_TTL } from '../compact/disposition.js';

function entry(id, over = {}) {
  return { id, title: id, body: '', type: 'reference', tags: [], source: 'test',
           project: '', created: '2026-08-01', updated: '2026-08-01', hits: 0, ttl: '', ...over };
}
const AUDIT = 'audit-rule-update-7d945e96-395f-469e-88d3-825426bb6dfc-20260809-112759-f6e39a';

describe('planEntry', () => {
  it('plans a tombstone with tag, ttl and action', () => {
    const e = entry(AUDIT, { type: 'audit' });
    const p = planEntry(e, buildGraph([e]));
    expect(p.disposition).toBe('tombstone');
    expect(p.write.ttl).toBe(TOMBSTONE_TTL);
    expect(p.write.tags).toContain(TOMBSTONE_TAG);
    expect(p.actions).toEqual(['tombstone']);
  });

  it('plans a rescue that drops the tag and omits ttl', () => {
    const e = entry(AUDIT, { type: 'audit', ttl: '2592000', tags: [TOMBSTONE_TAG, 'keep'] });
    const p = planEntry(e, buildGraph([e, entry('c', { body: `[[${AUDIT}]]` })]));
    expect(p.disposition).toBe('rescue');
    expect(p.write.tags).toEqual(['keep']);
    expect('ttl' in p.write).toBe(false);
    expect(p.actions).toEqual(['rescue']);
  });

  it('plans no write for leave, foreign-ttl or hold', () => {
    const left = entry(AUDIT, { type: 'audit', ttl: '2592000', tags: [TOMBSTONE_TAG] });
    expect(planEntry(left, buildGraph([left])).write).toBeNull();
    const foreign = entry('eph', { ttl: '3600' });
    expect(planEntry(foreign, buildGraph([foreign])).write).toBeNull();
    const held = entry(AUDIT, { type: 'audit' });
    const g = buildGraph([held, entry('c', { body: `[[${AUDIT}]]` })]);
    expect(planEntry(held, g).write).toBeNull();
  });

  it('normalises a malformed project and names the action', () => {
    const e = entry('bad', { project: '""' });
    const p = planEntry(e, buildGraph([e]));
    expect(p.write.project).toBe('');
    expect(p.actions).toEqual(['schema']);
  });

  it('applies both repairs in one write', () => {
    const e = entry('bad', { project: '""' });
    const g = buildGraph([e, entry('c1', { body: '[[bad]]' }), entry('c2', { body: '[[bad]]' })]);
    const p = planEntry(e, g);
    expect(p.write.project).toBe('');
    expect(p.write.body).toContain(BACKLINK_START);
    expect(p.actions).toEqual(['schema', 'backlinks']);
  });

  it('reports backlink removal as its own action', () => {
    const withBlock = planEntry(
      entry('x'), buildGraph([entry('x'), entry('c1', { body: '[[x]]' }), entry('c2', { body: '[[x]]' })]),
    ).write.body;
    const e = entry('x', { body: withBlock });
    const p = planEntry(e, buildGraph([e, entry('c1', { body: '[[x]]' })]));
    expect(p.actions).toEqual(['backlinks-removed']);
  });

  it('repairs an undocumented non-generator entry without changing its type', () => {
    const e = entry('hand-written', { type: 'audit', project: '""' });
    const p = planEntry(e, buildGraph([e]));
    expect(p.write.type).toBe('audit');
    expect(p.write.project).toBe('');
    expect(p.flags).toContain('undocumented-type');
  });

  it('plans no write when nothing needs repair', () => {
    const e = entry('clean');
    const p = planEntry(e, buildGraph([e]));
    expect(p.write).toBeNull();
    expect(p.actions).toEqual([]);
  });
});

describe('planStubs', () => {
  it('creates one entity stub per dangling target', () => {
    const stubs = planStubs(buildGraph([entry('a', { body: '[[ghost]]' })]));
    expect(stubs).toHaveLength(1);
    expect(stubs[0].id).toBe('ghost');
    expect(stubs[0].type).toBe('entity');
    expect(stubs[0].tags).toContain('stub');
  });

  it('creates a body with no wikilinks and no managed block', () => {
    const [stub] = planStubs(buildGraph([entry('a', { body: '[[ghost]]' })]));
    expect(parseLinks(stub.body)).toEqual([]);
    expect(stub.body).not.toContain(BACKLINK_START);
  });

  it('records the citer count in the prose', () => {
    const g = buildGraph([entry('a', { body: '[[ghost]]' }), entry('b', { body: '[[ghost]]' })]);
    expect(planStubs(g)[0].body).toContain('2');
  });

  it('produces a stub the planner will not rewrite on the next run', () => {
    const [stub] = planStubs(buildGraph([entry('a', { body: '[[ghost]]' })]));
    const asEntry = entry(stub.id, { body: stub.body, type: stub.type, tags: stub.tags });
    const next = planEntry(asEntry, buildGraph([asEntry, entry('a', { body: '[[ghost]]' })]));
    expect(next.write).toBeNull();
  });

  // A dangling target can be cited by two or more entries, and a stub is an
  // ordinary entry from the next census onward. It has to be built directly in
  // whatever terminal form ordinary planning would leave it in, using the same
  // threshold, or the very next run is a write on an otherwise unchanged store.
  describe('threshold parity with ordinary backlink planning', () => {
    it('creates a stub with two citers WITH a managed block listing both, and replanning it agrees', () => {
      const citerEntries = [entry('a', { body: '[[ghost]]' }), entry('b', { body: '[[ghost]]' })];
      const [stub] = planStubs(buildGraph(citerEntries));
      expect(stub.body).toContain(BACKLINK_START);
      expect(stub.body).toContain('[[a]]');
      expect(stub.body).toContain('[[b]]');

      const asEntry = entry(stub.id, { body: stub.body, type: stub.type, tags: stub.tags });
      const next = planEntry(asEntry, buildGraph([asEntry, ...citerEntries]));
      expect(next.write).toBeNull();
    });

    it('creates a stub with one citer WITHOUT a managed block, and replanning it agrees', () => {
      const citerEntries = [entry('a', { body: '[[ghost]]' })];
      const [stub] = planStubs(buildGraph(citerEntries));
      expect(stub.body).not.toContain(BACKLINK_START);

      const asEntry = entry(stub.id, { body: stub.body, type: stub.type, tags: stub.tags });
      const next = planEntry(asEntry, buildGraph([asEntry, ...citerEntries]));
      expect(next.write).toBeNull();
    });

    it('creates a stub with three citers WITH a managed block listing all three, and replanning it agrees', () => {
      const citerEntries = [
        entry('a', { body: '[[ghost]]' }),
        entry('b', { body: '[[ghost]]' }),
        entry('c', { body: '[[ghost]]' }),
      ];
      const [stub] = planStubs(buildGraph(citerEntries));
      expect(stub.body).toContain(BACKLINK_START);
      expect(stub.body).toContain('[[a]]');
      expect(stub.body).toContain('[[b]]');
      expect(stub.body).toContain('[[c]]');

      const asEntry = entry(stub.id, { body: stub.body, type: stub.type, tags: stub.tags });
      const next = planEntry(asEntry, buildGraph([asEntry, ...citerEntries]));
      expect(next.write).toBeNull();
    });

    it('never reads its own generated block back as outbound citations, at any citer count', () => {
      for (const ids of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
        const citerEntries = ids.map((id) => entry(id, { body: '[[ghost]]' }));
        const [stub] = planStubs(buildGraph(citerEntries));
        expect(parseLinks(stub.body)).toEqual([]);
      }
    });
  });
});
