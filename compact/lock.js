// compact/lock.js
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';

// staleness: a lock whose mtime has not been updated for this long is assumed
// to belong to a dead process. The update loop refreshes it every 5s while we
// hold it, so a live run is never mistaken for a corpse.
const STALE_MS = 30000;
const UPDATE_MS = 5000;

export function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, '');
  try {
    const release = lockfile.lockSync(path, {
      stale: STALE_MS,
      update: UPDATE_MS,
      // If the lock is compromised mid-run (someone deleted it, or the update
      // loop fell too far behind), fail loudly rather than continue writing to
      // the store while believing we are exclusive.
      onCompromised: (err) => {
        console.error(`[compact] run lock compromised: ${err.message}`);
        process.exit(5);
      },
    });
    return { release: () => { try { release(); } catch { /* already released */ } } };
  } catch (err) {
    if (err.code === 'ELOCKED') return null;
    throw err;
  }
}
