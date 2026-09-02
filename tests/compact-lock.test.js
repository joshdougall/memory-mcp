import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../compact/lock.js';

let dir, path;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compact-lock-'));
  path = join(dir, 'run.lock');
  writeFileSync(path, ''); // proper-lockfile locks an existing path
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Waits for `marker` to appear in the child's stdout, so the parent proceeds
// only once the child has provably reached that point, never on a guessed
// timeout. Rejects if the child exits first without ever printing it.
function waitForMarker(child, marker) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      if (buf.includes(marker)) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!buf.includes(marker)) {
        reject(new Error(`child exited (code ${code}) before printing "${marker}". stdout: ${buf}`));
      }
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', reject);
  });
}

describe('acquireLock', () => {
  it('grants the lock when free', () => {
    const held = acquireLock(path);
    expect(held).not.toBeNull();
    held.release();
  });

  it('refuses a second holder while the first is held', () => {
    const first = acquireLock(path);
    expect(acquireLock(path)).toBeNull();
    first.release();
  });

  it('grants again once released', () => {
    acquireLock(path).release();
    const second = acquireLock(path);
    expect(second).not.toBeNull();
    second.release();
  });

  it('refuses the parent while a live separate process concurrently holds the lock, then grants it once that process exits', async () => {
    // A real second process running concurrently with this one (spawn, not
    // spawnSync), because cross-process exclusion is the entire point and a
    // process that has already exited by the time we check proves nothing
    // about contention.
    const holder = spawn(process.execPath, [
      '--input-type=module', '-e',
      `import { acquireLock } from ${JSON.stringify(join(process.cwd(), 'compact/lock.js'))};
       const h = acquireLock(${JSON.stringify(path)});
       if (!h) { console.log('refused'); process.exit(1); }
       console.log('ready');
       setTimeout(() => process.exit(0), 1500);`,
    ]);

    try {
      // Wait for proof the child holds the lock, rather than sleeping a
      // guessed interval, so this is not timing-dependent.
      await waitForMarker(holder, 'ready');

      // The holder is provably alive and holding the lock right now.
      expect(acquireLock(path)).toBeNull();

      await waitForExit(holder);

      // The holder has exited, so its lock must have been released.
      const after = acquireLock(path);
      expect(after).not.toBeNull();
      after.release();
    } finally {
      // Cleanup path: never leak the child process if an assertion above throws.
      if (holder.exitCode === null) holder.kill('SIGKILL');
    }
  });

  it('refuses a spawned process while the parent holds the lock', () => {
    // The inverse direction: this test proves the lock excludes outward
    // (parent holds, child is refused), not just inward.
    const held = acquireLock(path);
    expect(held).not.toBeNull();
    try {
      const child = spawnSync(process.execPath, [
        '--input-type=module', '-e',
        `import { acquireLock } from ${JSON.stringify(join(process.cwd(), 'compact/lock.js'))};
         const h = acquireLock(${JSON.stringify(path)});
         console.log(h ? 'held' : 'refused');`,
      ], { encoding: 'utf8' });
      expect(child.stdout.trim()).toBe('refused');
    } finally {
      held.release();
    }
  });

  it('releases automatically when the holding process exits', () => {
    execFileSync(process.execPath, [
      '--input-type=module', '-e',
      `import { acquireLock } from ${JSON.stringify(join(process.cwd(), 'compact/lock.js'))};
       acquireLock(${JSON.stringify(path)});
       process.exit(0);`,
    ]);
    const held = acquireLock(path);
    expect(held).not.toBeNull();
    held.release();
  });
});
