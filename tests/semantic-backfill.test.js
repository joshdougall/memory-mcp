import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { backfill } from '../scripts/backfill-embeddings.js';
import { getChunks, markDirty } from '../semantic/chunkstore.js';
import { MODEL_ID } from '../semantic/embedder.js';

let redis;
beforeAll(() => { redis = new Redis('redis://127.0.0.1:6379/6'); });
afterAll(async () => { await redis.flushdb(); await redis.quit(); });
beforeEach(async () => { await redis.flushdb(); });

const seed = async (id, body) => {
  await redis.hset(`mem:${id}`, { title: id, body, type: 'reference', tags: '', source: 't', project: '', created: '2026-09-11', updated: '2026-09-11', hits: '0', ttl: '' });
};

describe('backfill', () => {
  it('indexes every entry that has none', async () => {
    await seed('a', 'the first entry about databases');
    await seed('b', 'the second entry about vehicles');
    const out = await backfill(redis, {});
    expect(out.indexed).toBe(2);
    expect((await getChunks(redis, 'a')).length).toBeGreaterThan(0);
  }, 180000);

  it('is idempotent: a second run indexes nothing', async () => {
    await seed('a', 'content');
    await backfill(redis, {});
    const second = await backfill(redis, {});
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
  }, 180000);

  it('drains the dirty set when asked', async () => {
    await seed('a', 'content');
    await backfill(redis, {});
    await markDirty(redis, 'a');
    const out = await backfill(redis, { onlyDirty: true });
    expect(out.indexed).toBe(1);
    expect(await redis.scard('memdirty')).toBe(0);
  }, 180000);

  it('does not abort the run when one entry fails, and records it for retry', async () => {
    await seed('good', 'an entry that embeds fine');
    await seed('bad', 'an entry whose embedding will fail');

    const realEmbedder = await import('../semantic/embedder.js');
    const flakyEmbedder = {
      ...realEmbedder,
      embedPassages: async (texts) => {
        if (texts.some((t) => t.includes('will fail'))) {
          throw new Error('simulated embedding failure');
        }
        return realEmbedder.embedPassages(texts);
      },
    };

    const out = await backfill(redis, { embedder: flakyEmbedder });

    expect(out.indexed).toBe(1);
    expect(out.skipped).toBe(1);
    expect((await getChunks(redis, 'good')).length).toBeGreaterThan(0);
    expect((await getChunks(redis, 'bad')).length).toBe(0);
    // The failed entry is recorded so it gets retried, not lost.
    expect(await redis.sismember('memdirty', 'bad')).toBe(1);
  }, 180000);

  it('re-embeds chunks stored under a stale model instead of skipping them forever', async () => {
    await seed('a', 'content that was indexed under an old model');
    await backfill(redis, {});

    // Simulate a previous model version by rewriting the stored chunk's
    // model marker directly, bypassing indexEntry.
    const keys = await redis.smembers('memchunks:a');
    for (const k of keys) {
      await redis.hset(k, 'model', 'some-old-model-id');
    }
    const stale = await getChunks(redis, 'a');
    expect(stale.every((c) => c.model !== MODEL_ID)).toBe(true);

    const out = await backfill(redis, {});
    expect(out.indexed).toBe(1);
    expect(out.skipped).toBe(0);
    const fresh = await getChunks(redis, 'a');
    expect(fresh.every((c) => c.model === MODEL_ID)).toBe(true);
  }, 180000);
});
