// semantic/index.js
import { chunk } from './chunker.js';
import * as defaultEmbedder from './embedder.js';
import { putChunks, deleteChunks, markDirty } from './chunkstore.js';
import { stripManagedBlock } from '../compact/graph.js';

// The compaction pass writes `## Referenced by` blocks into entry bodies.
// Machine-generated link lists are not content: embedding them would match
// every query weakly and mean nothing. Stripping happens before chunking, so
// every offset the chunker records indexes into this string, not the raw body.
//
// One exported definition so the write path and anything that reports offsets
// cannot drift apart on which string those offsets mean, the same reason
// QUERY_PREFIX is a single constant.
export function indexedBody(body) {
  return stripManagedBlock(body || '');
}

// `embedder` is injectable so the failure path can be driven deterministically.
export async function indexEntry(redis, id, { title, body, ttl }, embedder = defaultEmbedder) {
  const stripped = indexedBody(body);
  const pieces = chunk(stripped);

  if (pieces.length === 0) {
    // Nothing left to embed, most often an entry that is only a managed
    // block. Clear any stale chunks from a previous version rather than
    // leaving them to match searches against content this entry no longer
    // carries.
    await deleteChunks(redis, id);
    return { chunks: 0 };
  }

  // The title rides on the first chunk only: enough to carry retrieval weight
  // for a short entry, without diluting every chunk of a long one.
  const texts = pieces.map((p, i) => (i === 0 && title ? `${title}\n\n${p.text}` : p.text));

  let vectors;
  try {
    vectors = await embedder.embedPassages(texts);
  } catch (err) {
    // A write must never fail because the model did. Record it and move on,
    // the backfill drains the dirty set later.
    await markDirty(redis, id);
    return { chunks: 0, skipped: err.message };
  }

  const withVectors = pieces.map((p, i) => ({ ...p, vector: vectors[i] }));
  await putChunks(redis, id, withVectors, ttl);
  return { chunks: withVectors.length };
}
