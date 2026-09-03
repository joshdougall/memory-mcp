import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const CENSUS_CAP = 1000;

export class TruncatedCensusError extends Error {
  constructor(cap) {
    super(`census returned ${cap} rows, equal to the cap: the view may be truncated`);
    this.name = 'TruncatedCensusError';
  }
}

export class DeadlineError extends Error {
  constructor(msg) { super(msg); this.name = 'DeadlineError'; }
}

// Bounds how long we WAIT, not how long the request runs. The SDK overwrites
// requestInit.signal with its own per-POST controller, so a signal handed to
// the transport bounds nothing. Racing a timer works regardless.
export function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${label} exceeded ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function health(base, timeoutMs = 5000) {
  try {
    return await withDeadline(fetch(`${base}/health`).then((r) => r.ok), timeoutMs, 'health');
  } catch {
    return false;
  }
}

export async function connect({ url, token }) {
  // The server requires a bearer token only when AUTH_TOKEN is set, so an empty
  // token connects unauthenticated and works against the current deployment.
  const requestInit = {};
  if (token) requestInit.headers = { Authorization: `Bearer ${token}` };

  const client = new Client({ name: 'memory-compaction', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit }));
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
}

export async function census(client, cap = CENSUS_CAP) {
  const out = await call(client, 'memory_list', { limit: cap, sort: 'updated' });
  if (out.count >= cap) throw new TruncatedCensusError(cap);
  return out.results;
}

export async function getEntry(client, id) {
  // memory_get returns the entry FLAT as { id, ...entry, revision }, not nested
  // under an `entry` key, and a miss returns { error: 'Not found: <id>' }.
  const out = await call(client, 'memory_get', { id });
  if (!out || out.error) return null;
  const { revision, ...entry } = out;
  return { entry, revision };
}

// Expected refusals (conflict, operation_id_mismatch) come back as values so the
// caller can retry or skip. Only transport and protocol failures throw, which is
// what lets the orchestrator tell "the server said no" from "we do not know".
export async function setEntry(client, args) {
  const out = await call(client, 'memory_set', { source: 'memory-compaction', ...args });
  if (out.ok === false) {
    return { ok: false, error: out.error, current_revision: out.current_revision };
  }
  return { ok: true, revision: out.revision, replayed: Boolean(out.replayed) };
}
