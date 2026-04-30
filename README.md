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
| `memory_set` | Create or update an entry (versioned on every write) |
| `memory_list` | List entries with optional type/project filter |
| `memory_delete` | Delete an entry (tombstone version written first) |
| `memory_history` | View version history for an entry |
| `memory_rollback` | Restore an entry to a previous version |
| `memory_prune_candidates` | Surface zero-hit stale entries for review (read-only) |

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
