// semantic/chunkstore.js
// Persistence layer for chunk vectors: write, read, delete, and track which
// entries still need embedding.
import { DIMS, MODEL_ID } from './embedder.js';

export const DIRTY_KEY = 'memdirty';

const chunkKey = (id, n) => `memchunk:${id}:${n}`;
const indexKey = (id) => `memchunks:${id}`;

export function encodeVector(v) {
  return Buffer.from(new Float32Array(v).buffer).toString('base64');
}

export function decodeVector(s) {
  const buf = Buffer.from(s, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export async function deleteChunks(redis, id) {
  const keys = await redis.smembers(indexKey(id));
  const pipe = redis.pipeline();
  for (const k of keys) pipe.del(k);
  pipe.del(indexKey(id));
  await pipe.exec();
}

export async function putChunks(redis, id, chunks, ttlSeconds) {
  // Clear whatever this entry had before writing the new set. This is also
  // what removes stale higher-numbered chunk keys when a rewrite produces
  // fewer chunks than the previous version, so an orphaned vector cannot
  // later match a search for text the entry no longer contains.
  await deleteChunks(redis, id);
  if (!chunks || chunks.length === 0) return;

  const pipe = redis.pipeline();
  const keys = [];
  chunks.forEach((c, n) => {
    const key = chunkKey(id, n);
    keys.push(key);
    pipe.hset(key, {
      text: c.text,
      vector: encodeVector(c.vector),
      start: String(c.start),
      end: String(c.end),
      model: MODEL_ID,
    });
    // The parent's TTL, or none. A tombstoned entry's chunks must die with
    // it, or they are stranded when the entry expires: the index-leak
    // problem the compaction spec documents, one level deeper.
    if (ttlSeconds) pipe.expire(key, ttlSeconds);
  });
  pipe.sadd(indexKey(id), ...keys);
  if (ttlSeconds) pipe.expire(indexKey(id), ttlSeconds);
  await pipe.exec();
}

export async function getChunks(redis, id) {
  const keys = await redis.smembers(indexKey(id));
  if (keys.length === 0) return [];
  // Sort numerically by the trailing index so chunk 10 follows chunk 9.
  keys.sort((a, b) => Number(a.split(':').pop()) - Number(b.split(':').pop()));

  const pipe = redis.pipeline();
  for (const k of keys) pipe.hgetall(k);
  const res = await pipe.exec();

  const out = [];
  for (const [err, raw] of res) {
    if (err || !raw || !raw.vector) continue;
    const vector = decodeVector(raw.vector);
    if (vector.length !== DIMS) continue;
    out.push({
      text: raw.text || '',
      vector,
      start: Number(raw.start || 0),
      end: Number(raw.end || 0),
      model: raw.model || '',
    });
  }
  return out;
}

export async function markDirty(redis, id) {
  await redis.sadd(DIRTY_KEY, id);
}

export async function takeDirty(redis, limit) {
  const ids = await redis.srandmember(DIRTY_KEY, limit);
  if (!ids || ids.length === 0) return [];
  await redis.srem(DIRTY_KEY, ...ids);
  return ids;
}
