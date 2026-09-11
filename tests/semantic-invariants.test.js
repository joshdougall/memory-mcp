import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Redis from 'ioredis';
import { indexEntry } from '../semantic/index.js';
import { getChunks } from '../semantic/chunkstore.js';
import { embedQuery, MODEL_ID } from '../semantic/embedder.js';
import { bestChunk } from '../semantic/rank.js';
import { BACKLINK_START, BACKLINK_END } from '../compact/graph.js';

let redis;
beforeAll(() => { redis = new Redis('redis://127.0.0.1:6379/5'); });
afterAll(async () => { await redis.flushdb(); await redis.quit(); });
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

  it('retrieval beats keyword on a paraphrase', async () => {
    await indexEntry(redis, 'e', {
      title: 'Tombstones',
      body: 'Uncited machine exhaust is retired with a reversible thirty day expiry rather than deleted.',
      ttl: null,
    });
    const q = await embedQuery('how does junk get removed without destroying it');
    const best = bestChunk(q, await getChunks(redis, 'e'));
    expect(best.score).toBeGreaterThan(0.3);
  }, 120000);
});
