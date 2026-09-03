import { describe, it, expect } from 'vitest';
import { stripManagedBlock, stripCode, parseLinks, BACKLINK_START, BACKLINK_END } from '../compact/graph.js';

describe('marker constants', () => {
  it('BACKLINK_START has the correct literal value', () => {
    expect(BACKLINK_START).toBe('<!-- compaction:backlinks:start -->');
  });

  it('BACKLINK_END has the correct literal value', () => {
    expect(BACKLINK_END).toBe('<!-- compaction:backlinks:end -->');
  });
});

describe('stripManagedBlock', () => {
  it('removes the managed region and leaves the rest intact', () => {
    const body = `before\n${BACKLINK_START}\n## Referenced by\n- [[a]]\n${BACKLINK_END}\nafter`;
    expect(stripManagedBlock(body)).toBe('before\nafter');
  });

  it('returns the body unchanged when there is no block', () => {
    expect(stripManagedBlock('plain body')).toBe('plain body');
  });

  it('removes a block that is the entire body', () => {
    expect(stripManagedBlock(`${BACKLINK_START}\nx\n${BACKLINK_END}`)).toBe('');
  });

  // Previously asserted that only the FIRST block was removed, which certified
  // the duplicate-block bug as correct: parseLinks then read the second block's
  // machine written `- [[id]]` lines as real outbound citations, and
  // applyBacklinks stabilised with two blocks instead of one.
  it('removes every complete block when markers repeat', () => {
    const body = `${BACKLINK_START}\nx\n${BACKLINK_END}\nmid\n${BACKLINK_START}\ny\n${BACKLINK_END}`;
    const out = stripManagedBlock(body);
    expect(out).toBe('mid');
    expect(out).not.toContain(BACKLINK_START);
    expect(out).not.toContain(BACKLINK_END);
  });

  it('reads no citations out of a second complete block', () => {
    const body = `real [[keep]]\n${BACKLINK_START}\n- [[gen-a]]\n${BACKLINK_END}`
      + `\n${BACKLINK_START}\n- [[gen-b]]\n${BACKLINK_END}`;
    expect(parseLinks(body)).toEqual(['keep']);
  });

  it('reaches a fixed point in one application when blocks repeat', () => {
    const body = `${BACKLINK_START}\nx\n${BACKLINK_END}\nmid\n${BACKLINK_START}\ny\n${BACKLINK_END}`;
    const once = stripManagedBlock(body);
    expect(stripManagedBlock(once)).toBe(once);
  });

  it('removes a lone start marker when no complete block is present', () => {
    const body = `text\n${BACKLINK_START}\nmore text`;
    expect(stripManagedBlock(body)).toBe('text\nmore text');
  });

  // Previously asserted that the body came back unchanged, which certified the
  // orphan-end bug as correct: applyBacklinks then appended a fresh block after
  // the surviving marker on every run and the entry grew forever.
  it('removes a lone end marker when no complete block is present', () => {
    const body = `text\n${BACKLINK_END}\nmore text`;
    expect(stripManagedBlock(body)).toBe('text\nmore text');
  });

  it('removes every stray marker when the body holds no complete block', () => {
    const body = `a\n${BACKLINK_END}\nb\n${BACKLINK_START}\nc`;
    const out = stripManagedBlock(body);
    expect(out).toBe('a\nb\nc');
    expect(out).not.toContain(BACKLINK_START);
    expect(out).not.toContain(BACKLINK_END);
  });

  // The END pairs with the NEAREST preceding start, so the text between the two
  // starts is never swallowed. The earlier start is a stray and only its own
  // bytes go: leaving it behind is what made applyBacklinks append a second
  // block on the next run.
  it('removes the complete block and the dangling start that precedes it, keeping the text between', () => {
    const body = `${BACKLINK_START}\nstray\n${BACKLINK_START}\nx\n${BACKLINK_END}`;
    const out = stripManagedBlock(body);
    expect(out).toBe('stray');
    expect(out).not.toContain(BACKLINK_START);
    expect(out).not.toContain(BACKLINK_END);
  });
});

