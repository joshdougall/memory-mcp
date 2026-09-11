import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import {
  encodeVector, decodeVector, putChunks, getChunks, deleteChunks,
  markDirty, takeDirty, DIRTY_KEY,
} from '../semantic/chunkstore.js';
import { DIMS, MODEL_ID } from '../semantic/embedder.js';

// Tests must NEVER touch db 0: that is the live memory store with ~842 real
// entries. Db 7 is the dedicated test database for this file. Fail closed
// rather than proceed on anything that does not prove which db we are on.
const TEST_DB = 7;

let redis;

beforeAll(async () => {
  redis = new Redis(`redis://127.0.0.1:6379/${TEST_DB}`);
  await redis.select(TEST_DB);
  if (redis.options.db !== TEST_DB) {
    throw new Error(`refusing to run: expected db ${TEST_DB}, ioredis reports db ${redis.options.db}`);
  }
});

afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
});

beforeEach(async () => {
  if (redis.options.db !== TEST_DB) {
    throw new Error(`refusing to flush: expected db ${TEST_DB}, ioredis reports db ${redis.options.db}`);
  }
  await redis.flushdb();
});

const vec = (fill) => Float32Array.from({ length: DIMS }, (_, i) => fill + i / 1000);
const chunksOf = (n) => Array.from({ length: n }, (_, i) => ({
  text: `chunk ${i}`, start: i * 10, end: i * 10 + 9, vector: vec(i),
}));

describe('vector codec', () => {
  it('round-trips a vector exactly', () => {
    const v = vec(0.5);
    const back = decodeVector(encodeVector(v));
    expect(back).toHaveLength(DIMS);
    for (let i = 0; i < DIMS; i += 1) expect(back[i]).toBeCloseTo(v[i], 6);
  });
});

describe('chunkstore', () => {
  it('writes and reads chunks in order', async () => {
    await putChunks(redis, 'e1', chunksOf(3), null);
    const out = await getChunks(redis, 'e1');
    expect(out.map((c) => c.text)).toEqual(['chunk 0', 'chunk 1', 'chunk 2']);
    expect(out[0].start).toBe(0);
    expect(out[0].model).toBe(MODEL_ID);
    expect(out[1].vector).toHaveLength(DIMS);
  });

  it('returns nothing for an entry with no chunks', async () => {
    expect(await getChunks(redis, 'missing')).toEqual([]);
  });

  it('replaces chunks rather than accumulating them', async () => {
    await putChunks(redis, 'e1', chunksOf(4), null);
    await putChunks(redis, 'e1', chunksOf(2), null);
    expect(await getChunks(redis, 'e1')).toHaveLength(2);
    expect(await redis.scard('memchunks:e1')).toBe(2);
  });

  it('removes stale high-index chunk keys when a rewrite produces fewer chunks', async () => {
    // A long body indexes to many chunks; re-indexing a much shorter body must
    // not leave the old higher-numbered keys behind, or a search can later
    // match an orphaned vector quoting text the entry no longer contains.
    await putChunks(redis, 'e1', chunksOf(8), null);
    for (let n = 0; n < 8; n += 1) {
      expect(await redis.exists(`memchunk:e1:${n}`)).toBe(1);
    }

    await putChunks(redis, 'e1', chunksOf(2), null);

    for (let n = 0; n < 2; n += 1) {
      expect(await redis.exists(`memchunk:e1:${n}`)).toBe(1);
    }
    for (let n = 2; n < 8; n += 1) {
      expect(await redis.exists(`memchunk:e1:${n}`)).toBe(0);
    }
    expect(await redis.keys('memchunk:e1:*')).toHaveLength(2);
    expect(await redis.smembers('memchunks:e1')).toHaveLength(2);
  });

  it('deletes every chunk and its index set', async () => {
    await putChunks(redis, 'e1', chunksOf(3), null);
    await deleteChunks(redis, 'e1');
    expect(await getChunks(redis, 'e1')).toEqual([]);
    expect(await redis.exists('memchunks:e1')).toBe(0);
    expect(await redis.keys('memchunk:e1:*')).toEqual([]);
  });

  it('propagates a TTL to every chunk and the index set', async () => {
    await putChunks(redis, 'e1', chunksOf(2), 600);
    for (const k of await redis.keys('memchunk:e1:*')) {
      expect(await redis.ttl(k)).toBeGreaterThan(0);
    }
    expect(await redis.ttl('memchunks:e1')).toBeGreaterThan(0);
  });

  it('sets no TTL when the parent has none', async () => {
    await putChunks(redis, 'e1', chunksOf(2), null);
    for (const k of await redis.keys('memchunk:e1:*')) {
      expect(await redis.ttl(k)).toBe(-1);
    }
    expect(await redis.ttl('memchunks:e1')).toBe(-1);
  });

  it('tracks and drains the dirty set', async () => {
    await markDirty(redis, 'a');
    await markDirty(redis, 'b');
    await markDirty(redis, 'a');
    expect(await redis.scard(DIRTY_KEY)).toBe(2);
    const taken = await takeDirty(redis, 10);
    expect(taken.sort()).toEqual(['a', 'b']);
    expect(await redis.scard(DIRTY_KEY)).toBe(0);
  });
});
