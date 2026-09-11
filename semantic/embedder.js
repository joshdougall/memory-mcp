import { pipeline } from '@huggingface/transformers';

export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const DIMS = 384;

// BGE retrieval models are trained asymmetrically: the query carries an
// instruction, the passage does not. Prefixing both, or prefixing the passage
// instead, degrades retrieval with no error anywhere. One constant so the write
// path and the search path cannot drift apart.
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let extractor = null;
let loading = null;

async function getExtractor() {
  if (extractor) return extractor;
  // Single-flight: concurrent callers share one load rather than each pulling
  // the model.
  if (!loading) {
    loading = pipeline('feature-extraction', MODEL_ID, { dtype: 'int8' })
      .then((p) => { extractor = p; return p; })
      .finally(() => { loading = null; });
  }
  return loading;
}

async function embed(texts) {
  if (!texts || texts.length === 0) return [];
  const pipe = await getExtractor();
  // normalize: true means cosine similarity is a plain dot product downstream.
  const out = await pipe(texts, { pooling: 'mean', normalize: true });
  const flat = out.data;
  const vectors = [];
  for (let i = 0; i < texts.length; i += 1) {
    vectors.push(Float32Array.from(flat.slice(i * DIMS, (i + 1) * DIMS)));
  }
  return vectors;
}

export async function embedPassages(texts) {
  return embed(texts);
}

export async function embedQuery(text) {
  const [v] = await embed([QUERY_PREFIX + text]);
  return v;
}