describe('stripCode', () => {
  it('replaces an inline code span with a single space', () => {
    expect(stripCode('before `[[x]]` after')).toBe('before   after');
  });

  it('replaces a multi-backtick inline span, ignoring single backticks inside it', () => {
    expect(stripCode('a ``[[x]]`` b')).toBe('a   b');
  });

  it('replaces a fenced block delimited by backticks', () => {
    const body = '```\n[[x]]\n```\nafter';
    expect(stripCode(body)).toBe(' \nafter');
  });

  it('replaces a fenced block delimited by tildes', () => {
    const body = '~~~\n[[x]]\n~~~\nafter';
    expect(stripCode(body)).toBe(' \nafter');
  });

  it('ignores a language label on the opening fence', () => {
    const body = '```js\n[[x]]\n```\nafter';
    expect(stripCode(body)).toBe(' \nafter');
  });

  it('treats an unclosed fence as consuming the rest of the body', () => {
    const body = 'before\n```\n[[x]]\nmore [[y]]';
    expect(stripCode(body)).toBe('before\n ');
  });

  it('leaves a run of backticks with no matching close as literal text', () => {
    expect(stripCode('a `` b')).toBe('a `` b');
  });

  it('does not fabricate a bracket pair by joining fragments either side of a span', () => {
    // Deleting the span outright would turn "[" + "[real]]" into "[[real]]".
    // Replacing with a space must not.
    expect(stripCode('[`x`[real]]')).toBe('[ [real]]');
  });

  it('leaves plain prose with no code untouched', () => {
    expect(stripCode('see [[foo]] and [[bar]]')).toBe('see [[foo]] and [[bar]]');
  });
});

describe('parseLinks', () => {
  it('extracts wikilink targets', () => {
    expect(parseLinks('see [[foo]] and [[bar]]')).toEqual(['foo', 'bar']);
  });

  it('deduplicates and preserves first-seen order', () => {
    expect(parseLinks('[[b]] [[a]] [[b]]')).toEqual(['b', 'a']);
  });

  it('ignores links inside a managed block', () => {
    const body = `real [[keep]]\n${BACKLINK_START}\n- [[generated]]\n${BACKLINK_END}`;
    expect(parseLinks(body)).toEqual(['keep']);
  });

  it('returns an empty array for an empty body', () => {
    expect(parseLinks('')).toEqual([]);
  });

  it('extracts links from a body with only a start marker (no end marker)', () => {
    const body = `${BACKLINK_START}\n[[should-be-extracted]]`;
    expect(parseLinks(body)).toEqual(['should-be-extracted']);
  });

  it('extracts links from a body with only an end marker (no start marker)', () => {
    const body = `[[should-be-extracted]]\n${BACKLINK_END}`;
    expect(parseLinks(body)).toEqual(['should-be-extracted']);
  });

  // The invariant the orphan-end bug broke: once a block has been appended
  // after a stray end marker, its `- [[id]]` lines are machine written and must
  // never be read back as outbound citations from this entry.
  it('reads no citations from block text that follows an orphan end marker', () => {
    const body = `plain\n${BACKLINK_END}\n${BACKLINK_START}\n## Referenced by\n- [[a]]\n- [[b]]\n${BACKLINK_END}`;
    expect(parseLinks(body)).toEqual([]);
  });

  it('does not capture a link target across a newline', () => {
    expect(parseLinks('[[unclosed\nnext line [[real]]')).toEqual(['real']);
  });

  // The real defect: a dry run against the live store proposed creating an
  // entry with id `wikilink`, sourced from personnel-privacy-rule's prose
  // about the syntax itself, wrapped in backticks as inline code.
  it('ignores a wikilink written as inline code, alongside a genuine one', () => {
    const body = 'so a `[[wikilink]]` in an artifact comment is an inert '
      + 'string to a run and cannot be followed, see [[personnel-privacy-rule]] for the policy';
    expect(parseLinks(body)).toEqual(['personnel-privacy-rule']);
  });

  it('ignores wikilinks inside a fenced code block, keeping a genuine one outside it', () => {
    const body = 'real [[keep]]\n```\n[[fenced-one]]\n[[fenced-two]]\n```\nafter';
    expect(parseLinks(body)).toEqual(['keep']);
  });

  it('ignores wikilinks inside a tilde-fenced code block', () => {
    const body = 'real [[keep]]\n~~~\n[[fenced]]\n~~~';
    expect(parseLinks(body)).toEqual(['keep']);
  });

  it('ignores wikilinks inside a fenced block carrying a language label', () => {
    const body = 'real [[keep]]\n```js\nconst x = "[[fenced]]";\n```';
    expect(parseLinks(body)).toEqual(['keep']);
  });

  it('ignores everything after an unclosed fence, including a genuine-looking link', () => {
    const body = 'real [[keep]]\n```\n[[fenced]]\nmore text [[after-fence]]';
    expect(parseLinks(body)).toEqual(['keep']);
  });

  it('ignores a multi-backtick inline span', () => {
    expect(parseLinks('see ``[[x]]`` and [[keep]]')).toEqual(['keep']);
  });

  it('does not fabricate a link from fragments left either side of a stripped code span', () => {
    expect(parseLinks('[`x`[real]] and [[keep]]')).toEqual(['keep']);
  });
});

