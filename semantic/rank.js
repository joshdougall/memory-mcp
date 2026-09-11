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

// Bounded to [0, 1], on a scale chosen so a literal lookup outranks vector
// noise. At live-store scale this model returns roughly 0.36 cosine between
// two unrelated English texts, so a keyword signal that topped out low enough
// let unrelated entries outrank exact matches.
//
// The entry id is part of the haystack, and an exact id match is the top of
// the scale. Agents look entries up by id, and before search went hybrid the
// query was a substring filter, which made that work perfectly. keywordScore
// never seeing the id was a regression against behaviour already in use.
export const EXACT_ID_SCORE = 1;
export const VERBATIM_SCORE = 0.8;
export const TERM_SCORE = 0.5;

export function keywordScore(query, title, body, id) {
  if (!query) return 0;
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  if (q === (id || '').trim().toLowerCase() && q !== '') return EXACT_ID_SCORE;

  const haystack = `${id || ''}\n${title || ''}\n${body || ''}`.toLowerCase();
  if (haystack.includes(q)) return VERBATIM_SCORE;

  // Every term has to land. Any-term matching would score almost the whole
  // store on a natural language query, since common words appear everywhere,
  // and a signal that fires for everything ranks nothing.
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length > 1 && terms.every((t) => haystack.includes(t))) return TERM_SCORE;

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
