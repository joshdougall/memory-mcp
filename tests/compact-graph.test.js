import { describe, it, expect } from 'vitest';
import { stripManagedBlock, parseLinks, BACKLINK_START, BACKLINK_END } from '../compact/graph.js';

describe('stripManagedBlock', () => {
  it('removes the managed region and leaves the rest intact', () => {
    const body = `before\n${BACKLINK_START}\n## Referenced by\n- [[a]]\n${BACKLINK_END}\nafter`;
    expect(stripManagedBlock(body)).toBe('before\nafter');
  });

  it('returns the body unchanged when there is no block', () => {
    expect(stripManagedBlock('plain body')).toBe('plain body');
  });

  it('removes a block that is the entire body', () => {
    expect(stripManagedBlock(`${BACKLINK_START}\nx\n${BACKLINK_END}`)).toBe('');
  });

  it('removes only the first block when markers repeat', () => {
    const body = `${BACKLINK_START}\nx\n${BACKLINK_END}\nmid\n${BACKLINK_START}\ny\n${BACKLINK_END}`;
    expect(stripManagedBlock(body)).toBe(`mid\n${BACKLINK_START}\ny\n${BACKLINK_END}`);
  });
});

describe('parseLinks', () => {
  it('extracts wikilink targets', () => {
    expect(parseLinks('see [[foo]] and [[bar]]')).toEqual(['foo', 'bar']);
  });

  it('deduplicates and preserves first-seen order', () => {
    expect(parseLinks('[[b]] [[a]] [[b]]')).toEqual(['b', 'a']);
  });

  it('ignores links inside a managed block', () => {
    const body = `real [[keep]]\n${BACKLINK_START}\n- [[generated]]\n${BACKLINK_END}`;
    expect(parseLinks(body)).toEqual(['keep']);
  });

  it('returns an empty array for an empty body', () => {
    expect(parseLinks('')).toEqual([]);
  });
});
