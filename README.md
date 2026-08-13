# memory-mcp

Persistent, searchable, versioned memory for AI agents — backed by [Valkey](https://valkey.io) (Redis-compatible), exposed as an [MCP](https://modelcontextprotocol.io) server over HTTP.

Works with any MCP-compatible agent: Claude Code, Cursor, VS Code, and others.

## What it does

- Stores named memory entries with tags, types, and project scopes
- Tag-intersection search, type/project filtering, and substring search
- Hit tracking (entries accessed more float to the top)
- Full version history with rollback
- Prometheus metrics endpoint
- Optional bearer token auth

## Quick start

```bash
cp .env.example .env
# Optional: set MEMORY_MCP_AUTH_TOKEN in .env (see Auth section)
docker compose up -d
```

This pulls the pre-built image from GHCR. The MCP server is now available at `http://127.0.0.1:3106/mcp`.

**To build locally instead:**

```bash
docker compose build
docker compose up -d
```

## Using an existing Redis or Valkey

By default `docker compose up -d` starts a bundled Valkey container. To connect to an existing Redis or Valkey instance instead, set `VALKEY_URL` and start only the `memory-mcp` service:

```bash
# .env
VALKEY_URL=redis://your-host:6379

docker compose up -d memory-mcp
```

Any Redis-compatible server (Redis 6+, Valkey, KeyDB, Upstash via `rediss://`, etc.) works. The server uses only basic data structures: hashes, lists, and sets.

## Agent setup

Copy `AGENTS.md` from this repo into your project root. It tells your agent how to use the memory tools, what to store, and when.

Then register the MCP server with your agent client:

### Claude Code

```bash
# Without auth
claude mcp add memory --transport http http://127.0.0.1:3106/mcp

# With auth
claude mcp add memory --transport http http://127.0.0.1:3106/mcp \
  --header "Authorization: Bearer your-token"
```

Or add manually to `~/.claude.json`:

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "http://127.0.0.1:3106/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://127.0.0.1:3106/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

### VS Code (GitHub Copilot, MCP extension)

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "memory": {
      "type": "http",
      "url": "http://127.0.0.1:3106/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

Omit the `headers` / `Authorization` line in any config if you are not using auth.

## Configuration

Copy `.env.example` to `.env` and edit as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_MCP_BIND` | `127.0.0.1` | Interface to bind on. Use `0.0.0.0` only with `AUTH_TOKEN` set. |
| `MEMORY_MCP_HOST_PORT` | `3106` | Port exposed on the host |
| `MEMORY_MCP_AUTH_TOKEN` | _(empty)_ | Bearer token for `/mcp`. Empty = no auth. Generate: `openssl rand -hex 32` |
| `MEMORY_MCP_MAX_ENTRIES_WARN` | `300` | Soft cap — warns on write when exceeded |
| `MEMORY_MCP_MAX_VERSIONS_PER_ENTRY` | `20` | Max version snapshots per entry |
| `MEMORY_MCP_OPERATION_ID_TTL_SECONDS` | `604800` | How long an `operation_id` stays recorded for idempotent retries (7 days) |
| `MEMORY_MCP_MEM_LIMIT` | `256m` | Container memory cap |
| `VALKEY_IMAGE` | `valkey/valkey:9.0.3` | Valkey image to use |

## Auth

By default the server runs unauthenticated. This is safe when bound to loopback (`127.0.0.1`) and accessed only from the local machine.

To enable auth:

```bash
# Generate a token
openssl rand -hex 32

# Add to .env
MEMORY_MCP_AUTH_TOKEN=your-generated-token

docker compose up -d
```

All requests to `POST /mcp` must then include:

```
Authorization: Bearer <token>
```

`GET /health` and `GET /metrics` are always unauthenticated.

## Available tools

| Tool | Description |
|------|-------------|
| `memory_search` | Search by tags (intersection), type, project, or text substring |
| `memory_get` | Fetch one entry by ID (increments hit counter) |
| `memory_set` | Create or update an entry (versioned on every write, optional compare-and-set) |
| `memory_list` | List entries with optional type/project filter |
| `memory_delete` | Delete an entry (tombstone version written first) |
| `memory_history` | View version history for an entry |
| `memory_rollback` | Restore an entry to a previous version |
| `memory_prune_candidates` | Surface zero-hit stale entries for review (read-only) |

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

The revision counter outlives the entry it belongs to when the entry is **deleted**. After
a delete, a re-created entry continues the sequence instead of restarting at 1, so a stale
`if_version` from before the delete cannot match. One consequence: `if_version=0` against a
deleted id returns a conflict carrying the current revision rather than creating. Retry
with that revision.

Natural TTL expiry is different: the counter and the version history share a TTL entry's
lifetime and expire with it, so an expired id is a clean slate and `if_version=0` creates
it again at revision 1. Removing an entry's TTL persists all three keys together.

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

An `operation_id` names one write to one entry. Reusing a recorded id against a different
entry is rejected with `{"ok": false, "error": "operation_id_mismatch", "recorded_id": ...}`
rather than silently replaying the other entry's result and dropping the write.

Conflicts are counted separately from writes in the metrics: `memory_conflict_total` rather
than `memory_write_total`.

## Memory types

`pattern`, `decision`, `reference`, `feedback`, `incident`, `project`, `entity`, `state`

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/mcp` | if configured | MCP JSON-RPC endpoint |
| `GET` | `/health` | none | Health check |
| `GET` | `/metrics` | none | Prometheus metrics |

## Data model

Each entry is stored as a Redis hash at `mem:<id>`:

| Field | Description |
|-------|-------------|
| `title` | Short descriptive title |
| `body` | Full content |
| `type` | Entry type |
| `tags` | Comma-separated tag list (tags may not be empty or contain commas; enforced on write) |
| `source` | Who wrote it |
| `project` | Project scope (empty = cross-project) |
| `created` | ISO date of creation |
| `updated` | ISO date of last update |
| `hits` | Times retrieved via `memory_get` |
| `ttl` | Expiry in seconds (optional) |

Version history is stored in a Redis list at `memver:<id>` (newest-first, capped at
`MAX_VERSIONS_PER_ENTRY`). Each snapshot records the `rev` it was written at.

The revision counter is a separate string key, `memrev:<id>`. It is deliberately not a field
on the entry hash: it has to survive `memory_delete`, which deletes that hash. It is
incremented only on semantic mutation, never by `memory_get`.

`memver:<id>` and `memrev:<id>` share a TTL entry's lifetime: they expire alongside it and
are persisted when its TTL is removed. `memory_delete` persists both, so the tombstone and
the counter outlive any TTL the entry carried.

Every mutation (`memory_set`, `memory_rollback`, `memory_delete`) executes as a single Lua
script, so index membership, history order, and the revision counter can never interleave
across concurrent writers.

Recorded `operation_id` values are hashes at `memop:<operation_id>` holding `memory_id`,
`revision` and `action`, expiring after `MEMORY_MCP_OPERATION_ID_TTL_SECONDS`.

Tag, type, and project indexes are Redis sets (`tag:<name>`, `type:<name>`, `project:<name>`).

## License

MIT
