# `if_version` and `operation_id` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `memory_set` optional compare-and-set (`if_version`) and write-idempotency (`operation_id`) semantics, atomically, without changing behaviour for any existing caller.

**Architecture:** A monotonic revision counter lives in its own Valkey key, `memrev:<id>`, and is the single source of truth for an entry's revision. The whole `memory_set` write path moves from a non-atomic ioredis `pipeline` into one Lua script executed via ioredis `defineCommand` (EVALSHA with automatic EVAL fallback), so the replay check, the revision check, and the write either all happen or none do. `memory_delete` and `memory_rollback` bump the same counter but keep their current non-atomic structure, which is unchanged and out of scope.

**Tech Stack:** Node 22 ESM, ioredis 5, Valkey 9 (Lua 5.1 + cjson), zod 3, prom-client 15, vitest 2.

## Global Constraints

- **Backward compatibility is absolute.** With `if_version` and `operation_id` both omitted, `memory_set` must behave exactly as it does at `ee73837` — same response fields (plus `revision`), same index writes, same version snapshots, same TTL handling. All 14 existing tests must keep passing unmodified.
- **`memory_get` must not move the revision.** It increments `hits` on every read; if that moved the revision, every read would invalidate every outstanding CAS.
- **Revision moves only on semantic mutation:** `memory_set` (applied write), `memory_rollback`, `memory_delete`. Never on `memory_get`, `memory_search`, `memory_list`, `memory_history`, `memory_prune_candidates`.
- **A conflict has zero side effects:** no version pushed to `memver:`, no index set touched, no `hits` change, no TTL refresh, no `memory_write_total` increment. It increments `memory_conflict_total` instead.
- **A replay has zero side effects** and returns the originally recorded outcome.
- Missing revision reads as `0`. `if_version: 0` therefore means "create if absent, or upgrade a legacy entry that has never been versioned".
- `memop:<operation_id>` TTL default **604800** seconds (7 days), env-overridable.
- Config env naming: server.js reads the bare name (`OPERATION_ID_TTL_SECONDS`), docker-compose maps it from a `MEMORY_MCP_`-prefixed host variable. Follow the existing pattern exactly.
- Single-file server. The Lua script lives inline in `server.js` as a template literal, **not** a separate file — `Dockerfile` only does `COPY server.js .`, so a separate file would build a green image that crashes at startup.
- No em dashes in prose or docs (repo owner preference).
- Tests are integration tests against a real Valkey at `VALKEY_URL` (default `redis://127.0.0.1:6379`).

---

## Deviation from the spec, and why

The spec says `rev` is "a new integer field on `mem:<id>`". **It cannot be**, and this plan uses a separate `memrev:<id>` string key instead.

The spec also requires (under "Delete then re-create") that the revision survive a delete so a stale `if_version` from before the delete is rejected. But `memory_delete` does `DEL mem:<id>`, which destroys every field of that hash. A hash field therefore cannot carry the revision across a delete. The two requirements are mutually exclusive as written.

`memrev:<id>` satisfies every *behavioural* requirement in the spec (the CAS, the `0`-means-absent rule, the tombstone continuity, the ABA prevention) and is invisible across the MCP API, which is the only surface the downstream consumer sees. It also removes any possibility of two revision sources diverging: there is exactly one counter, and `memory_get` reads it directly rather than mirroring it into the hash.

**One behavioural consequence to be aware of.** Because delete bumps the counter and the counter outlives the entry, `if_version: 0` against a deleted-and-not-recreated id returns a **conflict** carrying the current revision, not a successful create. The entry is genuinely absent, but a bare `0` is treated as a stale expectation to prevent the ABA the spec calls out. This is self-correcting: the client gets `current_revision` and retries with it. Task 4 tests this explicitly and Task 7 documents it.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server.js` | Everything: config, metrics, Lua script, MCP tools, HTTP server | Modify |
| `tests/server.test.js` | Integration tests against a spawned server + real Valkey | Modify |
| `docker-compose.yml` | Container env mapping | Modify (one line) |
| `.env.example` | Documented host env vars | Modify |
| `README.md` | User-facing docs: config table, tool table, data model | Modify |
| `AGENTS.md` | Agent-facing tool docs | Modify |
| `package.json` | Version bump 1.0.0 -> 1.1.0 | Modify |

New Valkey keys introduced:

| Key | Type | Contents | Lifetime |
|---|---|---|---|
| `memrev:<id>` | string | monotonic revision counter | permanent, outlives the entry |
| `memop:<operation_id>` | hash | `memory_id`, `revision`, `action` | `OPERATION_ID_TTL_SECONDS` |

Note `mem:*` SCAN patterns do not match `memrev:` or `memver:` (the pattern requires the literal `mem:`), so entry counts and the existing gauges are unaffected.

---

## Task 1: Atomic `memory_set` on Lua, with a revision counter

Moves the write path into Lua and starts the counter. No `if_version` yet.

**Files:**
- Modify: `server.js` (config block ~line 21-26, metrics block ~line 92-102, new Lua section before `buildMcpServer`, `pushVersion` ~line 154, `memory_set` handler ~line 326-364, `memory_get` handler ~line 301-310)
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `redis.memorySetAtomic(memKey, verKey, revKey, opKey, ...argv)` -> JSON string. `opKey` is `''` when unused. ARGV order is fixed and every later task depends on it: `id, title, body, type, tagsCsv, tagsJson, source, project, now, ttl, maxVersions, ifVersion, hasOp, opTtl`.
  - Script return shapes: `{"status":"ok","id":…,"revision":N,"operation":"created"|"modified"}`, and (later tasks) `{"status":"conflict",…}`, `{"status":"replayed",…}`.
  - `pushVersion(id, fields, operation, rev)` — fourth parameter added; snapshots gain a `rev` field.
  - `memory_set` success response gains `revision`.
  - `memory_get` response gains `revision`.
  - `OPERATION_ID_TTL_SECONDS` constant.
  - `metricConflictTotal` (declared here, first used in Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `tests/server.test.js`. First, extend the imports and helpers at the top of the file:

```js
import Redis from 'ioredis';
```

and add these helpers next to `uid()`:

```js
// Direct Valkey access, for asserting raw keys the MCP API does not expose.
function rawClient() {
  return new Redis(VALKEY_URL, { lazyConnect: false });
}

