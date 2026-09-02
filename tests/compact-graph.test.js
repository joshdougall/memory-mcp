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

  it('removes a lone start marker when no complete block is present', () => {
    const body = `text\n${BACKLINK_START}\nmore text`;
    expect(stripManagedBlock(body)).toBe('text\nmore text');
  });

  // Previously asserted that the body came back unchanged, which certified the
  // orphan-end bug as correct: applyBacklinks then appended a fresh block after
  // the surviving marker on every run and the entry grew forever.
  it('removes a lone end marker when no complete block is present', () => {
    const body = `text\n${BACKLINK_END}\nmore text`;
    expect(stripManagedBlock(body)).toBe('text\nmore text');
  });

  it('removes every stray marker when the body holds no complete block', () => {
    const body = `a\n${BACKLINK_END}\nb\n${BACKLINK_START}\nc`;
    const out = stripManagedBlock(body);
    expect(out).toBe('a\nb\nc');
    expect(out).not.toContain(BACKLINK_START);
    expect(out).not.toContain(BACKLINK_END);
  });

  it('removes only the complete block when a dangling start marker precedes it', () => {
    const body = `${BACKLINK_START}\nstray\n${BACKLINK_START}\nx\n${BACKLINK_END}`;
    expect(stripManagedBlock(body)).toBe(`${BACKLINK_START}\nstray`);
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

  // The invariant the orphan-end bug broke: once a block has been appended
  // after a stray end marker, its `- [[id]]` lines are machine written and must
  // never be read back as outbound citations from this entry.
  it('reads no citations from block text that follows an orphan end marker', () => {
    const body = `plain\n${BACKLINK_END}\n${BACKLINK_START}\n## Referenced by\n- [[a]]\n- [[b]]\n${BACKLINK_END}`;
    expect(parseLinks(body)).toEqual([]);
  });

  it('does not capture a link target across a newline', () => {
    expect(parseLinks('[[unclosed\nnext line [[real]]')).toEqual(['real']);
  });
});

import { buildGraph } from '../compact/graph.js';

function entry(id, body = '', over = {}) {
  return { id, title: id, body, type: 'reference', tags: [], source: 'test',
           project: '', created: '2026-08-01', updated: '2026-08-01', hits: 0, ttl: '', ...over };
}

describe('buildGraph', () => {
  it('records inbound citations for existing targets', () => {
    const g = buildGraph([entry('a', 'see [[b]]'), entry('b')]);
    expect([...g.inbound.get('b')]).toEqual(['a']);
    expect(g.inbound.has('a')).toBe(false);
  });

  it('records dangling targets separately', () => {
    const g = buildGraph([entry('a', 'see [[ghost]]')]);
    expect([...g.dangling.get('ghost')]).toEqual(['a']);
    expect(g.inbound.has('ghost')).toBe(false);
  });

  it('counts a TTL-bearing entry as a citation source', () => {
    const g = buildGraph([entry('a', 'see [[b]]', { ttl: '2592000' }), entry('b')]);
    expect([...g.inbound.get('b')]).toEqual(['a']);
  });

  it('does not count links inside a managed block', () => {
    const body = `<!-- compaction:backlinks:start -->\n- [[b]]\n<!-- compaction:backlinks:end -->`;
    const g = buildGraph([entry('a', body), entry('b')]);
    expect(g.inbound.has('b')).toBe(false);
  });

  it('ignores an entry citing itself', () => {
    const g = buildGraph([entry('a', 'see [[a]]')]);
    expect(g.inbound.has('a')).toBe(false);
  });
});
