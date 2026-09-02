import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Redis from 'ioredis';

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.js');

// The compaction pass repairs and retires entries across the WHOLE database it
// is pointed at. A test that ran against db 0 on a developer machine would
// rewrite real memories, so this fails closed on anything ambiguous: a padded
// zero selects db 0 in ioredis, and a query string means the caller built the
// URL by string concatenation and may not have the db they think they have.
export function assertIsolated(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`refusing to run compaction tests against an unparseable url: ${url}`);
  }
  if (u.search) {
    throw new Error(`refusing to run compaction tests against a url with a query string: ${url}`);
  }
  const db = u.pathname.replace(/^\//, '');
  if (!/^[1-9][0-9]*$/.test(db)) {
    throw new Error(
      `refusing to run compaction tests against ${url}: a non-zero numeric db index is required`,
    );
  }
}

export function isolatedUrl(base, db) {
  const u = new URL(base);
  u.pathname = `/${db}`;
  u.search = '';
  u.hash = '';
  const url = u.toString();
  assertIsolated(url);
  return url;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(base, proc, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  proc.once('exit', (code) => { exited = code; });
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`server exited early with code ${exited}`);
    try {
      if ((await fetch(`${base}/health`)).ok) {
        // A healthy response proves SOMETHING is listening, not that it is ours.
        // Settle briefly and re-check the child: if it lost a bind race it will
        // have exited by now, and continuing would point the tests at a
        // stranger's server while we flushed our own database.
        await new Promise((r) => setTimeout(r, 150));
        if (exited !== null) throw new Error(`server exited early with code ${exited}`);
        return;
      }
    } catch (err) {
      if (err.message.startsWith('server exited early')) throw err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${base} did not become ready within ${timeoutMs}ms`);
}

export async function startEnv({ db }) {
  const valkeyUrl = isolatedUrl(process.env.COMPACT_TEST_VALKEY || 'redis://127.0.0.1:6379', db);
  const port = await freePort();

  const redis = new Redis(valkeyUrl);
  await redis.flushdb();

  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), VALKEY_URL: valkeyUrl },
    stdio: 'pipe',
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitReady(base, proc);
  } catch (err) {
    proc.kill('SIGTERM');
    await redis.quit();
    throw err;
  }

  const dir = mkdtempSync(join(tmpdir(), 'compact-'));

  return {
    base,
    mcpUrl: `${base}/mcp`,
    valkeyUrl,
    port,
    dir,
    redis,
    flush: () => redis.flushdb(),
    async stop() {
      try { await redis.flushdb(); } catch { /* best effort */ }
      try { await redis.quit(); } catch { /* best effort */ }
      rmSync(dir, { recursive: true, force: true });
      await new Promise((resolve) => {
        proc.once('exit', resolve);
        proc.kill('SIGTERM');
        setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 5000).unref();
      });
    },
  };
}