// Scrape a single unlabelled counter/gauge value from /metrics.
async function metric(base, name) {
  const res = await fetch(`${base}/metrics`);
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? parseFloat(line.split(' ')[1]) : 0;
}
```

Then add this block inside the existing `describe('memory-mcp server', ...)`:

```js
  // --------------------------------------------------------------------------
  // revision counter
  // --------------------------------------------------------------------------

  it('memory_set starts revision at 1 and increments once per write', async () => {
    const c = await client();
    const id = uid();

    const created = await call(c, 'memory_set', {
      id, title: 'Rev 1', body: 'b', type: 'pattern',
      tags: ['rev-test'], source: 'test-suite', project: 'memory-mcp-test',
    });
    expect(created.ok).toBe(true);
    expect(created.revision).toBe(1);

    const modified = await call(c, 'memory_set', {
      id, title: 'Rev 2', body: 'b', type: 'pattern',
      tags: ['rev-test'], source: 'test-suite', project: 'memory-mcp-test',
    });
    expect(modified.ok).toBe(true);
    expect(modified.revision).toBe(2);

    await c.close();
  });

  it('memory_get returns revision and does not move it despite counting hits', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Get rev', body: 'b', type: 'pattern',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
    });

    const first = await call(c, 'memory_get', { id });
    expect(first.revision).toBe(1);
    expect(first.hits).toBe(1);

    const second = await call(c, 'memory_get', { id });
    expect(second.revision).toBe(1);
    expect(second.hits).toBe(2);

    await c.close();
  });

  it('version snapshots record the revision they were written at', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Snap 1', body: 'b1', type: 'pattern',
      tags: ['snap'], source: 'test-suite', project: 'memory-mcp-test',
    });
    await call(c, 'memory_set', {
      id, title: 'Snap 2', body: 'b2', type: 'pattern',
      tags: ['snap'], source: 'test-suite', project: 'memory-mcp-test',
    });

    const history = await call(c, 'memory_history', { id });
    await c.close();

    expect(history.versions[0].rev).toBe(2);
    expect(history.versions[1].rev).toBe(1);
  });

  it('memory_set preserves created date, tags array and index membership across updates', async () => {
    const c = await client();
    const id = uid();
    const oldTag = uid();
    const newTag = uid();

    await call(c, 'memory_set', {
      id, title: 'Indexed', body: 'b', type: 'pattern',
      tags: [oldTag], source: 'test-suite', project: 'memory-mcp-test',
    });
    const before = await call(c, 'memory_get', { id });

    await call(c, 'memory_set', {
      id, title: 'Reindexed', body: 'b', type: 'decision',
      tags: [newTag], source: 'test-suite', project: 'memory-mcp-test',
    });
    const after = await call(c, 'memory_get', { id });

    // created date carries over, tags round-trip as an array
    expect(after.created).toBe(before.created);
    expect(after.tags).toEqual([newTag]);

    // old tag index no longer points at the entry, new one does
    const oldSearch = await call(c, 'memory_search', { tags: [oldTag] });
    expect(oldSearch.results.map((r) => r.id)).not.toContain(id);
    const newSearch = await call(c, 'memory_search', { tags: [newTag] });
    expect(newSearch.results.map((r) => r.id)).toContain(id);

    await c.close();
  });

  it('memory_set with a ttl sets an expiry, and a later write without one clears it', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Expiring', body: 'b', type: 'state',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test', ttl: 600,
    });
    expect(await raw.ttl(`mem:${id}`)).toBeGreaterThan(0);

    await call(c, 'memory_set', {
      id, title: 'Permanent', body: 'b', type: 'state',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
    });
    expect(await raw.ttl(`mem:${id}`)).toBe(-1);

    await raw.quit();
    await c.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npx vitest run -t 'revision'
```

Expected: failures. `created.revision` is `undefined`, `history.versions[0].rev` is `undefined`.

- [ ] **Step 3: Add config and the conflict metric**

In `server.js`, after the `MAX_BODY_BYTES` line (~line 26):

```js
const OPERATION_ID_TTL_SECONDS = parseInt(process.env.OPERATION_ID_TTL_SECONDS || String(7 * 24 * 60 * 60), 10);
```

After the `metricWriteTotal` declaration (~line 96):

```js
const metricConflictTotal = new Counter({
  name: 'memory_conflict_total',
  help: 'Total number of memory_set calls rejected by an if_version mismatch',
  registers: [registry],
});
```

- [ ] **Step 4: Add the Lua script and register it**

In `server.js`, add a new section immediately before the `// MCP SERVER` banner:

```js
// ============================================================================
// LUA: ATOMIC memory_set
// ============================================================================

// A pipeline batches round trips but is not atomic, and a compare-and-set needs
// to read the revision and conditionally abort in the same breath. EVAL is
// atomic in Valkey, so the replay check, the revision check and the write either
// all happen or none do.
//
// KEYS: 1 mem:<id>  2 memver:<id>  3 memrev:<id>  4 memop:<operation_id> ('' when unused)
// ARGV: 1 id  2 title  3 body  4 type  5 tagsCsv  6 tagsJson  7 source
//       8 project  9 now  10 ttl  11 maxVersions  12 ifVersion  13 hasOp  14 opTtl
//
// Index set names are derived inside the script rather than passed as keys. This
// server already assumes a single (non-cluster) Valkey: memory_search SINTERs
// across tag: keys that would hash to different slots.
const MEMORY_SET_LUA = `
local memKey, verKey, revKey, opKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]

