import { describe, it, expect } from 'vitest';
import { chunk, CHUNK_CHARS, OVERLAP_CHARS } from '../semantic/chunker.js';

describe('chunk', () => {
  it('returns one chunk for short text', () => {
    const out = chunk('hello world');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ text: 'hello world', start: 0, end: 11 });
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunk('')).toEqual([]);
    expect(chunk('   \n  ')).toEqual([]);
  });

  it('splits long text into overlapping chunks', () => {
    const text = 'x'.repeat(CHUNK_CHARS * 2);
    const out = chunk(text);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].start).toBe(0);
    expect(out[1].start).toBe(CHUNK_CHARS - OVERLAP_CHARS);
  });

  it('offsets always index back to the original text', () => {
    const text = 'abcdefghij'.repeat(500);
    for (const c of chunk(text)) {
      expect(text.slice(c.start, c.end)).toBe(c.text);
    }
  });

  it('covers the whole text with no gap between consecutive chunks', () => {
    const out = chunk('y'.repeat(CHUNK_CHARS * 3));
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i].start).toBeLessThan(out[i - 1].end);
    }
    expect(out[out.length - 1].end).toBe(CHUNK_CHARS * 3);
  });

  it('never emits a chunk longer than the limit', () => {
    for (const c of chunk('z'.repeat(CHUNK_CHARS * 4 + 7))) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
    }
  });

  it('does not emit a trailing chunk that is pure overlap', () => {
    const out = chunk('w'.repeat(CHUNK_CHARS + 10));
    const last = out[out.length - 1];
    expect(last.end).toBe(CHUNK_CHARS + 10);
    expect(out.filter((c) => c.start >= c.end)).toEqual([]);
  });
});
