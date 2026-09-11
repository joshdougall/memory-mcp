import { describe, it, expect } from 'vitest';
import { dot, keywordScore, bestChunk, blend, VECTOR_WEIGHT } from '../semantic/rank.js';

const unit = (...xs) => { const v = Float32Array.from(xs); const n = Math.hypot(...xs); return v.map((x) => x / n); };

describe('dot', () => {
  it('is 1 for identical unit vectors and 0 for orthogonal', () => {
    expect(dot(unit(1, 0), unit(1, 0))).toBeCloseTo(1, 6);
    expect(dot(unit(1, 0), unit(0, 1))).toBeCloseTo(0, 6);
  });
});

describe('keywordScore', () => {
  it('scores a title hit above a body hit', () => {
    expect(keywordScore('valkey', 'valkey notes', 'nothing')).toBeGreaterThan(
      keywordScore('valkey', 'nothing', 'valkey notes'));
  });
  it('is 0 when absent and case-insensitive when present', () => {
    expect(keywordScore('absent', 'a', 'b')).toBe(0);
    expect(keywordScore('VALKEY', 'valkey', '')).toBeGreaterThan(0);
  });
  it('is 0 for an empty query', () => {
    expect(keywordScore('', 'anything', 'anything')).toBe(0);
  });
});

describe('bestChunk', () => {
  it('returns the highest scoring chunk and its score', () => {
    const q = unit(1, 0);
    const chunks = [
      { text: 'far', vector: unit(0, 1) },
      { text: 'near', vector: unit(1, 0.05) },
    ];
    const out = bestChunk(q, chunks);
    expect(out.chunk.text).toBe('near');
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
