# `if_version` and `operation_id` for `memory_set`

Date: 2026-08-11
Repo: `memory-mcp`
Status: design, ready for implementation planning
Consumer: the memory-durability design in `claude-config`
(`docs/superpowers/specs/2026-08-11-memory-durability-design.md`, branch `worktree-memory-durability`)

## Problem

`memory_set` is an unconditional full replacement. Two defects follow, both of which block the
claude-config memory-durability work.

1. **Lost updates.** A write by another session or machine between a client's `memory_get` and its
   `memory_set` is silently overwritten. There is no compare-and-set.
2. **No write idempotency.** A client that crashes after a successful `memory_set` but before
   recording that fact cannot tell "not applied" from "applied, unacknowledged". Retrying either
   duplicates work or skips it.

## What the current code actually does

Verified against `server.js` at `ee73837`, which matches the deployed server: same eight tools, both
report version 1.0.0.

| Key | Type | Contents |
|---|---|---|
| `mem:<id>` | hash | title, body, type, tags, source, project, created, updated, hits |
| `memver:<id>` | list | version snapshots, newest first, `LTRIM`med to `MAX_VERSIONS_PER_ENTRY` (default 20) |
| `type:<t>`, `project:<p>`, `tag:<t>` | set | index sets holding `mem:<id>` |

Three properties of the current implementation shape this design:

- **Writes are not atomic.** `memory_set` uses an ioredis `pipeline`, which batches round trips but
  provides no atomicity. A CAS built on it would be a race, not a guarantee.
- **`memver` length is not a usable revision.** It is trimmed to 20, so it stops increasing. Revision
  must be its own field.
- **`memory_get` writes.** It does `hincrby hits 1` on every read. If revision moved on any change to
  the hash, every read would invalidate every outstanding CAS and the feature would be useless.

## Design

### `rev`

A new integer field on `mem:<id>`, starting at 1, incremented **only on semantic mutation**.

| Operation | Moves `rev`? |
|---|---|
| `memory_set` (content change) | yes |
| `memory_rollback` | yes — it is recorded as a new version, so it is a mutation |
| `memory_delete` | yes — the tombstone carries the incremented value |
| `memory_get` hit counting | **no** |
| `memory_search`, `memory_list`, `memory_history` | no |

**Initialisation for existing entries.** Entries predating this change have no `rev`. Treat a missing
field as `rev = 0` on read, and have the first conditional write set it to 1. No migration job, no
backfill; the field appears on first write. A client passing `if_version: 0` against an entry that
exists but has never been versioned therefore succeeds once, which is the intended upgrade path.

**Delete then re-create.** The tombstone retains the last `rev`, and a re-created entry continues
from it rather than restarting at 1. Restarting would permit an ABA: a client holding a stale
`if_version: 5` would match a recreated entry that coincidentally reached 5 again, and overwrite it.

### `if_version`

Optional parameter on `memory_set`.

- Omitted → today's unconditional behaviour, unchanged in every respect. This is the backward
  compatibility contract: every existing caller keeps working with no edit.
- `if_version: N` → apply only if the stored `rev` equals `N`.
- `if_version: 0` → create-if-absent. Fails if the key exists **with a `rev`**; succeeds for a key
  with no `rev` (see initialisation above).

### `operation_id`

Optional parameter on `memory_set`, recorded atomically with the update.

- Stored as `memop:<operation_id>` → `{memory_id, revision, action}`, TTL **7 days**. Long enough to
  cover a machine offline for a week, short enough to stay bounded.
- Replaying an `operation_id` that is already recorded returns the stored result and performs **no**
  second write. This is what makes a client retry after an unacknowledged success a true no-op.
- An `operation_id` is scoped globally, not per entry, because the client's event id already is.

### Atomicity

One Lua script per `memory_set`, executed with `EVAL`. `EVAL` is atomic in Valkey, so the whole
sequence either happens or does not:

1. read `rev` and any `memop:<operation_id>`
2. if the operation is already recorded → return the stored result, write nothing
3. if `if_version` is present and does not match `rev` → return a conflict, write nothing
4. write hash fields; `LPUSH` the version snapshot; `LTRIM`; update the three index sets; set
   `memop:<operation_id>` with its TTL; `HINCRBY rev 1`

This replaces the pipeline in the `memory_set` path only. Other tools are untouched.

### Response shapes

Success gains one field and is otherwise unchanged:

```json
{"ok": true, "id": "…", "operation": "created|modified", "revision": 7, "warning": null}
```

Conflict is a structured result, not a generic error:

```json
{"ok": false, "error": "conflict", "id": "…", "current_revision": 9, "expected_version": 7}
```

Replay returns the original outcome plus a marker:

```json
{"ok": true, "id": "…", "operation": "modified", "revision": 7, "replayed": true}
```

### Zero side effects on conflict

A conflict must leave everything untouched: no version pushed to `memver:`, no index set modified,
no `hits` change, no TTL refresh, and **no `memory_write_total` increment**. `server.js` exports
Prometheus metrics, so a conflict must instead increment a new `memory_conflict_total`. Without this,
conflicts would read as successful writes on the dashboard.

`memory_get` returns `revision` so a client can read, compose, and write conditionally.

## Client contract

The consuming flusher retries a bounded number of times. On conflict it **reloads the entry and
recomposes the merge** against the new body rather than replaying a stale one, then retries with the
new revision. Replaying a stale body would reintroduce the lost update the feature exists to prevent.

## Testing

- unconditional `memory_set` behaves exactly as before, including for entries with no `rev`
- `if_version` matching applies; non-matching returns conflict and writes nothing
- **two writers hold the same revision; exactly one succeeds and the other gets a conflict carrying
  the current revision**
- `if_version: 0` creates when absent, conflicts when present with a `rev`, succeeds once for a
  legacy entry with no `rev`
- `rev` starts at 1 and increments once per mutation
- **`memory_get` does not move `rev`** despite incrementing `hits`
- `memory_rollback` and `memory_delete` both move `rev`
- delete then re-create continues the sequence; a stale `if_version` from before the delete is
  rejected
- replaying an `operation_id` returns the prior result, writes nothing, and leaves `rev` unchanged
- `memop:` keys expire after the retention window
- conflict leaves `memver`, index sets, `hits` and TTL untouched, and increments
  `memory_conflict_total` rather than `memory_write_total`
- concurrency: N parallel conditional writers against one entry produce exactly one winner per
  revision and no interleaved partial state

## Out of scope

- Conditional semantics for `memory_delete` and `memory_rollback`. Add later if a caller needs them.
- Any change to search, indexing or pruning.
