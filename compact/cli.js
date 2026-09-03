#!/usr/bin/env node
// compact/cli.js
import { join } from 'node:path';
import { run, EXIT } from './compact.js';
import { acquireLock } from './lock.js';

const dir = process.env.COMPACT_DIR || '/home/automation/services/memory-compaction';
const url = process.env.MEMORY_MCP_URL || 'http://127.0.0.1:3106/mcp';

let base;
try {
  base = new URL(url).origin;
} catch {
  console.error(`invalid MEMORY_MCP_URL: ${url}`);
  process.exit(EXIT.LOCAL);
}

const budgetMs = Number(process.env.COMPACT_BUDGET_MS || 600000);
if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
  console.error(`invalid COMPACT_BUDGET_MS: ${process.env.COMPACT_BUDGET_MS}`);
  process.exit(EXIT.LOCAL);
}

// acquireLock creates COMPACT_DIR and can throw on an unwritable path. Inside
// the try so it classifies as a local failure rather than an uncaught exception
// exiting with Node's default code 1.
let held;
try {
  held = acquireLock(join(dir, 'run.lock'));
} catch (err) {
  console.error(`cannot take the run lock in ${dir}: ${err.message}`);
  process.exit(EXIT.LOCAL);
}
if (held === null) process.exit(EXIT.LOCKED);

let code = EXIT.LOCAL;
try {
  code = await run({
    dir, url, base,
    token: process.env.MEMORY_MCP_TOKEN || '',
    dryRun: process.argv.slice(2).includes('--dry-run'),
    budgetMs,
  });
} finally {
  // Released here, not in a handler: process.exit() below does not unwind a
  // finally, so the release must happen before it. proper-lockfile also
  // releases on process exit, which covers a crash.
  held.release();
}
process.exit(code);
