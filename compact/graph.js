export const BACKLINK_START = '<!-- compaction:backlinks:start -->';
export const BACKLINK_END = '<!-- compaction:backlinks:end -->';

// ---------------------------------------------------------------------------
// One scanner, two behaviours.
//
// The body is scanned exactly once, left to right, and every region of it is
// classified as code or not-code. Both public behaviours are derived from that
// single classification rather than from independent string searches:
//
//   stripManagedBlock  removes every complete managed block and every stray
//                      marker that is not inside code.
//   parseLinks         returns wikilink targets that are neither inside code
//                      nor inside a complete managed block.
//
// Everything below is linear in the length of the body. No pass rescans a
// region it has already consumed, and no intermediate string is built per
// marker, which is what makes a pathological body of thousands of stray
// markers cost microseconds rather than seconds.
// ---------------------------------------------------------------------------

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM_RE = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]*)/;
const BLANK_RE = /^[ \t]*$/;
const TAB_STOP = 4;
const INDENT_CODE = 4;

function columnWidth(text) {
  let w = 0;
  for (let k = 0; k < text.length; k += 1) {
    if (text[k] === '\t') w += TAB_STOP - (w % TAB_STOP);
    else w += 1;
  }
  return w;
}

function indentWidth(line) {
  let w = 0;
  for (let k = 0; k < line.length; k += 1) {
    const ch = line[k];
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += TAB_STOP - (w % TAB_STOP);
    else break;
  }
  return w;
}

// Inline code spans per CommonMark: a run of N backticks opens a span closed by
// the next run of exactly N backticks; a run with no matching close is literal
// text, not a span.
//
// Two deliberate departures from CommonMark, both chosen for termination
// rather than fidelity:
//
//  * A span never crosses a line boundary. A wikilink cannot cross one either
//    (the target class excludes newlines), so a multi-line span would shield no
//    citation that a line-local one does not. What it would shield is a marker:
//    a dangling backtick in a user body could pair with a backtick inside a
//    machine-written `- [[id`x]]` line, hiding the block's own START marker
//    from the strip and making applyBacklinks append forever.
//
//  * Matching is driven off an index of backtick runs by length, so a line
//    carrying many distinct run lengths cannot make the search quadratic.
function scanInlineSpans(body, from, to, out) {
  const runs = [];
  for (let p = from; p < to;) {
    if (body[p] !== '`') { p += 1; continue; }
    let q = p;
    while (q < to && body[q] === '`') q += 1;
    runs.push({ start: p, len: q - p });
    p = q;
  }
  if (runs.length < 2) return;

  const byLen = new Map();
  for (let r = 0; r < runs.length; r += 1) {
    const arr = byLen.get(runs[r].len);
    if (arr) arr.push(r);
    else byLen.set(runs[r].len, [r]);
  }

  // One forward-only cursor per run length. Each cursor advances at most as
  // far as that length's own run count, so the whole loop is amortised linear.
  const cursor = new Map();
  let r = 0;
  while (r < runs.length) {
    const len = runs[r].len;
    const arr = byLen.get(len);
    let c = cursor.get(len) || 0;
    while (c < arr.length && arr[c] <= r) c += 1;
    if (c >= arr.length) {
      cursor.set(len, c);
      r += 1;
      continue;
    }
    const close = runs[arr[c]];
    out.push({ from: runs[r].start, to: close.start + len });
    cursor.set(len, c + 1);
    r = arr[c] + 1;
  }
}

// Marker occurrences within one line. START and END share a prefix but neither
// contains the other, so occurrences can never overlap and each index only ever
// moves forward: the whole line costs one pass per marker kind.
//
// `spans` is the line's inline code spans, in order. A marker that overlaps one
// at all is quoted code, not a marker.
function collectMarkers(line, base, spans, out) {
  let s = line.indexOf(BACKLINK_START);
  let e = line.indexOf(BACKLINK_END);
  let sp = 0;
  while (s !== -1 || e !== -1) {
    const useStart = s !== -1 && (e === -1 || s < e);
    const idx = useStart ? s : e;
    const len = (useStart ? BACKLINK_START : BACKLINK_END).length;
    const from = base + idx;
    const to = from + len;
    if (spans) {
      while (sp < spans.length && spans[sp].to <= from) sp += 1;
    }
    const quoted = spans && sp < spans.length && spans[sp].from < to;
    if (!quoted) out.push({ type: useStart ? 'start' : 'end', from, to });
    if (useStart) s = line.indexOf(BACKLINK_START, idx + len);
    else e = line.indexOf(BACKLINK_END, idx + len);
  }
}