local id          = ARGV[1]
local title       = ARGV[2]
local body        = ARGV[3]
local mtype       = ARGV[4]
local tagsCsv     = ARGV[5]
local tagsJson    = ARGV[6]
local source      = ARGV[7]
local project     = ARGV[8]
local now         = ARGV[9]
local ttl         = ARGV[10]
local maxVersions = tonumber(ARGV[11])
local ifVersion   = ARGV[12]
local hasOp       = ARGV[13] == '1'
local opTtl       = tonumber(ARGV[14])

local function splitCsv(csv)
  local out = {}
  for item in string.gmatch(csv or '', '([^,]+)') do out[#out + 1] = item end
  return out
end

-- 1. Replay: an already recorded operation_id returns its outcome and writes nothing.
if hasOp then
  local rec = redis.call('HMGET', opKey, 'memory_id', 'revision', 'action')
  if rec[1] then
    return cjson.encode({
      status = 'replayed',
      id = rec[1],
      revision = tonumber(rec[2]),
      operation = rec[3],
    })
  end
end

-- 2. Compare-and-set. A missing counter reads as 0, so if_version 0 means
--    "create if absent", and also upgrades a legacy entry that predates this field.
local currentRev = tonumber(redis.call('GET', revKey) or '0')
if ifVersion ~= '' and currentRev ~= tonumber(ifVersion) then
  return cjson.encode({
    status = 'conflict',
    id = id,
    current_revision = currentRev,
    expected_version = tonumber(ifVersion),
  })
end

-- 3. Apply.
local flat = redis.call('HGETALL', memKey)
local prev = {}
for i = 1, #flat, 2 do prev[flat[i]] = flat[i + 1] end
local isNew = prev.title == nil
local operation = isNew and 'created' or 'modified'

if not isNew then
  if prev.type and prev.type ~= '' then redis.call('SREM', 'type:' .. prev.type, memKey) end
  redis.call('SREM', 'project:' .. (prev.project or ''), memKey)
  for _, t in ipairs(splitCsv(prev.tags)) do redis.call('SREM', 'tag:' .. t, memKey) end
end

local newRev = redis.call('INCR', revKey)

redis.call('HSET', memKey,
  'title', title,
  'body', body,
  'type', mtype,
  'source', source,
  'project', project,
  'updated', now,
  'hits', isNew and '0' or (prev.hits or '0'),
  'ttl', ttl,
  'tags', tagsCsv,
  'created', isNew and now or (prev.created or now))

if ttl ~= '' then
  redis.call('EXPIRE', memKey, tonumber(ttl))
elseif not isNew then
  redis.call('PERSIST', memKey)
end

if mtype ~= '' then redis.call('SADD', 'type:' .. mtype, memKey) end
redis.call('SADD', 'project:' .. project, memKey)
for _, t in ipairs(splitCsv(tagsCsv)) do redis.call('SADD', 'tag:' .. t, memKey) end

-- tagsJson arrives pre-encoded from the caller: cjson encodes an empty Lua table
-- as {} rather than [], which would corrupt the tags array in history.
redis.call('LPUSH', verKey, string.format(
  '{"title":%s,"body":%s,"type":%s,"tags":%s,"source":%s,"project":%s,"updated":%s,"operation":%s,"rev":%d}',
  cjson.encode(title), cjson.encode(body), cjson.encode(mtype), tagsJson,
  cjson.encode(source), cjson.encode(project), cjson.encode(now), cjson.encode(operation), newRev))
redis.call('LTRIM', verKey, 0, maxVersions - 1)

if hasOp then
  redis.call('HSET', opKey, 'memory_id', id, 'revision', newRev, 'action', operation)
  redis.call('EXPIRE', opKey, opTtl)
end

return cjson.encode({ status = 'ok', id = id, revision = newRev, operation = operation })
`;

redis.defineCommand('memorySetAtomic', { numberOfKeys: 4, lua: MEMORY_SET_LUA });
```

- [ ] **Step 5: Give `pushVersion` a `rev` parameter**

Replace `pushVersion` (~line 154):

```js
async function pushVersion(id, fields, operation, rev) {
  const snapshot = JSON.stringify({
    title: fields.title || '',
    body: fields.body || '',
    type: fields.type || '',
    tags: fields.tags ? fields.tags.split(',').filter(Boolean) : [],
    source: fields.source || 'unknown',
    project: fields.project || '',
    updated: nowIso(),
    operation,
    rev,
  });
  await redis.lpush(`memver:${id}`, snapshot);
  await redis.ltrim(`memver:${id}`, 0, MAX_VERSIONS_PER_ENTRY - 1);
}
```

- [ ] **Step 6: Rewrite the `memory_set` handler body**

Replace the handler function (the `async ({ id, title, ... }) => { ... }` at ~line 326-364) with:

```js
    async ({ id, title, body, type, tags, source, project, ttl }) => {
      const result = JSON.parse(await redis.memorySetAtomic(
        `mem:${id}`,
        `memver:${id}`,
        `memrev:${id}`,
        '',
        id,
        title,
        body,
        type,
        tags.join(','),
        JSON.stringify(tags),
        source || 'unknown',
        project || '',
        nowIso(),
        ttl ? String(ttl) : '',
        String(MAX_VERSIONS_PER_ENTRY),
        '',
        '0',
        String(OPERATION_ID_TTL_SECONDS)
      ));

      metricWriteTotal.inc();

      const totalKeys = await scanKeys('mem:*');
      const warning = totalKeys.length > MAX_ENTRIES_WARN
        ? `Entry count (${totalKeys.length}) exceeds soft cap of ${MAX_ENTRIES_WARN}. Consider running memory_prune_candidates.`
        : null;

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, operation: result.operation, revision: result.revision, warning }, null, 2) }] };
    }
```

- [ ] **Step 7: Return `revision` from `memory_get`**

Replace the `memory_get` handler body (~line 301-310):

```js
    async ({ id }) => {
      const raw = await redis.hgetall(`mem:${id}`);
      if (!raw || !raw.title) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Not found: ${id}` }) }] };
      }
      const pipe = await redis.pipeline()
        .hincrby(`mem:${id}`, 'hits', 1)
        .get(`memrev:${id}`)
        .exec();
      const revision = parseInt((pipe && pipe[1] && pipe[1][1]) || '0', 10);
      const entry = entryToObject(raw);
      entry.hits += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ id, ...entry, revision }, null, 2) }] };
    }
