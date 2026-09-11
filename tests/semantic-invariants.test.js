import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Redis from 'ioredis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { indexEntry } from '../semantic/index.js';
import { getChunks } from '../semantic/chunkstore.js';
import { embedQuery, MODEL_ID } from '../semantic/embedder.js';
import { bestChunk, keywordScore } from '../semantic/rank.js';
import { BACKLINK_START, BACKLINK_END } from '../compact/graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALKEY = 'redis://127.0.0.1:6379/5';
// Its own port: the suite runs test files concurrently and 3107 and 3131 are
// already taken by server.test.js and semantic-server.test.js.
const PORT = 3141;

let redis;
let proc;
let client;

async function waitForHealth(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server on ${port} never became healthy`);
}

const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

beforeAll(async () => {
  redis = new Redis(VALKEY);
  if (redis.options.db !== 5) {
    throw new Error(`refusing to run: expected db 5, ioredis reports db ${redis.options.db}`);
  }
  await redis.flushdb();
  // One of the invariants below is about the shape of a search response, which
  // only the server builds, so this file drives a real server for that test.
  proc = spawn(process.execPath, [join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), VALKEY_URL: VALKEY }, stdio: 'pipe',
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  await waitForHealth(PORT);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
}, 60000);

afterAll(async () => {
  await client?.close?.();
  await redis.flushdb();
  await redis.quit();
  proc?.kill('SIGTERM');
});

beforeEach(async () => { await redis.flushdb(); });

describe('invariants', () => {
  it('no chunk anywhere contains generated backlink text', async () => {
    const body = `prose\n${BACKLINK_START}\n## Referenced by\n- [[a]]\n- [[b]]\n${BACKLINK_END}\nmore prose`;
    await indexEntry(redis, 'e', { title: 'T', body, ttl: null });
    for (const c of await getChunks(redis, 'e')) {
      expect(c.text).not.toContain('Referenced by');
      expect(c.text).not.toMatch(/\[\[/);
    }
  }, 120000);

  it('chunks expire with a tombstoned parent', async () => {
    await indexEntry(redis, 'e', { title: 'T', body: 'prose', ttl: 2592000 });
    for (const k of await redis.keys('memchunk:e:*')) {
      const ttl = await redis.ttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(2592000);
    }
  }, 120000);

  it('every chunk records the model that produced it', async () => {
    await indexEntry(redis, 'e', { title: 'T', body: 'prose', ttl: null });
    for (const c of await getChunks(redis, 'e')) expect(c.model).toBe(MODEL_ID);
  }, 120000);

  it('rewriting an entry leaves no orphan chunks', async () => {
    await indexEntry(redis, 'e', { title: 'T', body: 'x'.repeat(6000), ttl: null });
    const many = (await redis.keys('memchunk:e:*')).length;
    expect(many).toBeGreaterThan(1);
    await indexEntry(redis, 'e', { title: 'T', body: 'short', ttl: null });
    expect((await redis.keys('memchunk:e:*')).length).toBe(1);
    expect(await redis.scard('memchunks:e')).toBe(1);
  }, 120000);

  it('a failing embedder never throws and always records the entry', async () => {
    const boom = { embedPassages: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(indexEntry(redis, 'e', { title: 'T', body: 'p', ttl: null }, boom)).resolves.toBeTruthy();
    expect(await redis.sismember('memdirty', 'e')).toBe(1);
  });

  // A bare cosine threshold cannot express this property. Measured against
  // this model, three unrelated queries scored 0.24, 0.36 and 0.40 against the
  // tombstones body below, so any absolute floor low enough to pass on a real
  // paraphrase also passes on noise, and the floor itself moves with the model
  // and the corpus. Retrieval's job is to ORDER: put the entry the question is
  // about ahead of entries it is not about, even when the question shares no
  // vocabulary with it at all. So rank a corpus and assert positions.
  const PARAPHRASE = 'how does junk get removed without destroying it';

  const CORPUS = [
    // The intended answer. It shares not one content word with the question:
    // junk/removed/destroying against exhaust/retired/deleted. Keyword scoring
    // gives it exactly zero and cannot rank it at all.
    {
      id: 'tombstones',
      title: 'Tombstones',
      body: 'Uncited machine exhaust is retired with a reversible thirty day expiry rather than deleted.',
    },
    // The entry a keyword search prefers. It is the only one carrying every
    // word of the question, so keywordScore puts it top, and it is a farm diary
    // that answers nothing.
    {
      id: 'farm-diary',
      title: 'Farm diary',
      body: [
        'Saturday, clear and cold. Started on the west fence line at first light and worked south until the',
        'coffee ran out. The heifers moved through the chute quietly for once. Ordered a new chain for the',
        'saw and a box of gaskets. The neighbour asked how the old stone wall does so well in frost; I said',
        'the lime mortar breathes. Later we argued about whether a hedge should get cut back in autumn or',
        'spring. The tin roof on the lean-to was removed last year and never replaced, so the hay gets wet',
        'without much warning. There is a pile of junk behind the barn that the scrap man will take in May.',
        'The wind keeps destroying the plastic sheeting over the woodpile, so I weighted it with bricks.',
        'Supper was late. Rain forecast Tuesday, then a hard frost through to the weekend, they reckon.',
      ].join(' '),
    },
    // Unrelated, and deliberately built in the question's own shape. These are
    // the hard distractors: without the query-side instruction prefix the query
    // is embedded as a passage rather than as a query, question-shaped text
    // starts matching on form, and both of these overtake the real answer.
    { id: 'coats', title: 'Coats', body: 'How does a coat get proofed without stiffening it?' },
    { id: 'mugs', title: 'Mugs', body: 'How does a mug get glued without staining it?' },
    // Plainly unrelated, sharing neither topic nor shape.
    { id: 'sourdough', title: 'Sourdough', body: 'A sourdough starter needs feeding twice a day at room temperature to stay lively.' },
    { id: 'payroll', title: 'Payroll cutoff', body: 'Timesheets close on the fifteenth so the finance team can run payroll before month end.' },
  ];

  it('retrieval beats keyword on a paraphrase', async () => {
    for (const e of CORPUS) {
      await indexEntry(redis, e.id, { title: e.title, body: e.body, ttl: null });
    }

    const q = await embedQuery(PARAPHRASE);
    const ranked = [];
    for (const e of CORPUS) {
      const best = bestChunk(q, await getChunks(redis, e.id));
      ranked.push({ id: e.id, score: best.score });
    }
    ranked.sort((a, b) => b.score - a.score);
    const order = ranked.map((r) => r.id);
    const rank = (id) => order.indexOf(id);

    // Keyword scoring alone gets this backwards, which is what makes the
    // ordering below a claim about retrieval rather than about wording.
    const kw = (e) => keywordScore(PARAPHRASE, e.title, e.body, e.id);
    const target = CORPUS.find((e) => e.id === 'tombstones');
    const keywordPick = CORPUS.find((e) => e.id === 'farm-diary');
    expect(kw(target)).toBe(0);
    expect(kw(keywordPick)).toBeGreaterThan(kw(target));

    // Position, not membership, and not a bare score.
    expect(order[0]).toBe('tombstones');
    for (const id of ['farm-diary', 'coats', 'mugs', 'sourdough', 'payroll']) {
      expect(rank('tombstones')).toBeLessThan(rank(id));
    }
  }, 300000);

  // The offsets on a search hit are computed against the stripped body the
  // chunker saw, not the raw body. Translating them back into raw coordinates
  // is impossible for a chunk that spans the removed block, since that chunk is
  // text from both sides joined together and is not a substring of the raw body
  // at any offset pair. So the response names the field its offsets index into
  // and returns that field, and this checks the naming holds wherever the block
  // sits. Compaction only ever appends at the tail today, which is exactly why
  // head and middle went untested and unnoticed.
  const PROSE_A = 'Backfill drains the dirty set in batches and re-embeds each entry it takes. '.repeat(16);
  const PROSE_B = 'Rollback restores an earlier revision and the chunks are rebuilt from that body. '.repeat(16);
  const BLOCK = `${BACKLINK_START}\n## Referenced by\n- [[alpha]]\n- [[beta]]\n${BACKLINK_END}`;

  const PLACEMENTS = [
    { id: 'block-head', where: 'head', body: `${BLOCK}\n${PROSE_A}` },
    { id: 'block-middle', where: 'middle', body: `${PROSE_A}\n${BLOCK}\n${PROSE_B}` },
    { id: 'block-tail', where: 'tail', body: `${PROSE_A}\n${BLOCK}` },
    { id: 'block-absent', where: 'none', body: PROSE_A },
  ];

  it('a search hit excerpt is verifiable against the body the response names', async () => {
    for (const p of PLACEMENTS) {
      await call('memory_set', {
        id: p.id, title: 'Chunk offsets', body: p.body, type: 'reference', tags: ['offsets'],
      });
    }

    const out = await call('memory_search', {
      tags: ['offsets'], query: 'what happens to embeddings when an entry is rewritten', limit: 10,
    });

    for (const p of PLACEMENTS) {
      const hit = out.results.find((r) => r.id === p.id);
      expect(hit, `no hit for ${p.where}`).toBeDefined();
      expect(hit.excerpt, `no excerpt for ${p.where}`).toBeTruthy();
      expect(hit.chunkRange.source, `unnamed coordinate space for ${p.where}`).toBeTruthy();

      // The whole contract, in one line a caller can run.
      const named = hit[hit.chunkRange.source];
      expect(named, `${p.where} names a field it does not return`).toBeTypeOf('string');
      expect(
        named.slice(hit.chunkRange.start, hit.chunkRange.end),
        `excerpt not at its offsets for a ${p.where} block`,
      ).toBe(hit.excerpt);

      // No generated link text reaches the excerpt or the string it indexes.
      expect(hit.excerpt).not.toContain('Referenced by');
      expect(named).not.toContain('Referenced by');
    }

    // An entry with no managed block carries no second copy of its body: the
    // offsets already index into the body the response returns.
    const plain = out.results.find((r) => r.id === 'block-absent');
    expect(plain.chunkRange.source).toBe('body');
    expect(plain).not.toHaveProperty('indexedBody');

    // Every other placement must say so rather than pointing at `body`, which
    // is the raw string the offsets do not index into.
    for (const p of PLACEMENTS.filter((x) => x.where !== 'none')) {
      const hit = out.results.find((r) => r.id === p.id);
      expect(hit.chunkRange.source, `${p.where} should not claim raw body coordinates`).toBe('indexedBody');
    }
  }, 300000);
});