// The single pass. Returns code regions and marker occurrences, both in
// increasing position order and both expressed as offsets into the ORIGINAL
// body, so every derived edit stays byte exact.
//
// Line endings: `\r\n`, bare `\r` and `\n` all terminate a line, and the
// terminator is never part of the line text handed to the fence and indent
// rules. A CRLF body therefore closes its fences like an LF one, instead of
// treating the retained `\r` as trailing junk and swallowing the remainder of
// the body.
//
// One asymmetry is deliberate. Markers found inside a fence that is never
// closed are reported anyway, while markers inside a properly closed fence are
// not. A closed fence is well formed documentation and must be preserved
// verbatim, including any managed block it quotes. An unclosed fence is
// malformed, and shielding markers inside it would mean applyBacklinks could
// never find the block it appended at the end of such a body, so it would
// append another one every night forever. Termination wins over fidelity here.
function scan(body) {
  const code = [];
  const markers = [];
  const n = body.length;

  let prevBlank = true;
  let listIndent = -1;

  let fenceFrom = -1;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceMarkers = null;

  let indentFrom = -1;
  let indentTo = -1;
  let indentMin = INDENT_CODE;

  let i = 0;
  while (i < n) {
    let end = i;
    while (end < n && body[end] !== '\n' && body[end] !== '\r') end += 1;
    let next = end;
    if (next < n) {
      if (body[next] === '\r') {
        next += 1;
        if (next < n && body[next] === '\n') next += 1;
      } else {
        next += 1;
      }
    }
    const line = body.slice(i, end);

    if (fenceFrom >= 0) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        code.push({ from: fenceFrom, to: end });
        fenceFrom = -1;
        fenceMarkers = null;
        prevBlank = true;
        listIndent = -1;
      } else {
        collectMarkers(line, i, null, fenceMarkers);
      }
      i = next;
      continue;
    }

    if (indentFrom >= 0) {
      if (BLANK_RE.test(line)) {
        prevBlank = true;
        i = next;
        continue;
      }
      if (indentWidth(line) >= indentMin) {
        indentTo = end;
        prevBlank = false;
        i = next;
        continue;
      }
      code.push({ from: indentFrom, to: indentTo });
      indentFrom = -1;
    }

    if (BLANK_RE.test(line)) {
      prevBlank = true;
      i = next;
      continue;
    }

    const ind = indentWidth(line);
    const threshold = (listIndent >= 0 ? listIndent : 0) + INDENT_CODE;

    // An indented chunk is code only where it could not be a paragraph
    // continuation, which is what the preceding blank line establishes. The
    // list offset keeps continuation paragraphs of a list item, which sit four
    // or more columns in after a blank line, from being read as code and
    // silently dropping the citations they carry.
    if (prevBlank && ind >= threshold) {
      indentFrom = i;
      indentTo = end;
      indentMin = threshold;
      prevBlank = false;
      i = next;
      continue;
    }

    const open = ind <= 3 ? FENCE_OPEN_RE.exec(line) : null;
    // A backtick fence may not carry a backtick in its info string; that line
    // is a paragraph holding a code span, not a fence.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fenceFrom = i;
      fenceChar = open[1][0];
      fenceLen = open[1].length;
      fenceMarkers = [];
      prevBlank = false;
      i = next;
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      const markerEnd = columnWidth(item[1] + item[2]);
      const gap = columnWidth(item[1] + item[2] + item[3]) - markerEnd;
      listIndent = gap > 0 && gap <= INDENT_CODE ? markerEnd + gap : markerEnd + 1;
    } else if (ind === 0 && prevBlank) {
      listIndent = -1;
    }

    const spans = [];
    scanInlineSpans(body, i, end, spans);
    for (const span of spans) code.push(span);
    collectMarkers(line, i, spans, markers);

    prevBlank = false;
    i = next;
  }

  if (fenceFrom >= 0) {
    code.push({ from: fenceFrom, to: n });
    for (const m of fenceMarkers) markers.push(m);
  } else if (indentFrom >= 0) {
    code.push({ from: indentFrom, to: indentTo });
  }

  return { code, markers };
}