```

- [ ] **Step 8: Run the full suite**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npm test
```

Expected: all 14 original tests plus the 5 new ones pass (19 total).

- [ ] **Step 9: Lint**

```bash
npm run lint
```

Expected: no output, exit 0.

- [ ] **Step 10: Commit**

```bash
git add server.js tests/server.test.js
git commit -m "feat: atomic memory_set via Lua, with a memrev revision counter"
```

---

## Task 2: `if_version` compare-and-set

**Files:**
- Modify: `server.js` (`memory_set` zod schema and handler)
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: `redis.memorySetAtomic` and its ARGV order from Task 1; the script's `status: 'conflict'` branch is already present.
- Produces: `memory_set` accepts `if_version?: number` and returns `{ok: false, error: 'conflict', id, current_revision, expected_version}` on mismatch.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('memory-mcp server', ...)`:

```js
  // --------------------------------------------------------------------------
  // if_version
  // --------------------------------------------------------------------------

  it('if_version applies the write when it matches the current revision', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'v1', body: 'b1', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
    });

    const result = await call(c, 'memory_set', {
      id, title: 'v2', body: 'b2', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(2);

    const after = await call(c, 'memory_get', { id });
    expect(after.body).toBe('b2');

    await c.close();
  });

  it('if_version returns a conflict and writes nothing when it does not match', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'v1', body: 'original', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
    });

    const result = await call(c, 'memory_set', {
      id, title: 'stale', body: 'should not land', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 99,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('conflict');
    expect(result.id).toBe(id);
    expect(result.current_revision).toBe(1);
    expect(result.expected_version).toBe(99);

    const after = await call(c, 'memory_get', { id });
    expect(after.body).toBe('original');
    expect(after.revision).toBe(1);

    await c.close();
  });

  it('if_version 0 creates when absent and conflicts when already versioned', async () => {
    const c = await client();
    const id = uid();

    const created = await call(c, 'memory_set', {
      id, title: 'fresh', body: 'b', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(created.ok).toBe(true);
    expect(created.operation).toBe('created');
    expect(created.revision).toBe(1);

    const again = await call(c, 'memory_set', {
      id, title: 'duplicate', body: 'b', type: 'pattern',
      tags: ['cas'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(again.ok).toBe(false);
    expect(again.error).toBe('conflict');
    expect(again.current_revision).toBe(1);

    await c.close();
  });

  it('if_version 0 upgrades a legacy entry that has no revision counter', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();

    // Seed an entry the way a pre-1.1.0 server would have: hash only, no memrev key.
    await raw.hset(`mem:${id}`, {
      title: 'Legacy entry',
      body: 'written by an older server',
      type: 'reference',
      tags: 'legacy',
      source: 'test-suite',
      project: 'memory-mcp-test',
      created: '2026-01-01',
      updated: '2026-01-01',
      hits: '7',
    });
    expect(await raw.exists(`memrev:${id}`)).toBe(0);

    const upgraded = await call(c, 'memory_set', {
      id, title: 'Upgraded', body: 'now versioned', type: 'reference',
      tags: ['legacy'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(upgraded.ok).toBe(true);
    expect(upgraded.operation).toBe('modified');
    expect(upgraded.revision).toBe(1);

    // A second if_version 0 now conflicts: the entry is versioned.
    const second = await call(c, 'memory_set', {
      id, title: 'again', body: 'b', type: 'reference',
      tags: ['legacy'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('conflict');

    await raw.quit();
    await c.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npx vitest run -t 'if_version'
```

Expected: failures. `if_version` is not in the schema, so it is stripped and every write succeeds unconditionally.

- [ ] **Step 3: Add the `if_version` parameter to the schema**

In the `memory_set` zod schema, after the `ttl` line:

```js
      if_version: z.number().int().min(0).optional().describe('Compare-and-set: apply only if the current revision equals this. 0 means create-if-absent. Omit for an unconditional write.'),
```

- [ ] **Step 4: Wire it through the handler**

Change the handler signature to destructure it:

```js
    async ({ id, title, body, type, tags, source, project, ttl, if_version }) => {
```

Change the `ifVersion` argument (currently the literal `''`, the 12th ARGV) to:

```js
        if_version === undefined ? '' : String(if_version),
```

And immediately after parsing `result`, before `metricWriteTotal.inc()`:

```js
      if (result.status === 'conflict') {
        metricConflictTotal.inc();
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'conflict', id, current_revision: result.current_revision, expected_version: result.expected_version }, null, 2) }] };
      }
```

- [ ] **Step 5: Run the full suite**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npm test
```

Expected: 23 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server.js tests/server.test.js
git commit -m "feat: if_version compare-and-set for memory_set"
```

---

## Task 3: `operation_id` write idempotency

**Files:**
- Modify: `server.js` (`memory_set` zod schema and handler)
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: `redis.memorySetAtomic`; the script's `status: 'replayed'` branch is already present.
- Produces: `memory_set` accepts `operation_id?: string` and returns `{ok: true, id, operation, revision, replayed: true}` when the id has already been recorded.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('memory-mcp server', ...)`:

```js
  // --------------------------------------------------------------------------
  // operation_id
  // --------------------------------------------------------------------------

  it('replaying an operation_id returns the prior result and writes nothing', async () => {
    const c = await client();
    const id = uid();
    const opId = 'op-' + uid();

    const first = await call(c, 'memory_set', {
      id, title: 'once', body: 'first body', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });
    expect(first.ok).toBe(true);
    expect(first.revision).toBe(1);
    expect(first.replayed).toBeUndefined();

    // Same operation_id, different content: must be a no-op returning the first outcome.
    const replay = await call(c, 'memory_set', {
      id, title: 'twice', body: 'second body', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.revision).toBe(1);
    expect(replay.operation).toBe('created');

    // Nothing moved: body unchanged, revision unchanged, no second version.
    const after = await call(c, 'memory_get', { id });
    expect(after.body).toBe('first body');
    expect(after.revision).toBe(1);

    const history = await call(c, 'memory_history', { id });
    expect(history.count).toBe(1);

    await c.close();
  });

  it('a replay wins over a stale if_version rather than conflicting', async () => {
    const c = await client();
    const id = uid();
    const opId = 'op-' + uid();

    await call(c, 'memory_set', {
      id, title: 'v1', body: 'b', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
    });

    // A conditional write that succeeds, carrying an operation_id.
    const applied = await call(c, 'memory_set', {
      id, title: 'v2', body: 'b2', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 1, operation_id: opId,
    });
    expect(applied.ok).toBe(true);
    expect(applied.revision).toBe(2);

    // The client never saw the ack and retries verbatim. if_version 1 is now
    // stale, but the recorded operation_id must short-circuit ahead of the CAS.
    const retry = await call(c, 'memory_set', {
      id, title: 'v2', body: 'b2', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 1, operation_id: opId,
    });
    expect(retry.ok).toBe(true);
    expect(retry.replayed).toBe(true);
    expect(retry.revision).toBe(2);

    await c.close();
  });

  it('operation_id records expire after the retention window', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();
    const opId = 'op-' + uid();

    await call(c, 'memory_set', {
      id, title: 'ttl check', body: 'b', type: 'pattern',
      tags: ['idem'], source: 'test-suite', project: 'memory-mcp-test',
      operation_id: opId,
    });

    const ttl = await raw.ttl(`memop:${opId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60);

    const recorded = await raw.hgetall(`memop:${opId}`);
    expect(recorded.memory_id).toBe(id);
    expect(recorded.revision).toBe('1');
    expect(recorded.action).toBe('created');

    await raw.quit();
    await c.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npx vitest run -t 'operation_id'
```

Expected: failures. `operation_id` is stripped by the schema, so the replay writes a second version and `memop:` is never created.

- [ ] **Step 3: Add the `operation_id` parameter to the schema**

After the `if_version` line:

```js
      operation_id: z.string().min(1).max(200).optional().describe('Idempotency key. Replaying a recorded id returns the original result and writes nothing. Retained for 7 days.'),
```

- [ ] **Step 4: Wire it through the handler**

Change the handler signature:

```js
    async ({ id, title, body, type, tags, source, project, ttl, if_version, operation_id }) => {
```

Change the 4th key (currently the literal `''`) to:

```js
        operation_id ? `memop:${operation_id}` : '',
```

Change the `hasOp` argument (currently the literal `'0'`, the 13th ARGV) to:

```js
        operation_id ? '1' : '0',
```

And add the replay branch immediately after the conflict branch:

```js
      if (result.status === 'replayed') {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: result.id, operation: result.operation, revision: result.revision, replayed: true }, null, 2) }] };
      }
```

- [ ] **Step 5: Run the full suite**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npm test
```

Expected: 26 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server.js tests/server.test.js
git commit -m "feat: operation_id write idempotency for memory_set"
```

---

## Task 4: Revision movement on `memory_delete` and `memory_rollback`

**Files:**
- Modify: `server.js` (`memory_delete` handler ~line 416-425, `memory_rollback` handler ~line 452-484)
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: `pushVersion(id, fields, operation, rev)` from Task 1.
- Produces: `memory_delete` and `memory_rollback` responses both gain `revision`.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('memory-mcp server', ...)`:

```js
  // --------------------------------------------------------------------------
  // revision movement on delete and rollback
  // --------------------------------------------------------------------------

  it('memory_rollback moves the revision', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Original', body: 'original body', type: 'pattern',
      tags: ['rb-rev'], source: 'test-suite', project: 'memory-mcp-test',
    });
    await call(c, 'memory_set', {
      id, title: 'Modified', body: 'modified body', type: 'pattern',
      tags: ['rb-rev'], source: 'test-suite', project: 'memory-mcp-test',
    });

    const rollback = await call(c, 'memory_rollback', { id, version_index: 1 });
    expect(rollback.ok).toBe(true);
    expect(rollback.revision).toBe(3);

    const after = await call(c, 'memory_get', { id });
    expect(after.body).toBe('original body');
    expect(after.revision).toBe(3);

    await c.close();
  });

  it('memory_delete moves the revision and the tombstone carries it', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'Doomed', body: 'b', type: 'pattern',
      tags: [uid()], source: 'test-suite', project: 'memory-mcp-test',
    });

    const del = await call(c, 'memory_delete', { id });
    expect(del.ok).toBe(true);
    expect(del.revision).toBe(2);

    const history = await call(c, 'memory_history', { id });
    expect(history.versions[0].operation).toBe('deleted');
    expect(history.versions[0].rev).toBe(2);

    await c.close();
  });

  it('delete then re-create continues the revision sequence and rejects a stale if_version', async () => {
    const c = await client();
    const id = uid();

    await call(c, 'memory_set', {
      id, title: 'First life', body: 'b', type: 'pattern',
      tags: ['aba'], source: 'test-suite', project: 'memory-mcp-test',
    });
    // A client reads revision 1 and holds it.
    const held = await call(c, 'memory_get', { id });
    expect(held.revision).toBe(1);

    await call(c, 'memory_delete', { id });

    // The stale expectation must not win: delete moved the revision to 2.
    const stale = await call(c, 'memory_set', {
      id, title: 'Resurrected by a stale writer', body: 'b', type: 'pattern',
      tags: ['aba'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 1,
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toBe('conflict');
    expect(stale.current_revision).toBe(2);

    // if_version 0 is also stale after a delete: the counter outlives the entry.
    const asNew = await call(c, 'memory_set', {
      id, title: 'Assumed new', body: 'b', type: 'pattern',
      tags: ['aba'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 0,
    });
    expect(asNew.ok).toBe(false);
    expect(asNew.error).toBe('conflict');
    expect(asNew.current_revision).toBe(2);

    // Retrying with the revision the conflict reported succeeds, and the
    // sequence continues rather than restarting at 1.
    const recreated = await call(c, 'memory_set', {
      id, title: 'Second life', body: 'b2', type: 'pattern',
      tags: ['aba'], source: 'test-suite', project: 'memory-mcp-test',
      if_version: 2,
    });
    expect(recreated.ok).toBe(true);
    expect(recreated.operation).toBe('created');
    expect(recreated.revision).toBe(3);

    await c.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npx vitest run -t 'revision'
```

Expected: failures. `del.revision` and `rollback.revision` are `undefined`, and the delete-then-recreate test sees `current_revision` 1 instead of 2.

- [ ] **Step 3: Bump the revision in `memory_delete`**

Replace the `memory_delete` handler body:

```js
    async ({ id }) => {
      const existing = await redis.hgetall(`mem:${id}`);
      if (!existing || !existing.title) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Not found: ${id}` }) }] };
      }
      // The counter is a separate key, so it survives the DEL below. That is what
      // stops a stale if_version from matching a later re-created entry.
      const revision = await redis.incr(`memrev:${id}`);
      await pushVersion(id, existing, 'deleted', revision);
      await removeFromIndexes(id, existing);
      await redis.del(`mem:${id}`);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, operation: 'deleted', revision }, null, 2) }] };
    }
