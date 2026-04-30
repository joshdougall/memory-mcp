# memory-mcp

Persistent, searchable, versioned memory for AI agents — backed by [Valkey](https://valkey.io) (Redis-compatible), exposed as an [MCP](https://modelcontextprotocol.io) server over HTTP.

Designed for Claude Code, but works with any MCP-compatible client.

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
docker compose up -d
```

The MCP server is now available at `http://127.0.0.1:3106/mcp`.

Register it with Claude Code:

```bash
# Without auth
claude mcp add memory --transport http http://127.0.0.1:3106/mcp

# With auth (set MEMORY_MCP_AUTH_TOKEN in .env first)
claude mcp add memory --transport http http://127.0.0.1:3106/mcp \
  --header "Authorization: Bearer your-token-here"
```

## Configuration

Copy `.env.example` to `.env` and edit as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_MCP_BIND` | `127.0.0.1` | Interface to bind on. Use `0.0.0.0` only with `AUTH_TOKEN` set. |
| `MEMORY_MCP_HOST_PORT` | `3106` | Port exposed on the host |
| `MEMORY_MCP_AUTH_TOKEN` | _(empty)_ | Bearer token for `/mcp`. Empty = no auth. Generate: `openssl rand -hex 32` |
| `MEMORY_MCP_MAX_ENTRIES_WARN` | `300` | Soft cap — warns on write when exceeded |
| `MEMORY_MCP_MAX_VERSIONS_PER_ENTRY` | `20` | Max version snapshots per entry |
| `MEMORY_MCP_MEM_LIMIT` | `256m` | Container memory cap |
| `VALKEY_IMAGE` | `valkey/valkey:9.0.3` | Valkey image to use |

## Auth

By default the server runs unauthenticated. This is safe when bound to loopback (`127.0.0.1`) and accessed only from the local machine.

To enable auth, set `MEMORY_MCP_AUTH_TOKEN` in `.env`:

```bash
# Generate a token
openssl rand -hex 32

# Add to .env
MEMORY_MCP_AUTH_TOKEN=abc123...

# Restart
docker compose up -d
```

All requests to `POST /mcp` must include:
```
Authorization: Bearer <token>
```

`GET /health` and `GET /metrics` are always unauthenticated.

### Registering with a token

**Claude Code CLI:**
```bash
claude mcp add memory --transport http http://127.0.0.1:3106/mcp \
  --header "Authorization: Bearer your-token-here"
```

**Manual config** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "http://127.0.0.1:3106/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

## Available tools

| Tool | Description |
|------|-------------|
| `memory_search` | Search by tags (intersection), type, project, or text substring |
| `memory_get` | Fetch one entry by ID (increments hit counter) |
| `memory_set` | Create or update an entry (versioned on every write) |
| `memory_list` | List entries with optional type/project filter |
| `memory_delete` | Delete an entry (tombstone version written first) |
| `memory_history` | View version history for an entry |
| `memory_rollback` | Restore an entry to a previous version |
| `memory_prune_candidates` | Surface zero-hit stale entries for review (read-only) |

## Memory types

`pattern`, `decision`, `reference`, `feedback`, `incident`, `project`, `entity`, `state`

## CLAUDE.md snippet

Paste this into your project's `CLAUDE.md`:

```markdown
## Shared Memory (Valkey MCP)

A shared memory MCP server is running at `http://127.0.0.1:3106/mcp`.

**At session start:** Run `memory_search` with tags relevant to the current project before asking the user to re-explain context.

**When to write:** When you discover a pattern, decision, reference, or feedback that applies across sessions. Set `source` to `"claude-code"` and `project` to the current project name (or `""` for cross-project entries).

**When NOT to write:** Ephemeral task state, code patterns obvious from reading the repo, anything already documented in CLAUDE.md.

**Types:** `pattern`, `decision`, `reference`, `feedback`, `incident`, `project`, `entity`, `state`

**Tools:** `memory_search`, `memory_get`, `memory_set`, `memory_list`, `memory_delete`, `memory_history`, `memory_rollback`, `memory_prune_candidates`
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/mcp` | if configured | MCP JSON-RPC endpoint |
| `GET` | `/health` | none | Health check |
| `GET` | `/metrics` | none | Prometheus metrics |

## Data model

Each entry is stored as a Redis hash at `mem:<id>` with the following fields:

| Field | Description |
|-------|-------------|
| `title` | Short descriptive title |
| `body` | Full content |
| `type` | Entry type (see above) |
| `tags` | Comma-separated tag list |
| `source` | Who wrote it |
| `project` | Project scope (empty = cross-project) |
| `created` | ISO date of creation |
| `updated` | ISO date of last update |
| `hits` | Times retrieved via `memory_get` |
| `ttl` | Expiry in seconds (optional) |

Version history is stored in a Redis list at `memver:<id>` (newest-first, capped at `MAX_VERSIONS_PER_ENTRY`).

Tag, type, and project indexes are Redis sets (`tag:<name>`, `type:<name>`, `project:<name>`).

## License

MIT