import { buildGraph } from '../compact/graph.js';

function entry(id, body = '', over = {}) {
  return { id, title: id, body, type: 'reference', tags: [], source: 'test',
           project: '', created: '2026-08-01', updated: '2026-08-01', hits: 0, ttl: '', ...over };
}

describe('buildGraph', () => {
  it('records inbound citations for existing targets', () => {
    const g = buildGraph([entry('a', 'see [[b]]'), entry('b')]);
    expect([...g.inbound.get('b')]).toEqual(['a']);
    expect(g.inbound.has('a')).toBe(false);
  });

  it('records dangling targets separately', () => {
    const g = buildGraph([entry('a', 'see [[ghost]]')]);
    expect([...g.dangling.get('ghost')]).toEqual(['a']);
    expect(g.inbound.has('ghost')).toBe(false);
  });

  it('counts a TTL-bearing entry as a citation source', () => {
    const g = buildGraph([entry('a', 'see [[b]]', { ttl: '2592000' }), entry('b')]);
    expect([...g.inbound.get('b')]).toEqual(['a']);
  });

  it('does not count links inside a managed block', () => {
    const body = `<!-- compaction:backlinks:start -->\n- [[b]]\n<!-- compaction:backlinks:end -->`;
    const g = buildGraph([entry('a', body), entry('b')]);
    expect(g.inbound.has('b')).toBe(false);
  });

  it('ignores an entry citing itself', () => {
    const g = buildGraph([entry('a', 'see [[a]]')]);
    expect(g.inbound.has('a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The five defects the single-pass scanner was written to close. Each one is
// reproducible against the previous implementation.
// ---------------------------------------------------------------------------

const fence = (...lines) => ['```', ...lines, '```'].join('\n');

describe('markers inside code are inert', () => {
  // Defect 2. The old strip took the FIRST complete pair of markers it found,
  // which in a body that documents the block format is the quoted sample. The
  // user's documentation was deleted, the real block survived, and its machine
  // written `- [[id]]` lines then read back as outbound citations.
  it('removes the real block and preserves a complete block quoted in a fenced sample', () => {
    const sample = fence(BACKLINK_START, '## Referenced by', '- [[example]]', BACKLINK_END);
    const body = `docs\n${sample}\nprose [[cited]]\n`
      + `${BACKLINK_START}\n## Referenced by\n- [[a]]\n- [[b]]\n${BACKLINK_END}`;
    expect(stripManagedBlock(body)).toBe(`docs\n${sample}\nprose [[cited]]`);
  });

  it('reads citations from prose only, not from a quoted sample or the real block', () => {
    const sample = fence(BACKLINK_START, '- [[example]]', BACKLINK_END);
    const body = `docs\n${sample}\nprose [[cited]]\n`
      + `${BACKLINK_START}\n- [[a]]\n${BACKLINK_END}`;
    expect(parseLinks(body)).toEqual(['cited']);
  });

  it('preserves a marker quoted in an inline code span', () => {
    const body = `the block opens with \`${BACKLINK_START}\` and closes with \`${BACKLINK_END}\``;
    expect(stripManagedBlock(body)).toBe(body);
  });

  it('preserves markers inside an indented code block', () => {
    const body = `docs\n\n    ${BACKLINK_START}\n    ${BACKLINK_END}\n\nafter`;
    expect(stripManagedBlock(body)).toBe(body);
  });

  it('still removes a real block that follows a quoted one', () => {
    const body = `\`${BACKLINK_START}\`\n${BACKLINK_START}\nx\n${BACKLINK_END}`;
    expect(stripManagedBlock(body)).toBe(`\`${BACKLINK_START}\``);
  });
});

describe('carriage returns', () => {
  // Defect 3. Splitting on \n left the \r on the closing fence, the close test
  // rejected it, and the fence swallowed the rest of the body. A real citation
  // hidden that way makes a cited entry look uncited and starts its 30 day
  // retirement with no human flag.
  it('closes a CRLF fence and reads the citation that follows it', () => {
    const body = 'intro\r\n```\r\n[[hidden]]\r\n```\r\n[[real-after]]';
    expect(parseLinks(body)).toEqual(['real-after']);
  });

  it('closes a bare CR fence and reads the citation that follows it', () => {
    const body = 'intro\r```\r[[hidden]]\r```\r[[real-after]]';
    expect(parseLinks(body)).toEqual(['real-after']);
  });

  it('strips a managed block written with CRLF separators', () => {
    const body = `a\r\n${BACKLINK_START}\r\n- [[x]]\r\n${BACKLINK_END}`;
    expect(stripManagedBlock(body)).toBe('a\r');
  });

  it('round trips a CRLF body byte exactly', () => {
    // What applyBacklinks does: strip, then join the bare body to a fresh block
    // with a single \n. The \r stays on the bare body, so run two reproduces
    // run one byte for byte and the entry is never rewritten.
    const block = `${BACKLINK_START}\n## Referenced by\n- [[a]]\n- [[b]]\n${BACKLINK_END}`;
    const applied = `a\r\n${block}`;
    expect(`${stripManagedBlock(applied)}\n${block}`).toBe(applied);
  });

  it('does not read a citation out of an unclosed CRLF fence', () => {
    expect(parseLinks('[[keep]]\r\n```\r\n[[hidden]]\r\nmore [[also-hidden]]')).toEqual(['keep']);
  });
});

describe('indented code', () => {
  // Defect 4. Four-space indented code was parsed for citations, which minted
  // stubs for ids that only ever existed inside a code sample.
  it('ignores wikilinks in a four-space indented block', () => {
    expect(parseLinks('prose [[keep]]\n\n    see [[indented]]\n\nafter')).toEqual(['keep']);
  });

  it('ignores wikilinks in a tab indented block', () => {
    expect(parseLinks('prose [[keep]]\n\n\tsee [[indented]]\n\nafter')).toEqual(['keep']);
  });

  it('ignores an indented block that ends the body', () => {
    expect(parseLinks('prose [[keep]]\n\n    [[indented]]')).toEqual(['keep']);
  });

  // An indented chunk cannot interrupt a paragraph, so this is prose, not code.
  it('still reads a wikilink from an indented paragraph continuation', () => {
    expect(parseLinks('prose\n    continued [[keep]]')).toEqual(['keep']);
  });

  // A continuation paragraph of a list item sits four or more columns in after
  // a blank line. Reading it as code would silently drop a real citation.
  it('still reads a wikilink from a continuation paragraph of a list item', () => {
    expect(parseLinks('- item\n\n    continued [[keep]]')).toEqual(['keep']);
  });

  it('reads code indented past a list item as code', () => {
    expect(parseLinks('- item\n\n        [[sample]]\n\nprose [[keep]]')).toEqual(['keep']);
  });
});

describe('pathological marker input', () => {
  // Defect 5. Each stray marker used to trigger another full search and string
  // copy. Graph construction runs synchronously between deadline checks, so a
  // large enough malformed body could run past the 600s budget and be killed by
  // systemd, bypassing the script's classified exit code.
  it('strips 128k stray markers in linear time', () => {
    const body = `${BACKLINK_START}\n`.repeat(128000) + 'tail [[keep]]';
    const t0 = performance.now();
    const out = stripManagedBlock(body);
    const ms = performance.now() - t0;
    expect(out).toBe('tail [[keep]]');
    // The quadratic implementation needed more than 14s for this input.
    expect(ms).toBeLessThan(3000);
  });

  it('parses links out of a body of 128k stray markers in linear time', () => {
    const body = `${BACKLINK_END}\n`.repeat(128000) + 'tail [[keep]]';
    const t0 = performance.now();
    expect(parseLinks(body)).toEqual(['keep']);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('scanner properties', () => {
  it('never removes text that sits inside a code region', () => {
    const body = `a\n${fence(BACKLINK_START, 'keep me', BACKLINK_END)}\n`
      + `b \`${BACKLINK_END}\` c\n${BACKLINK_START}\nz\n${BACKLINK_END}`;
    const out = stripManagedBlock(body);
    expect(out).toContain('keep me');
    expect(out).toContain(`\`${BACKLINK_END}\``);
    expect(out).toContain(fence(BACKLINK_START, 'keep me', BACKLINK_END));
    expect(out).not.toContain('\nz\n');
  });

  it('is a fixed point after one application for every marker arrangement', () => {
    const parts = ['x', BACKLINK_START, BACKLINK_END, '`' + BACKLINK_START + '`', '[[l]]'];
    for (const a of parts) {
      for (const b of parts) {
        for (const c of parts) {
          const once = stripManagedBlock(`${a}\n${b}\n${c}`);
          expect(stripManagedBlock(once)).toBe(once);
        }
      }
    }
  });

  it('leaves a body with no markers untouched', () => {
    const body = 'plain [[a]]\n\n    indented\n\n```\nfenced\n```\n';
    expect(stripManagedBlock(body)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// F1 and F2. The target class excluded `\n` but not a bare `\r`, even though
// the rest of this file treats a bare `\r` as a line terminator on its own.
// An unmatched `[[` could run across that boundary and, with nothing to bound
// the backtracking, do so in quadratic time.
// ---------------------------------------------------------------------------

describe('F1: bare CR in a wikilink target', () => {
  it('does not swallow a genuine citation across a bare CR after a dangling [[', () => {
    // The buggy class read this as one target, "b\rsee [[real-entry", losing
    // the genuine citation and carrying a raw \r into a would-be stub id.
    expect(parseLinks('a [[ b\rsee [[real-entry]]')).toEqual(['real-entry']);
  });

  it('never returns a target containing a carriage return or newline', () => {
    const bodies = [
      'a [[ b\rsee [[real-entry]]',
      '[[x\ry]] [[a\nb]] [[clean]]',
      'prefix [[one\r\ntwo]] [[also-clean]]',
    ];
    for (const body of bodies) {
      for (const target of parseLinks(body)) {
        expect(target).not.toMatch(/[\r\n]/);
      }
    }
  });
});

describe('F2: quadratic backtracking on a dangling [[ before a bare CR', () => {
  // Defect verified by the reviewer, reproduced with the literal input that
  // exposes it: '[[\r'.repeat(n), with no closing ]] anywhere in the body, so
  // every dangling `[[` fails to match and, with no \n to bound the
  // backtrack, each failure re-scans to the end of the body. Measured on the
  // pre-fix code: 85ms at 8k, 1291ms at 32k, 5128ms at 64k, 20640ms at 128k, a
  // 16x cost for a 4x input, versus low milliseconds at 128k for the fix.
  // (A closing ]] anywhere in the body, e.g. a trailing "tail [[keep]]",
  // gives the very first dangling `[[` one big greedy match all the way to
  // it, which finishes in one pass regardless of the bug: it would not
  // reproduce the quadratic behaviour, so it is deliberately not used here.)
  it('parses 128k repeats of dangling [[\\r in linear, not quadratic, time', () => {
    const n = 128000;
    const body = '[[\r'.repeat(n);
    const t0 = performance.now();
    expect(parseLinks(body)).toEqual([]);
    const ms = performance.now() - t0;
    // The quadratic implementation took over 20s at this size; a linear scan
    // finishes in low milliseconds. 3s leaves comfortable headroom for a
    // loaded CI box while still failing hard on any reintroduced backtrack.
    expect(ms).toBeLessThan(3000);
  });

  it('scales linearly across 8k, 32k and 128k repeats of [[\\r', () => {
    // One warm-up call outside the measured sizes so JIT compilation cost
    // lands here rather than skewing the smallest, otherwise-tiny timing.
    parseLinks('[[\r'.repeat(1000));
    const timings = [8000, 32000, 128000].map((n) => {
      const body = '[[\r'.repeat(n);
      const t0 = performance.now();
      expect(parseLinks(body)).toEqual([]);
      return performance.now() - t0;
    });
    // Quadratic growth would be ~16x from 32k to 128k (4x input, squared).
    // Linear growth stays well under that. A floor on the baseline and a
    // generous multiple keep this from flaking on a noisy box while still
    // catching the O(n^2) shape.
    expect(timings[2]).toBeLessThan(Math.max(timings[1], 2) * 10);
  });

  it('still reads the genuine citation that follows the pathological run, in linear time', () => {
    // The same shape with real content after it: proves the fix is not just
    // fast but still correct once a closing ]] exists further in the body.
    const n = 128000;
    const body = '[[\r'.repeat(n) + 'tail [[keep]]';
    const t0 = performance.now();
    expect(parseLinks(body)).toEqual(['keep']);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// F3. LIST_ITEM_RE matched thematic breaks and setext underlines as list
// items, which raised the indented-code threshold and let a code sample under
// a `---` divider be read as prose.
// ---------------------------------------------------------------------------

describe('F3: thematic breaks and setext underlines are not list items', () => {
  it('does not let a --- divider raise the indented-code threshold, hiding a real code sample', () => {
    const withDivider = 'intro\n\n---\n\n    example [[NOT-A-CITATION]]\n\nprose [[real]]';
    expect(parseLinks(withDivider)).toEqual(['real']);
    // Confirms the --- itself is the cause: removing it changes nothing here,
    // since the indented block is excluded either way once the threshold is
    // no longer raised.
    const withoutDivider = 'intro\n\n    example [[NOT-A-CITATION]]\n\nprose [[real]]';
    expect(parseLinks(withoutDivider)).toEqual(['real']);
  });

  it('treats a *** divider the same as a --- divider', () => {
    const body = 'intro\n\n***\n\n    example [[NOT-A-CITATION]]\n\nprose [[real]]';
    expect(parseLinks(body)).toEqual(['real']);
  });

  it('treats a spaced-out divider (- - -) as a thematic break, not a list item', () => {
    const body = 'intro\n\n- - -\n\n    example [[NOT-A-CITATION]]\n\nprose [[real]]';
    expect(parseLinks(body)).toEqual(['real']);
  });

  it('treats a setext underline (===) the same way', () => {
    const body = 'intro\n\n===\n\n    example [[NOT-A-CITATION]]\n\nprose [[real]]';
    expect(parseLinks(body)).toEqual(['real']);
  });

  it('still reads a genuine dash bullet list item as a list item', () => {
    // Continuation paragraph four columns in after a blank line: read as
    // prose, not code, because it sits inside the list item's own indent.
    expect(parseLinks('- item\n\n    continued [[keep]]')).toEqual(['keep']);
  });

  it('still reads a genuine asterisk bullet list item as a list item', () => {
    expect(parseLinks('* item\n\n   continued [[keep]]')).toEqual(['keep']);
  });

  it('treats a bare dash as no list item, so it does not raise the indented-code threshold', () => {
    // A genuine list item raises the indented-code threshold to marker width
    // plus 4. A bare "-" with no following content must not do that: there is
    // no content to hang a continuation indent against, so the threshold here
    // stays at the plain baseline of 4 and a 5-space indent is still code.
    const body = '-\n\n     example [[should-be-code]]\n\nprose [[keep]]';
    expect(parseLinks(body)).toEqual(['keep']);
  });
});