```

- [ ] **Step 4: Bump the revision in `memory_rollback`**

In the `memory_rollback` handler, insert the increment after `fields` is built and before the `hset`, then pass it to `pushVersion` and the response. The block from `const tags = ...` to the return becomes:

```js
      const tags = Array.isArray(version.tags) ? version.tags : [];
      const fields = {
        title: version.title || '',
        body: version.body || '',
        type: version.type || '',
        source: version.source || 'unknown',
        project: version.project || '',
        updated: nowIso(),
        hits: existing ? (existing.hits || '0') : '0',
        ttl: existing ? (existing.ttl || '') : '',
        tags: tags.join(','),
      };

      // Bumped only here, after the version has been found and parsed, so a
      // failed rollback does not move the revision.
      const revision = await redis.incr(`memrev:${id}`);

      await redis.hset(`mem:${id}`, fields);
      await addToIndexes(id, fields.type, fields.project, tags);
      await pushVersion(id, { ...fields }, `rollback_to_${version_index}`, revision);
      metricWriteTotal.inc();

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, operation: `rollback_to_${version_index}`, restored_from: version.updated || 'unknown', revision }, null, 2) }] };
```

- [ ] **Step 5: Run the full suite**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npm test
```

Expected: 29 tests pass. Note the pre-existing `memory_rollback restores a previous version` test still passes because it asserts on `operation` and content, not revision.

