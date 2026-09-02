export const BACKLINK_START = '<!-- compaction:backlinks:start -->';
export const BACKLINK_END = '<!-- compaction:backlinks:end -->';

// Also consumes the newline separating the block from the preceding line, so a
// body of `a\n<block>` round-trips to `a` rather than `a\n`. Without that, every
// run would differ from the last by one trailing newline and the zero-write
// idempotency guarantee would never hold.
export function stripManagedBlock(body) {
  const endIdx = body.indexOf(BACKLINK_END);
  if (endIdx === -1) return body;
  const start = body.lastIndexOf(BACKLINK_START, endIdx);
  if (start === -1) return body;
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

export function buildGraph(entries) {
  const ids = new Set(entries.map((e) => e.id));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const inbound = new Map();
  const dangling = new Map();

  for (const e of entries) {
    for (const target of parseLinks(e.body)) {
      if (target === e.id) continue;
      const bucket = ids.has(target) ? inbound : dangling;
      if (!bucket.has(target)) bucket.set(target, new Set());
      bucket.get(target).add(e.id);
    }
  }
  return { ids, byId, inbound, dangling };
}
