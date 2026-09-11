// Two roles in one file.
//
// As a module resolution hook (registered by break-embedder.mjs) it redirects
// every import of '@huggingface/transformers' to itself, so the embedder in a
// spawned server gets the `pipeline` below instead of the real one and every
// embedding call fails deterministically, offline, with no network involved.
//
// The obvious alternative, pointing the process at a cache path that does not
// exist, does not work: @huggingface/transformers 4.x reads neither
// TRANSFORMERS_CACHE nor HF_HUB_OFFLINE and caches inside its own package
// directory, so the model still loads.

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@huggingface/transformers') {
    return { url: import.meta.url, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function pipeline() {
  throw new Error('embedding model unavailable');
}
