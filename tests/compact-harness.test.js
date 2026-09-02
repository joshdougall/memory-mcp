import { describe, it, expect, afterAll } from 'vitest';
import { startEnv, assertIsolated, isolatedUrl, freePort } from './helpers/compact-env.js';

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