- [ ] **Step 6: Commit**

```bash
git add server.js tests/server.test.js
git commit -m "feat: move the revision on memory_delete and memory_rollback"
```

---

## Task 5: Conflicts have zero side effects

Proves the isolation the spec demands, including the metrics split.

**Files:**
- Test: `tests/server.test.js` (assertions only; no server change expected)

**Interfaces:**
- Consumes: `metric(base, name)` helper from Task 1, `rawClient()` from Task 1, `memory_conflict_total` from Task 1, the conflict branch from Task 2.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Add inside `describe('memory-mcp server', ...)`:

```js
  // --------------------------------------------------------------------------
  // conflict isolation
  // --------------------------------------------------------------------------

  it('a conflict touches nothing and is counted as a conflict, not a write', async () => {
    const c = await client();
    const raw = rawClient();
    const id = uid();
    const tag = uid();

    await call(c, 'memory_set', {
      id, title: 'Untouchable', body: 'original', type: 'pattern',
      tags: [tag], source: 'test-suite', project: 'memory-mcp-test', ttl: 600,
    });
    await call(c, 'memory_get', { id }); // hits -> 1

    const before = {
      hash: await raw.hgetall(`mem:${id}`),
      versions: await raw.lrange(`memver:${id}`, 0, -1),
      tagMembers: await raw.smembers(`tag:${tag}`),
      typeMembers: await raw.smembers('type:pattern'),
      rev: await raw.get(`memrev:${id}`),
      ttl: await raw.ttl(`mem:${id}`),
      writes: await metric(BASE, 'memory_write_total'),
      conflicts: await metric(BASE, 'memory_conflict_total'),
    };

    const conflict = await call(c, 'memory_set', {
      id, title: 'Rejected', body: 'must not land', type: 'decision',
      tags: [uid()], source: 'test-suite', project: 'other-project',
      if_version: 42,
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toBe('conflict');

    const after = {
      hash: await raw.hgetall(`mem:${id}`),
      versions: await raw.lrange(`memver:${id}`, 0, -1),
      tagMembers: await raw.smembers(`tag:${tag}`),
      typeMembers: await raw.smembers('type:pattern'),
      rev: await raw.get(`memrev:${id}`),
      ttl: await raw.ttl(`mem:${id}`),
      writes: await metric(BASE, 'memory_write_total'),
      conflicts: await metric(BASE, 'memory_conflict_total'),
    };

    // No hash field moved, including hits.
    expect(after.hash).toEqual(before.hash);
    // No version pushed.
    expect(after.versions).toEqual(before.versions);
    // No index set touched.
    expect(after.tagMembers.sort()).toEqual(before.tagMembers.sort());
    expect(after.typeMembers.sort()).toEqual(before.typeMembers.sort());
    // Revision did not move.
    expect(after.rev).toBe(before.rev);
    // TTL was not refreshed or cleared.
    expect(after.ttl).toBeLessThanOrEqual(before.ttl);
    expect(after.ttl).toBeGreaterThan(0);
    // Counted as a conflict, not a write.
    expect(after.writes).toBe(before.writes);
    expect(after.conflicts).toBe(before.conflicts + 1);

    await raw.quit();
    await c.close();
  });
```

