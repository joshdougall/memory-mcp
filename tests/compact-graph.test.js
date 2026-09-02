import { describe, it, expect } from 'vitest';
import { stripManagedBlock, parseLinks, BACKLINK_START, BACKLINK_END } from '../compact/graph.js';

describe('marker constants', () => {
  it('BACKLINK_START has the correct literal value', () => {
    expect(BACKLINK_START).toBe('<!-- compaction:backlinks:start -->');
  });

  it('BACKLINK_END has the correct literal value', () => {
    expect(BACKLINK_END).toBe('<!-- compaction:backlinks:end -->');
  });
});

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

  it('returns the body unchanged when only a start marker is present', () => {
    const body = `text\n${BACKLINK_START}\nmore text`;
    expect(stripManagedBlock(body)).toBe(body);
  });

  it('returns the body unchanged when only an end marker is present', () => {
    const body = `text\n${BACKLINK_END}\nmore text`;
    expect(stripManagedBlock(body)).toBe(body);
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

  it('extracts links from a body with only a start marker (no end marker)', () => {
    const body = `${BACKLINK_START}\n[[should-be-extracted]]`;
    expect(parseLinks(body)).toEqual(['should-be-extracted']);
  });

  it('extracts links from a body with only an end marker (no start marker)', () => {
    const body = `[[should-be-extracted]]\n${BACKLINK_END}`;
    expect(parseLinks(body)).toEqual(['should-be-extracted']);
  });
});
