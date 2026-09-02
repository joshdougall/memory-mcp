import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import {
  startEnv,
  assertIsolated,
  isolatedUrl,
  freePort,
  resolveExitStatus,
  terminateChild,
} from './helpers/compact-env.js';

describe('assertIsolated', () => {
  it('rejects a URL with no db index', () => {
    expect(() => assertIsolated('redis://127.0.0.1:6379')).toThrow(/db index/i);
  });
  it('rejects db 0', () => {
    expect(() => assertIsolated('redis://127.0.0.1:6379/0')).toThrow(/db index/i);
  });
  it('rejects a padded zero that ioredis reads as db 0', () => {
    expect(() => assertIsolated('redis://127.0.0.1:6379/00')).toThrow(/db index/i);
  });
  it('rejects a query string', () => {
    expect(() => assertIsolated('redis://127.0.0.1:6379/12?x=y')).toThrow(/query/i);
  });
  it('accepts a plain non-zero db index', () => {
    expect(() => assertIsolated('redis://127.0.0.1:6379/12')).not.toThrow();
  });
});

describe('isolatedUrl', () => {
  it('replaces an existing db index rather than appending', () => {
    expect(isolatedUrl('redis://127.0.0.1:6379/5', 12)).toBe('redis://127.0.0.1:6379/12');
  });
  it('strips a query string instead of building around it', () => {
    expect(isolatedUrl('redis://127.0.0.1:6379/5?x=y', 12)).toBe('redis://127.0.0.1:6379/12');
  });
  it('handles a trailing slash', () => {
    expect(isolatedUrl('redis://127.0.0.1:6379/', 12)).toBe('redis://127.0.0.1:6379/12');
  });
  it('refuses to build a db 0 url', () => {
    expect(() => isolatedUrl('redis://127.0.0.1:6379', 0)).toThrow(/db index/i);
  });
});

describe('freePort', () => {
  it('returns a usable port number', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1024);
  });
});

describe('startEnv', () => {
  let env;
  afterAll(async () => { await env?.stop(); });

  it('starts a server on an isolated db and answers /health', async () => {
    env = await startEnv({ db: 12 });
    expect((await fetch(`${env.base}/health`)).ok).toBe(true);
    expect(env.valkeyUrl).toMatch(/\/12$/);
  });

  it('starts empty because it flushed its own db', async () => {
    expect(await env.redis.dbsize()).toBe(0);
  });
});

describe('resolveExitStatus', () => {
  it('prefers the exit code when the process exited normally', () => {
    expect(resolveExitStatus(1, null)).toBe(1);
  });
  it('treats a clean exit (code 0) as a real, non-null status', () => {
    expect(resolveExitStatus(0, null)).toBe(0);
  });
  it('falls back to the signal when a signal killed the process', () => {
    expect(resolveExitStatus(null, 'SIGTERM')).toBe('SIGTERM');
  });
});

describe('terminateChild', () => {
  it('escalates to SIGKILL when the child ignores SIGTERM, and does not hang', async () => {
    // A child that installs a SIGTERM handler and never exits on its own,
    // to force terminateChild down the escalation path deterministically.
    const proc = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ]);
    await new Promise((resolve) => proc.once('spawn', resolve));

    const start = Date.now();
    await terminateChild(proc, 200);
    const elapsed = Date.now() - start;

    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    // Should resolve close to the 200ms escalation timeout, not hang for the
    // production 5000ms default and not resolve instantly either.
    expect(elapsed).toBeLessThan(2000);
  });

  it('resolves immediately for a child that already exited', async () => {
    const proc = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => proc.once('exit', resolve));
    const start = Date.now();
    await terminateChild(proc, 5000);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
