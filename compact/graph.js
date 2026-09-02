export const BACKLINK_START = '<!-- compaction:backlinks:start -->';
export const BACKLINK_END = '<!-- compaction:backlinks:end -->';

// Also consumes the newline separating the block from the preceding line, so a
// body of `a\n<block>` round-trips to `a` rather than `a\n`. Without that, every
// run would differ from the last by one trailing newline and the zero-write
// idempotency guarantee would never hold.
export function stripManagedBlock(body) {
  const start = body.indexOf(BACKLINK_START);
  if (start === -1) return body;
  const endIdx = body.indexOf(BACKLINK_END, start);
  if (endIdx === -1) return body;
  let from = start;
  let to = endIdx + BACKLINK_END.length;
  if (from > 0 && body[from - 1] === '\n') from -= 1;
  else if (body[to] === '\n') to += 1;
  return body.slice(0, from) + body.slice(to);
}

export function parseLinks(body) {
  const seen = new Set();
  const out = [];
  for (const m of stripManagedBlock(body).matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}
