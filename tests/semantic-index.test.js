import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Redis from 'ioredis';
import { indexEntry } from '../semantic/index.js';
import { getChunks } from '../semantic/chunkstore.js';
import { DIMS } from '../semantic/embedder.js';
import { BACKLINK_START, BACKLINK_END, stripManagedBlock } from '../compact/graph.js';

let redis;
beforeAll(() => { redis = new Redis('redis://127.0.0.1:6379/8'); });
afterAll(async () => { await redis.flushdb(); await redis.quit(); });
beforeEach(async () => { await redis.flushdb(); });

describe('indexEntry', () => {
  it('never embeds a generated backlink block', async () => {
    const body = `real content here\n${BACKLINK_START}\n## Referenced by\n- [[some-entry]]\n${BACKLINK_END}`;
    await indexEntry(redis, 'e1', { title: 'T', body, ttl: null });
    const chunks = await getChunks(redis, 'e1');
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.text).not.toContain('compaction:backlinks');
      expect(c.text).not.toContain('some-entry');
    }
  }, 120000);

  it('records offsets that index into the stripped body, not the raw one', async () => {
    // The chunk text carries the title prefix, so compare offsets against the
    // stripped body itself. Slicing the chunk by body offsets would be
    // meaningless and would pass against almost anything.
    const body = `alpha beta gamma\n${BACKLINK_START}\nx\n${BACKLINK_END}`;
    const stripped = stripManagedBlock(body);
    await indexEntry(redis, 'e1', { title: 'T', body, ttl: null });
    const [c] = await getChunks(redis, 'e1');
    expect(stripped.slice(c.start, c.end)).toBe('alpha beta gamma');
    expect(c.end).toBeLessThanOrEqual(stripped.length);
  }, 120000);

  it('produces vectors of the right width', async () => {
    await indexEntry(redis, 'e1', { title: 'T', body: 'some ordinary prose', ttl: null });
    const [c] = await getChunks(redis, 'e1');
    expect(c.vector).toHaveLength(DIMS);
  }, 120000);

  it('propagates a TTL to the chunks', async () => {
    await indexEntry(redis, 'e1', { title: 'T', body: 'prose', ttl: 600 });
    for (const k of await redis.keys('memchunk:e1:*')) {
      expect(await redis.ttl(k)).toBeGreaterThan(0);
    }
  }, 120000);

  it('writes no chunks for a body that is only a generated block', async () => {
    const body = `${BACKLINK_START}\n- [[x]]\n${BACKLINK_END}`;
    const out = await indexEntry(redis, 'e1', { title: '', body, ttl: null });
    expect(out.chunks).toBe(0);
    expect(await getChunks(redis, 'e1')).toEqual([]);
  }, 120000);

  it('marks the entry dirty and does not throw when embedding fails', async () => {
    const boom = { embedPassages: vi.fn().mockRejectedValue(new Error('model gone')) };
    const out = await indexEntry(redis, 'e1', { title: 'T', body: 'prose', ttl: null }, boom);
    expect(out.skipped).toBe('model gone');
    expect(await redis.sismember('memdirty', 'e1')).toBe(1);
    expect(await getChunks(redis, 'e1')).toEqual([]);
  });

  it('clears stale chunks when a re-indexed entry becomes only a generated block', async () => {
    // Index real content first: this must leave chunk keys and an index-set
    // key behind.
    await indexEntry(redis, 'e1', { title: 'T', body: 'real content here', ttl: null });
    const before = await getChunks(redis, 'e1');
    expect(before.length).toBeGreaterThan(0);
    expect((await redis.keys('memchunk:e1:*')).length).toBeGreaterThan(0);
    expect(await redis.exists('memchunks:e1')).toBe(1);

    // Re-index the same id with a body that is now only a generated block.
    // The old chunks describe text this entry no longer carries, so a search
    // must not be able to find them.
    const body = `${BACKLINK_START}\n- [[x]]\n${BACKLINK_END}`;
    const out = await indexEntry(redis, 'e1', { title: 'T', body, ttl: null });

    expect(out.chunks).toBe(0);
    expect(await getChunks(redis, 'e1')).toEqual([]);
    expect(await redis.keys('memchunk:e1:*')).toEqual([]);
    expect(await redis.exists('memchunks:e1')).toBe(0);
  }, 120000);
});
