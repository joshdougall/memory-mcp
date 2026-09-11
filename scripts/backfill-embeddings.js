// scripts/backfill-embeddings.js
//
// Walks entries with no current-model chunks and indexes them. This is what
// makes semantic search work on a store that predates the feature: roughly
// 842 entries, essentially none indexed, only reachable by keyword until this
// runs.
import Redis from 'ioredis';
import { indexEntry } from '../semantic/index.js';
import { getChunks, takeDirty, markDirty } from '../semantic/chunkstore.js';
import { MODEL_ID } from '../semantic/embedder.js';

async function scanIds(redis) {
  const ids = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'mem:*', 'COUNT', 100);
    cursor = next;
    for (const k of batch) ids.push(k.replace(/^mem:/, ''));
  } while (cursor !== '0');
  return ids;
}

export async function backfill(redis, { onlyDirty = false, embedder } = {}) {
  const ids = onlyDirty ? await takeDirty(redis, 10000) : await scanIds(redis);
  let indexed = 0;
  let skipped = 0;

  for (const id of ids) {
    try {
      const raw = await redis.hgetall(`mem:${id}`);
      if (!raw || !raw.title) continue;

      if (!onlyDirty) {
        // Resumable: chunks already present at the current model are left
        // alone, so an interrupted run costs a scan and no embedding on
        // retry. Chunks left over from an older model are not current, so
        // they fall through and get re-embedded rather than skipped forever.
        const existing = await getChunks(redis, id);
        const currentAndReadable = existing.length > 0
          && existing.every((c) => c.model === MODEL_ID);
        if (currentAndReadable) {
          // `memchunks:<id>` is the source of truth for how many chunks this
          // entry has. `putChunks` only grows it once every individual chunk
          // hash for the new version is already written (the SADD is the
          // last command in its pipeline), so a crash mid-write cannot leave
          // it listing more members than we can read back for a version that
          // was never fully written in the first place: the set would still
          // be empty (or hold the prior version), and `existing.length`
          // would be 0. What a crash CAN leave behind is a stale set from an
          // interrupted delete-then-rewrite of an earlier version, where
          // some of that version's chunk hashes were removed before the crash
          // and others were not, while the set itself (its own delete is
          // last too) still lists all of them. Comparing the set's real
          // cardinality against what we could actually read catches that: a
          // complete entry has the two agree, a partial one does not.
          const total = await redis.scard(`memchunks:${id}`);
          if (total === existing.length) {
            skipped += 1;
            continue;
          }
        }
      }

      const ttl = await redis.ttl(`mem:${id}`);
      const entry = { title: raw.title, body: raw.body, ttl: ttl > 0 ? ttl : null };
      const res = embedder
        ? await indexEntry(redis, id, entry, embedder)
        : await indexEntry(redis, id, entry);
      if (res.skipped) skipped += 1; else indexed += 1;
    } catch (err) {
      // A single bad entry must never abort the run. Record it so the dirty
      // set picks it up for retry, count it as skipped, and move on.
      skipped += 1;
      try {
        await markDirty(redis, id);
      } catch {
        // best effort: if even this fails, the entry is simply missed this
        // run rather than taking the rest down with it.
      }
    }
  }

  return { scanned: ids.length, indexed, skipped };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const redis = new Redis(process.env.VALKEY_URL || 'redis://127.0.0.1:6379');
  const onlyDirty = process.argv.includes('--dirty');
  const out = await backfill(redis, { onlyDirty });
  console.log(JSON.stringify(out));
  await redis.quit();
}