- [ ] **Step 2: Run it**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npx vitest run -t 'conflict touches nothing'
```

Expected: PASS on the first run. Task 1 and Task 2 already implement this; this test is the proof. If it fails, the conflict branch is doing work it should not, and that is a real bug to fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add tests/server.test.js
git commit -m "test: prove a conflict has no side effects and is counted separately"
```

---

## Task 6: Concurrency, one winner per revision

**Files:**
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: `client()`, `call()`, `uid()`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Add inside `describe('memory-mcp server', ...)`. Each writer gets its own MCP client so the concurrency is real at the transport layer:

```js
  // --------------------------------------------------------------------------
  // concurrency
  // --------------------------------------------------------------------------

  it('N concurrent writers holding the same revision produce exactly one winner', async () => {
    const setup = await client();
    const id = uid();
    await call(setup, 'memory_set', {
      id, title: 'Contended', body: 'base', type: 'pattern',
      tags: ['race'], source: 'test-suite', project: 'memory-mcp-test',
    });
    await setup.close();

    const WRITERS = 8;
    const clients = await Promise.all(
      Array.from({ length: WRITERS }, () => client())
    );

    const results = await Promise.all(
      clients.map((c, i) => call(c, 'memory_set', {
        id, title: `writer-${i}`, body: `body-${i}`, type: 'pattern',
        tags: ['race'], source: 'test-suite', project: 'memory-mcp-test',
        if_version: 1,
      }))
    );

    await Promise.all(clients.map((c) => c.close()));

    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(WRITERS - 1);
    expect(winners[0].revision).toBe(2);
    losers.forEach((l) => {
      expect(l.error).toBe('conflict');
      expect(l.expected_version).toBe(1);
      expect(l.current_revision).toBe(2);
    });

    // The stored entry is exactly one writer's, with no interleaved fields.
    const verify = await client();
    const final = await call(verify, 'memory_get', { id });
    await verify.close();

    expect(final.revision).toBe(2);
    // The stored title and body must come from the same writer. If the fields
    // interleaved, title would name one writer and body another.
    expect(final.title).toMatch(/^writer-\d+$/);
    const writerIndex = final.title.replace('writer-', '');
    expect(final.body).toBe(`body-${writerIndex}`);
  });
```

- [ ] **Step 2: Run it**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npx vitest run -t 'concurrent writers'
```

Expected: PASS. If more than one writer wins, the write path is not actually atomic and the Lua script is being bypassed somewhere.

- [ ] **Step 3: Run the full suite**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npm test
```

Expected: 31 tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/server.test.js
git commit -m "test: concurrent conditional writers produce exactly one winner"
```

---

## Task 7: Documentation and version bump

**Files:**
- Modify: `README.md`, `AGENTS.md`, `.env.example`, `docker-compose.yml`, `package.json`, `server.js` (McpServer version string ~line 212)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Bump the version in two places**

`package.json`: `"version": "1.0.0"` becomes `"version": "1.1.0"`.

`server.js`, in `buildMcpServer`:

```js
  const server = new McpServer({
    name: 'memory-mcp',
    version: '1.1.0',
  });
```

- [ ] **Step 2: Map the new env var in `docker-compose.yml`**

In the `memory-mcp` service `environment:` block, after the `MAX_VERSIONS_PER_ENTRY` line:

```yaml
      OPERATION_ID_TTL_SECONDS: "${MEMORY_MCP_OPERATION_ID_TTL_SECONDS:-604800}"
```

- [ ] **Step 3: Document it in `.env.example`**

In the `── Limits ──` block, after the `MEMORY_MCP_MAX_VERSIONS_PER_ENTRY` line:

```
# How long an operation_id stays recorded for idempotent retries (seconds).
# Default 604800 = 7 days, long enough to cover a machine offline for a week.
MEMORY_MCP_OPERATION_ID_TTL_SECONDS=604800
```

- [ ] **Step 4: Update the `README.md` config table**

Add a row after `MEMORY_MCP_MAX_VERSIONS_PER_ENTRY`:

```
| `MEMORY_MCP_OPERATION_ID_TTL_SECONDS` | `604800` | How long an `operation_id` stays recorded for idempotent retries (7 days) |
```

- [ ] **Step 5: Add a `README.md` section on concurrent writes**

Insert immediately before the `## Memory types` heading:

```markdown
## Concurrent writes

By default `memory_set` is an unconditional full replacement: the last writer wins, and a
write that lands between another client's read and its own write is silently overwritten.
Two optional parameters make coordinated writes safe. Both default to off, so existing
callers are unaffected.

### `if_version` (compare-and-set)

Every entry carries a monotonic `revision`, returned by `memory_get`. Pass it back as
`if_version` and the write applies only if the revision still matches:

```
memory_get(id="my-entry")                     -> { ..., "revision": 7 }
memory_set(id="my-entry", ..., if_version=7)  -> { "ok": true, "revision": 8 }
```

If another writer got there first you get a structured conflict rather than an error, and
nothing is written:

```json
{ "ok": false, "error": "conflict", "id": "my-entry", "current_revision": 9, "expected_version": 7 }
```

On conflict, **re-read the entry and recompose your change against the new body**, then
retry with the revision the conflict reported. Replaying the same body against the new
revision would reintroduce the lost update this exists to prevent.

`if_version=0` means "create if absent". It also succeeds once against an entry written by
a server older than 1.1.0, which is how those entries get their first revision.

The revision moves only on a real mutation: an applied `memory_set`, a `memory_rollback`, or
a `memory_delete`. `memory_get` increments the hit counter without moving the revision, so
reads never invalidate an outstanding compare-and-set.

The revision counter outlives the entry it belongs to. After a delete, a re-created entry
continues the sequence instead of restarting at 1, so a stale `if_version` from before the
delete cannot match. One consequence: `if_version=0` against a deleted id returns a conflict
carrying the current revision rather than creating. Retry with that revision.

### `operation_id` (idempotent retries)

A client that crashes after a successful write but before recording that fact cannot tell
"not applied" from "applied, unacknowledged". Pass a unique `operation_id` and the retry is
a true no-op that returns the original outcome:

```json
{ "ok": true, "id": "my-entry", "operation": "modified", "revision": 8, "replayed": true }
```

The replay check runs ahead of the `if_version` check, so a verbatim retry carrying a
now-stale `if_version` still replays rather than conflicting. Records are kept for
`MEMORY_MCP_OPERATION_ID_TTL_SECONDS` (7 days by default) and are scoped server-wide, not
per entry.

Conflicts are counted separately from writes in the metrics: `memory_conflict_total` rather
than `memory_write_total`.
```

