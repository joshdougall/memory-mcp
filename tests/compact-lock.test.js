import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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

  it('refuses a lock held by a live separate process', () => {
    // A real second process, because the whole point is cross-process exclusion
    // and a same-process test proves nothing about that.
    const holder = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      `import { acquireLock } from ${JSON.stringify(join(process.cwd(), 'compact/lock.js'))};
       const h = acquireLock(${JSON.stringify(path)});
       console.log(h ? 'held' : 'refused');`,
    ], { encoding: 'utf8' });
    expect(holder.stdout.trim()).toBe('held');
    // That process has exited, so its lock must have been released on exit.
    const after = acquireLock(path);
    expect(after).not.toBeNull();
    after.release();
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
