import { describe, it, expect } from 'vitest';
import { hasManagedBlock, applyBacklinks } from '../compact/backlinks.js';
import { BACKLINK_START, BACKLINK_END, parseLinks } from '../compact/graph.js';

const block = (...ids) =>
  `${BACKLINK_START}\n## Referenced by\n${ids.map((i) => `- [[${i}]]`).join('\n')}\n${BACKLINK_END}`;

describe('applyBacklinks', () => {
  it('appends a sorted deduplicated block at or above threshold', () => {
    expect(applyBacklinks('body', ['b', 'a', 'b'])).toBe(`body\n${block('a', 'b')}`);
  });

  it('is idempotent: reapplying the same citers is byte-identical', () => {
    const once = applyBacklinks('body', ['a', 'b']);
    expect(applyBacklinks(once, ['a', 'b'])).toBe(once);
  });

  it('is stable over three applications', () => {
    const a = applyBacklinks('body', ['a', 'b']);
    expect(applyBacklinks(applyBacklinks(a, ['a', 'b']), ['a', 'b'])).toBe(a);
  });

  it('replaces an existing block rather than appending a second', () => {
    expect(applyBacklinks(`body\n${block('a', 'b')}`, ['a', 'c'])).toBe(`body\n${block('a', 'c')}`);
  });

  it('removes the block when citers fall below threshold', () => {
    expect(applyBacklinks(`body\n${block('a', 'b')}`, ['a'])).toBe('body');
  });

  it('removes the block when citers drop to zero', () => {
    expect(applyBacklinks(`body\n${block('a', 'b')}`, [])).toBe('body');
  });

  it('adds nothing below threshold when no block exists', () => {
    expect(applyBacklinks('body', ['a'])).toBe('body');
  });

  it('honours an explicit threshold of 1', () => {
    expect(applyBacklinks('body', ['a'], 1)).toBe(`body\n${block('a')}`);
  });

  it('produces a body whose generated links are invisible to parseLinks', () => {
    expect(parseLinks(applyBacklinks('body', ['a', 'b']))).toEqual([]);
  });

  // The orphan END regression, proven end to end against a real server: the
  // strip returned the body unchanged, a fresh block was appended after the
  // stray marker every run, and the entry grew by roughly 105 bytes and one
  // store write a night, forever.
  it('is idempotent when a dangling end marker precedes real content', () => {
    const input = `body\n${BACKLINK_END}`;
    const first = applyBacklinks(input, ['a', 'b']);
    const second = applyBacklinks(first, ['a', 'b']);
    const third = applyBacklinks(second, ['a', 'b']);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first).toContain('body');
    // Exactly one block, and no stray marker left over from the input.
    expect(first.split(BACKLINK_START)).toHaveLength(2);
    expect(first.split(BACKLINK_END)).toHaveLength(2);
    expect(first).toBe(`body\n${block('a', 'b')}`);
  });

  it('reads back no citations after an orphan end marker is repaired', () => {
    expect(parseLinks(applyBacklinks(`body\n${BACKLINK_END}`, ['a', 'b']))).toEqual([]);
  });

  it('is idempotent when a dangling start marker precedes real content', () => {
    const input = `${BACKLINK_START}\nstray\nbody`;
    const first = applyBacklinks(input, ['a', 'b']);
    const second = applyBacklinks(first, ['a', 'b']);
    expect(second).toBe(first);
    expect(first).toContain('stray');
  });
});

describe('hasManagedBlock', () => {
  it('detects a block', () => expect(hasManagedBlock(`x\n${block('a')}`)).toBe(true));
  it('reports absence', () => expect(hasManagedBlock('x')).toBe(false));
});