// Pairs marker occurrences into complete blocks and strays in one forward pass.
//
// An END pairs with the nearest preceding unconsumed START, so a stray earlier
// START never swallows the text between them: that START is demoted to a stray
// and only its own 35 bytes are removed. The result is that `removals` is
// always sorted and disjoint, which is what lets the edit be applied in a
// single pass.
function pairMarkers(markers) {
  const removals = [];
  const blocks = [];
  let pending = null;
  for (const m of markers) {
    if (m.type === 'start') {
      if (pending) removals.push({ from: pending.from, to: pending.to });
      pending = m;
      continue;
    }
    if (pending) {
      const block = { from: pending.from, to: m.to };
      blocks.push(block);
      removals.push(block);
      pending = null;
      continue;
    }
    removals.push({ from: m.from, to: m.to });
  }
  if (pending) removals.push({ from: pending.from, to: pending.to });
  return { removals, blocks };
}

// Excises each range and also consumes the newline separating it from the
// preceding line, so a body of `a\n<block>` round-trips to `a` rather than
// `a\n`. Without that, every run would differ from the last by one trailing
// newline and the zero-write idempotency guarantee would never hold.
//
// A CRLF pair keeps its `\r` on the preceding line for exactly that reason:
// `a\r\n<block>` strips to `a\r`, and re-appending `\n<block>` reproduces the
// input byte for byte. Only where there is nothing to consume backwards does a
// forward line terminator get taken, and there it is taken whole so a bare
// `\r` body does not accumulate blank lines.
//
// `cursor` is the end of the previous excision. It stops a range whose
// predecessor already consumed the separating newline from consuming it twice.
function removeRanges(body, ranges) {
  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    let a = r.from;
    let b = r.to;
    if (a > cursor && (body[a - 1] === '\n' || body[a - 1] === '\r')) {
      a -= 1;
    } else if (body[b] === '\n') {
      b += 1;
    } else if (body[b] === '\r') {
      b += 1;
      if (body[b] === '\n') b += 1;
    }
    out += body.slice(cursor, a);
    cursor = b;
  }
  return out + body.slice(cursor);
}

// Total with respect to markers: every complete block outside code is removed,
// and so is every stray marker outside code. Markers inside code are left
// exactly where they are, because an entry that documents the block format is
// quoting it, not carrying it.
//
// Both halves matter. Leaving a second complete block behind made applyBacklinks
// stabilise with duplicates and let the second block's machine written
// `- [[id]]` lines read back as real outbound citations. Leaving a stray marker
// behind made applyBacklinks append a fresh block after it on every run: the
// entry was rewritten and grew by roughly 105 bytes a night, forever.
export function stripManagedBlock(body) {
  const { markers } = scan(body);
  if (markers.length === 0) return body;
  return removeRanges(body, pairMarkers(markers).removals);
}

// Strips markdown code (fenced blocks, indented blocks, inline spans) so
// parseLinks never reads a `[[wikilink]]` written as prose about the syntax
// itself as a real citation. Each region collapses to a single space rather
// than being deleted, so text either side of it is never joined into something
// that reads as one token. Exported so the classification can be tested
// directly, independent of the managed-block handling it runs alongside.
export function stripCode(body) {
  const { code } = scan(body);
  if (code.length === 0) return body;
  let out = '';
  let cursor = 0;
  for (const r of code) {
    out += body.slice(cursor, r.from) + ' ';
    cursor = r.to;
  }
  return out + body.slice(cursor);
}

// Merges two already sorted range lists into one sorted, coalesced list.
function mergeRanges(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const takeA = j >= b.length || (i < a.length && a[i].from <= b[j].from);
    const r = takeA ? a[i++] : b[j++];
    const last = out.length ? out[out.length - 1] : null;
    if (last && r.from <= last.to) {
      if (r.to > last.to) last.to = r.to;
    } else {
      out.push({ from: r.from, to: r.to });
    }
  }
  return out;
}

export function parseLinks(body) {
  const { code, markers } = scan(body);
  const excluded = mergeRanges(code, pairMarkers(markers).blocks);
  const seen = new Set();
  const out = [];
  // The character class excludes newlines as well as `]`: an unmatched `[[`
  // would otherwise run across lines and capture a multi-line target, which
  // would mint a stub with a garbage multi-line id.
  const re = /\[\[([^\]\n]+)\]\]/g;
  let cursor = 0;
  const take = (from, to) => {
    if (to <= from) return;
    for (const m of body.slice(from, to).matchAll(re)) {
      const target = m[1].trim();
      if (!target || seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
  };
  for (const r of excluded) {
    take(cursor, r.from);
    cursor = r.to;
  }
  take(cursor, body.length);
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
