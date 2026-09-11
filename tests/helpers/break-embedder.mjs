// Preloaded with `node --import` so the resolution hook is in place before
// server.js pulls in the embedder. See broken-transformers.mjs.
import { register } from 'node:module';

register('./broken-transformers.mjs', import.meta.url);
