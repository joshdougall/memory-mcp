import { describe, it, expect } from 'vitest';
import { disposition, reportFlags, isGeneratorShaped, TOMBSTONE_TAG } from '../compact/disposition.js';
import { buildGraph } from '../compact/graph.js';

function entry(id, over = {}) {
  return { id, title: id, body: '', type: 'reference', tags: [], source: 'test',
           project: '', created: '2026-08-01', updated: '2026-08-01', hits: 0, ttl: '', ...over };
}
const AUDIT = 'audit-rule-update-7d945e96-395f-469e-88d3-825426bb6dfc-20260809-112759-f6e39a';
const tomb = (over = {}) => entry(AUDIT, { type: 'audit', ttl: '2592000', tags: [TOMBSTONE_TAG], ...over });

describe('isGeneratorShaped', () => {
  it('matches a UUID', () => expect(isGeneratorShaped(AUDIT)).toBe(true));
  it('matches a bare timestamp', () => expect(isGeneratorShaped('audit-backfill-20260809-004118')).toBe(true));
  it('rejects a hand-written id', () => expect(isGeneratorShaped('rv-budget-facts')).toBe(false));
});

describe('disposition', () => {
  it('tombstones uncited machine exhaust', () => {
    const e = entry(AUDIT, { type: 'audit' });
    expect(disposition(e, buildGraph([e]))).toBe('tombstone');
  });

  it('holds cited machine exhaust', () => {
    const e = entry(AUDIT, { type: 'audit' });
    expect(disposition(e, buildGraph([e, entry('citer', { body: `[[${AUDIT}]]` })]))).toBe('hold');
  });

  it('leaves an uncited tombstone alone', () => {
    const e = tomb();
    expect(disposition(e, buildGraph([e]))).toBe('leave');
  });

  it('rescues a tombstone cited by a normal entry', () => {
    const e = tomb();
    expect(disposition(e, buildGraph([e, entry('citer', { body: `[[${AUDIT}]]` })]))).toBe('rescue');
  });

  it('does not rescue when the only citer is itself tombstoned', () => {
    const e = tomb();
    const other = entry('audit-other-20260809-004118', {
      type: 'audit', ttl: '2592000', tags: [TOMBSTONE_TAG], body: `[[${AUDIT}]]`,
    });
    expect(disposition(e, buildGraph([e, other]))).toBe('leave');
  });

  it('keys provenance on the tag, not the TTL', () => {
    // Tag present, TTL externally cleared: still ours, still Leave, never re-tombstoned.
    const e = tomb({ ttl: '' });
    expect(disposition(e, buildGraph([e]))).toBe('leave');
    // And such an entry must not rescue another tombstone.
    const victim = entry('audit-victim-20260809-004119', {
      type: 'audit', ttl: '2592000', tags: [TOMBSTONE_TAG],
    });
    const citer = tomb({ ttl: '', body: '[[audit-victim-20260809-004119]]' });
    expect(disposition(victim, buildGraph([victim, citer]))).toBe('leave');
  });

  it('never touches a foreign TTL, even when cited', () => {
    const e = entry('ephemeral', { ttl: '3600' });
    expect(disposition(e, buildGraph([e, entry('c', { body: '[[ephemeral]]' })]))).toBe('foreign-ttl');
  });

  it('returns none for a hand-written entry with a bad type', () => {
    const e = entry('hand-written', { type: 'audit' });
    expect(disposition(e, buildGraph([e]))).toBe('none');
  });

  it('returns none for an ordinary entry', () => {
    const e = entry('ordinary');
    expect(disposition(e, buildGraph([e]))).toBe('none');
  });
});

describe('reportFlags', () => {
  it('flags an undocumented type on a non-generator id', () => {
    const e = entry('hand-written', { type: 'audit' });
    expect(reportFlags(e, buildGraph([e]))).toContain('undocumented-type');
  });

  it('flags held machine exhaust', () => {
    const e = entry(AUDIT, { type: 'audit' });
    expect(reportFlags(e, buildGraph([e, entry('c', { body: `[[${AUDIT}]]` })]))).toContain('held-machine-exhaust');
  });

  it('emits nothing for a clean entry', () => {
    const e = entry('ordinary');
    expect(reportFlags(e, buildGraph([e]))).toEqual([]);
  });
});
