// Embeddings arrive normalised from the embedder, so cosine similarity is a
// plain dot product. Re-normalising here would be a silent no-op per comparison.
export function dot(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

// Deliberately simple and bounded to [0, 1]. A title hit outranks a body hit
// because titles in this store are unusually descriptive.
export function keywordScore(query, title, body) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const inTitle = (title || '').toLowerCase().includes(q);
  const inBody = (body || '').toLowerCase().includes(q);
  if (inTitle) return 1;
  if (inBody) return 0.5;
  return 0;
}

export function bestChunk(queryVector, chunks) {
  if (!queryVector || !chunks || chunks.length === 0) return null;
  let best = null;
  for (const c of chunks) {
    const score = dot(queryVector, c.vector);
    if (!best || score > best.score) best = { score, chunk: c };
  }
  return best;
}

export const VECTOR_WEIGHT = 0.6;

export function blend(vectorScore, textScore) {
  return VECTOR_WEIGHT * vectorScore + (1 - VECTOR_WEIGHT) * textScore;
}
