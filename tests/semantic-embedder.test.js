import { describe, it, expect } from 'vitest';
import { embedPassages, embedQuery, DIMS, MODEL_ID, QUERY_PREFIX } from '../semantic/embedder.js';
import { chunk } from '../semantic/chunker.js';

// These load a real ~34MB model on first run and cache it. Slow once, fast after.
describe('embedder', () => {
  it('names the verified model and dimension', () => {
    expect(MODEL_ID).toBe('Xenova/bge-small-en-v1.5');
    expect(DIMS).toBe(384);
  });

  it('uses the BGE retrieval instruction for queries only', () => {
    expect(QUERY_PREFIX).toBe('Represent this sentence for searching relevant passages: ');
  });

  it('embeds a passage to a normalised vector of the right width', async () => {
    const [v] = await embedPassages(['the compaction pass retires uncited machine exhaust']);
    expect(v).toHaveLength(DIMS);
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);
  }, 120000);

  it('embeds several passages in one call, in order', async () => {
    const out = await embedPassages(['alpha', 'beta', 'gamma']);
    expect(out).toHaveLength(3);
    expect(out.every((v) => v.length === DIMS)).toBe(true);
  }, 120000);

  it('ranks a paraphrase above an unrelated sentence', async () => {
    // The whole point of the feature, asserted at the lowest level.
    const [pass] = await embedPassages([
      'Josh is the final decision authority; escalate when unsure whether to act.',
    ]);
    const near = await embedQuery('who decides when I am not sure if I should do something');
    const far = await embedQuery('how do I rotate the tyres on a camper trailer');
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(pass, near)).toBeGreaterThan(dot(pass, far));
  }, 120000);

  it('returns an empty array for no input without loading anything', async () => {
    expect(await embedPassages([])).toEqual([]);
  });

  it('embeds the same string differently as a query versus a passage', async () => {
    // Proves the asymmetric prefix is actually applied: a missing prefix on
    // the query path would make these vectors identical.
    const text = 'restart the plan review when the reviewer disagrees with the author';
    const [asPassage] = await embedPassages([text]);
    const asQuery = await embedQuery(text);
    expect(asQuery).not.toEqual(asPassage);
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    // Both are unit vectors, so an identical pair would dot to ~1. A real
    // difference in text should keep them well clear of that ceiling too.
    expect(dot(asPassage, asQuery)).toBeLessThan(0.999);
  }, 120000);

  it('does not throw or produce NaN on a chunk that splits a surrogate pair', async () => {
    // 1599 'x', then 2 emoji (4 UTF-16 code units), then 50 'y'. The
    // chunker's boundary at index 1600 lands between the two code units of
    // the first emoji, so chunk 0 ends with a lone unpaired high surrogate.
    const text = 'x'.repeat(1599) + '\u{1F600}\u{1F601}' + 'y'.repeat(50);
    const chunks = chunk(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Confirm the fixture actually exercises the case: chunk 0 ends on a
    // lone high surrogate with no matching low surrogate after it.
    const firstText = chunks[0].text;
    const lastCode = firstText.charCodeAt(firstText.length - 1);
    expect(lastCode).toBeGreaterThanOrEqual(0xd800);
    expect(lastCode).toBeLessThanOrEqual(0xdbff);

    const vectors = await embedPassages(chunks.map((c) => c.text));
    expect(vectors).toHaveLength(chunks.length);
    for (const v of vectors) {
      expect(v).toHaveLength(DIMS);
      expect(v.every((x) => Number.isFinite(x))).toBe(true);
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
      expect(norm).toBeCloseTo(1, 3);
    }
  }, 120000);
});
