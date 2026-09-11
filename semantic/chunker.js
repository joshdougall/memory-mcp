// 1600 chars targets ~400 tokens at the standard 4-chars-per-token
// approximation. The model's hard ceiling is 512 tokens, so the ~112 token gap
// absorbs approximation error. It is headroom, not slack: exceeding 512 makes
// the encoder truncate silently, losing the tail of a chunk with no error.
export const CHUNK_CHARS = 1600;
export const OVERLAP_CHARS = 320;

export function chunk(text) {
  if (!text || !text.trim()) return [];
  if (text.length <= CHUNK_CHARS) {
    return [{ text, start: 0, end: text.length }];
  }

  const stride = CHUNK_CHARS - OVERLAP_CHARS;
  const out = [];
  for (let start = 0; start < text.length; start += stride) {
    const end = Math.min(start + CHUNK_CHARS, text.length);
    out.push({ text: text.slice(start, end), start, end });
    if (end === text.length) break;
  }
  return out;
}