- [ ] **Step 6: Update the `README.md` data model section**

Replace the two paragraphs after the hash field table (the `memver:` and index-set paragraphs) with:

```markdown
Version history is stored in a Redis list at `memver:<id>` (newest-first, capped at
`MAX_VERSIONS_PER_ENTRY`). Each snapshot records the `rev` it was written at.

The revision counter is a separate string key, `memrev:<id>`. It is deliberately not a field
on the entry hash: it has to survive `memory_delete`, which deletes that hash. It is
incremented only on semantic mutation, never by `memory_get`.

Recorded `operation_id` values are hashes at `memop:<operation_id>` holding `memory_id`,
`revision` and `action`, expiring after `MEMORY_MCP_OPERATION_ID_TTL_SECONDS`.

Tag, type, and project indexes are Redis sets (`tag:<name>`, `type:<name>`, `project:<name>`).
```

- [ ] **Step 7: Update the `memory_set` row in both tool tables**

In `README.md`:

```
| `memory_set` | Create or update an entry (versioned on every write, optional compare-and-set) |
```

In `AGENTS.md`:

```
| `memory_set` | Create or update an entry — versioned on every write, optional compare-and-set |
```

- [ ] **Step 8: Add a short `AGENTS.md` note**

Insert immediately before the `## Conventions` heading:

```markdown
## Safe concurrent writes

If several agents or machines may write the same entry, pass the `revision` you read from
`memory_get` back as `if_version`:

```
memory_get(id="my-entry")                     -> { ..., "revision": 7 }
memory_set(id="my-entry", ..., if_version=7)
```

A mismatch returns `{"ok": false, "error": "conflict", "current_revision": N}` and writes
nothing. Re-read the entry, recompose your change against the current body, and retry with
the revision the conflict reported. Do not replay your original body.

For retry-safety across a crash, pass a unique `operation_id`. Replaying it returns the
original result with `"replayed": true` and writes nothing.
```

- [ ] **Step 9: Verify nothing broke**

```bash
VALKEY_URL=redis://127.0.0.1:6379 npm test && npm run lint
```

Expected: 31 tests pass, lint clean.

- [ ] **Step 10: Commit**

```bash
git add README.md AGENTS.md .env.example docker-compose.yml package.json server.js
git commit -m "docs: document if_version and operation_id, bump to 1.1.0"
```

---

## Task 8: Git hosting topology

Deliberately not specified here. This repository is public, and the maintainer's git hosting
layout (canonical remote, mirror configuration, credentials) is operational detail that does
not belong in a public artifact. It is tracked outside the repository.

Nothing in Tasks 1 to 7 depends on it.

---

## Self-Review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| `rev` integer, starts at 1, only on semantic mutation | 1, 4 |
| Missing field reads as 0, no migration job | 2 (legacy upgrade test) |
| Delete then re-create continues the sequence, no ABA | 4 |
| `if_version` omitted = unchanged behaviour | 1 (all 14 original tests unmodified) |
| `if_version: N` applies on match | 2 |
| `if_version: 0` create-if-absent | 2 |
| `operation_id` recorded atomically, 7 day TTL | 3 |
| Replay returns stored result, no second write | 3 |
| `operation_id` scoped globally | 3 (key is `memop:<id>`, not per entry) |
| Atomicity via a single Lua EVAL | 1 |
| Success response gains `revision` | 1 |
| Conflict is a structured result | 2 |
| Replay response carries `replayed: true` | 3 |
| Zero side effects on conflict | 5 |
| `memory_conflict_total` not `memory_write_total` | 1 (metric), 5 (proof) |
| `memory_get` returns `revision` | 1 |
| `memory_get` does not move `rev` | 1 |
| `memory_rollback` and `memory_delete` move `rev` | 4 |
| `memop:` keys expire | 3 |
| Concurrency, one winner per revision | 6 |
| Client contract documented | 7 |

Out of scope per the spec and not implemented: conditional `memory_delete` / `memory_rollback`, and any change to search, indexing or pruning.

**Placeholder scan.** No TBDs. Every code step carries the literal code. Every test step carries the assertions.

**Type consistency.** `pushVersion(id, fields, operation, rev)` is defined in Task 1 Step 5 and called with four arguments in Task 1 (Lua path does not use it), Task 4 Step 3, and Task 4 Step 4. `redis.memorySetAtomic` is registered in Task 1 Step 4 with `numberOfKeys: 4` and called with 4 keys plus 14 ARGV in Task 1 Step 6; Tasks 2 and 3 change argument *values* at fixed positions (12, 13, and key 4) without changing the arity. Script status values `ok` / `conflict` / `replayed` are produced in Task 1's Lua and consumed in Tasks 1, 2, 3. `metricConflictTotal` is declared in Task 1 Step 3 and used in Task 2 Step 4.

**Verification note.** Task 5 and Task 6 are pure test tasks: they assert properties that Tasks 1 to 4 are supposed to have already delivered. If either fails on its first run, that is a real defect in the implementation, not a test to be adjusted until it passes.
