import { describe, it, expect } from 'vitest';
import { dot, keywordScore, bestChunk, blend, VECTOR_WEIGHT, EXACT_ID_SCORE, VERBATIM_SCORE, TERM_SCORE } from '../semantic/rank.js';

const unit = (...xs) => { const v = Float32Array.from(xs); const n = Math.hypot(...xs); return v.map((x) => x / n); };

describe('dot', () => {
  it('is 1 for identical unit vectors and 0 for orthogonal', () => {
    expect(dot(unit(1, 0), unit(1, 0))).toBeCloseTo(1, 6);
    expect(dot(unit(1, 0), unit(0, 1))).toBeCloseTo(0, 6);
  });
  it('throws when the first vector is longer', () => {
    expect(() => dot(unit(1, 0, 0), unit(1, 0))).toThrow();
  });
  it('throws when the second vector is longer', () => {
    expect(() => dot(unit(1, 0), unit(1, 0, 0))).toThrow();
  });
});

describe('keywordScore', () => {
  it('puts an exact id match at the top of the scale', () => {
    expect(keywordScore('audit-rule-abc-20260809-004118', 'junk', 'machine exhaust', 'audit-rule-abc-20260809-004118'))
      .toBe(EXACT_ID_SCORE);
    // Above anything a title or body match can reach, because an id lookup is
    // never ambiguous.
    expect(EXACT_ID_SCORE).toBeGreaterThan(VERBATIM_SCORE);
  });
  it('scores a verbatim substring of title or body alike', () => {
    expect(keywordScore('valkey', 'valkey notes', 'nothing', 'x')).toBe(VERBATIM_SCORE);
    expect(keywordScore('valkey', 'nothing', 'valkey notes', 'x')).toBe(VERBATIM_SCORE);
  });
  it('scores a verbatim substring of the id too', () => {
    expect(keywordScore('audit-rule', 'junk', 'machine exhaust', 'audit-rule-abc-20260809-004118'))
      .toBe(VERBATIM_SCORE);
  });
  it('falls back to a term match when every term lands but the phrase does not', () => {
    expect(keywordScore('postgres pool', 'Pooling', 'postgres connection pool settings', 'x'))
      .toBe(TERM_SCORE);
  });
  it('does not award a term match when only some terms land', () => {
    expect(keywordScore('postgres kafka', 'Pooling', 'postgres connection pool settings', 'x')).toBe(0);
  });
  it('is 0 when absent and case-insensitive when present', () => {
    expect(keywordScore('absent', 'a', 'b', 'x')).toBe(0);
    expect(keywordScore('VALKEY', 'valkey', '', 'x')).toBeGreaterThan(0);
    expect(keywordScore('AUDIT-RULE-ABC', 'junk', 'machine exhaust', 'audit-rule-abc')).toBe(EXACT_ID_SCORE);
  });
  it('is 0 for an empty query', () => {
    expect(keywordScore('', 'anything', 'anything', 'x')).toBe(0);
    expect(keywordScore('   ', 'anything', 'anything', 'x')).toBe(0);
  });
  it('is bounded to the declared scale', () => {
    for (const v of [EXACT_ID_SCORE, VERBATIM_SCORE, TERM_SCORE]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect([EXACT_ID_SCORE, VERBATIM_SCORE, TERM_SCORE]).toEqual([1, 0.8, 0.5]);
  });
  it('works with no id supplied', () => {
    expect(keywordScore('valkey', 'valkey notes', 'nothing')).toBe(VERBATIM_SCORE);
    expect(keywordScore('absent', 'a', 'b')).toBe(0);
  });
});

describe('bestChunk', () => {
  it('returns the highest scoring chunk and its score', () => {
    const q = unit(1, 0);
    const chunks = [
      { text: 'worst', vector: unit(0, 1) },
      { text: 'best', vector: unit(1, 0.05) },
      { text: 'bad', vector: unit(-1, 0) },
    ];
    const out = bestChunk(q, chunks);
    expect(out.chunk.text).toBe('best');
    expect(out.score).toBeGreaterThan(0.9);
  });
  it('returns null when there are no chunks or no query vector', () => {
    expect(bestChunk(unit(1, 0), [])).toBeNull();
    expect(bestChunk(null, [{ text: 'x', vector: unit(1, 0) }])).toBeNull();
  });
});

describe('blend', () => {
  it('weights the vector score per VECTOR_WEIGHT', () => {
    expect(blend(1, 0)).toBeCloseTo(VECTOR_WEIGHT, 6);
    expect(blend(0, 1)).toBeCloseTo(1 - VECTOR_WEIGHT, 6);
    expect(blend(1, 1)).toBeCloseTo(1, 6);
  });
  it('ranks a strong semantic match above a weak keyword match', () => {
    expect(blend(0.9, 0)).toBeGreaterThan(blend(0, 0.9));
  });
});
