export const BACKLINK_START = '<!-- compaction:backlinks:start -->';
export const BACKLINK_END = '<!-- compaction:backlinks:end -->';

// Excises [from, to) and also consumes the newline separating the excised span
// from the preceding line, so a body of `a\n<block>` round-trips to `a` rather
// than `a\n`. Without that, every run would differ from the last by one
// trailing newline and the zero-write idempotency guarantee would never hold.
function cut(body, from, to) {
  let a = from;
  let b = to;
  if (a > 0 && body[a - 1] === '\n') a -= 1;
  else if (body[b] === '\n') b += 1;
  return body.slice(0, a) + body.slice(b);
}

// Locates the first COMPLETE block: the first end marker that has a start
// marker somewhere before it, paired with its nearest preceding start so a
// stray earlier start is left where it is rather than swallowing the text
// between them.
function firstCompleteBlock(body) {
  const firstStart = body.indexOf(BACKLINK_START);
  if (firstStart === -1) return null;
  const endIdx = body.indexOf(BACKLINK_END, firstStart);
  if (endIdx === -1) return null;
  return { from: body.lastIndexOf(BACKLINK_START, endIdx), to: endIdx + BACKLINK_END.length };
}

// Total with respect to markers: if the body holds a complete block, the first
// one is removed; if it holds none, every stray marker left in the body is
// removed instead.
//
// The second half is the fix for an orphan end marker. Returning the body
// unchanged there made applyBacklinks append a fresh block AFTER the orphan on
// every run: the entry was rewritten and grew by roughly 105 bytes a night,
// forever. It also broke the invariant that text inside a managed block is
// never a citation, because parseLinks then read the machine written
// `- [[citer]]` lines of those appended blocks as real outbound links, which
// inflated inbound counts elsewhere in the graph.
export function stripManagedBlock(body) {
  const block = firstCompleteBlock(body);
  if (block) return cut(body, block.from, block.to);

  let out = body;
  for (;;) {
    const s = out.indexOf(BACKLINK_START);
    const e = out.indexOf(BACKLINK_END);
    if (s === -1 && e === -1) return out;
    const takeStart = s !== -1 && (e === -1 || s < e);
    const idx = takeStart ? s : e;
    const len = (takeStart ? BACKLINK_START : BACKLINK_END).length;
    out = cut(out, idx, idx + len);
  }
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// Fenced code blocks are line-delimited: an opening fence is three or more
// backticks or tildes (up to 3 leading spaces, any trailing language label
// ignored), closed by a line holding a run of the same character at least as
// long, with nothing but spaces/tabs around it. An opening fence that never
// closes swallows the rest of the body, matching what a markdown renderer
// does with an unterminated fence.
//
// The whole region (open line, interior, close line) collapses to a single
// space rather than being deleted, so text before and after the fence is
// never joined into something that reads as one token.
function stripFences(body) {
  const lines = body.split('\n');
  const out = [];
  let fenceChar = null;
  let fenceLen = 0;
  for (const line of lines) {
    if (fenceChar === null) {
      const open = line.match(FENCE_OPEN_RE);
      if (open) {
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        out.push(' ');
        continue;
      }
      out.push(line);
      continue;
    }
    const close = line.match(FENCE_CLOSE_RE);
    if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
      fenceChar = null;
      fenceLen = 0;
    }
    // Every line while inside the fence, including the closing line itself,
    // contributes nothing further: the region is already represented by the
    // single space pushed for the opening line.
  }
  return out.join('\n');
}

// Inline code spans per CommonMark: a run of N backticks opens a span that is
// closed by the next run of exactly N backticks; a run with no matching close
// is literal text, not a span. Each matched span collapses to a single space,
// for the same join-avoidance reason as stripFences.
function stripInlineCode(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] !== '`') {
      out += text[i];
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && text[j] === '`') j += 1;
    const openLen = j - i;
    let k = j;
    let closeStart = -1;
    while (k < n) {
      if (text[k] !== '`') {
        k += 1;
        continue;
      }
      let m = k;
      while (m < n && text[m] === '`') m += 1;
      if (m - k === openLen) {
        closeStart = k;
        break;
      }
      k = m;
    }
    if (closeStart === -1) {
      out += text.slice(i, j);
      i = j;
    } else {
      out += ' ';
      i = closeStart + openLen;
    }
  }
  return out;
}

// Strips markdown code (fenced blocks, then inline spans) so parseLinks never
// reads a `[[wikilink]]` written as prose about the syntax itself as a real
// citation. Exported so the stripping can be tested directly, independent of
// parseLinks and the managed-block handling it runs alongside.
export function stripCode(body) {
  return stripInlineCode(stripFences(body));
}

export function parseLinks(body) {
  const seen = new Set();
  const out = [];
  // The character class excludes newlines as well as `]`: an unmatched `[[`
  // would otherwise run across lines and capture a multi-line target, which
  // would mint a stub with a garbage multi-line id.
  for (const m of stripCode(stripManagedBlock(body)).matchAll(/\[\[([^\]\n]+)\]\]/g)) {
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
