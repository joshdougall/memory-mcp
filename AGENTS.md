# Agent Memory Instructions

A persistent memory MCP server is running and available to you. Use it to store and retrieve knowledge that should survive across sessions — decisions, patterns, references, and feedback that would otherwise be lost when the conversation ends.

## Connection

- **Endpoint:** `http://127.0.0.1:3106/mcp` (MCP over HTTP, Streamable HTTP transport)
- **Auth:** If `MEMORY_MCP_AUTH_TOKEN` was set, include `Authorization: Bearer <token>` in requests. Check with the user if unsure.

## When to read

At the start of each session, search for memories relevant to the current project or task before asking the user to re-explain context:

```
memory_search(tags=["your-project-name"])
```

## When to write

Write when you discover something that should be remembered across sessions:
- A pattern or convention the user corrected you on
- An architectural decision and its rationale
- A reference to an external resource or tool
- A recurring preference or feedback
- A project-level fact (deadline, constraint, stakeholder)

Do not write:
- Ephemeral task state (use a STATE.md file for that)
- Code patterns obvious from reading the repo
- Anything already documented in project files

## Memory types

| Type | Use for |
|------|---------|
| `pattern` | Recurring conventions, idioms, or approaches |
| `decision` | Architectural or technical choices with rationale |
| `reference` | Pointers to external resources, docs, or tools |
| `feedback` | How the user wants you to behave or approach work |
| `incident` | Post-mortems and lessons from failures |
| `project` | Project-level facts (team, deadlines, constraints) |
| `entity` | Named things (people, systems, accounts) |
| `state` | Short-lived state that spans a few sessions |

## Available tools

| Tool | Description |
|------|-------------|
| `memory_search` | Filter by tags (intersection), type, project, or text |
| `memory_get` | Fetch one entry by ID — increments hit counter |
| `memory_set` | Create or update an entry — versioned on every write, optional compare-and-set |
| `memory_list` | List entries with optional type/project filter |
| `memory_delete` | Delete an entry (tombstone version written first) |
| `memory_history` | View version history for an entry |
| `memory_rollback` | Restore an entry to a previous version |
| `memory_prune_candidates` | Surface zero-hit stale entries for review (read-only) |

## Safe concurrent writes

If several agents or machines may write the same entry, pass the `revision` you read from
`memory_get` back as `if_version`:

```
memory_get(id="my-entry")                     -> { ..., "revision": 7 }
memory_set(id="my-entry", ..., if_version=7)
```

A mismatch returns `{"ok": false, "error": "conflict", "id": ..., "current_revision": N,
"expected_version": M}` and writes nothing. Re-read the entry, recompose your change against
the current body, and retry with the revision the conflict reported. Do not replay your
original body.

For retry-safety across a crash, pass a unique `operation_id`. Replaying it returns the
original result with `"replayed": true` and writes nothing. An `operation_id` names one
write to one entry: reusing it for a different id is rejected with
`"error": "operation_id_mismatch"`.

## Conventions

- `id`: slug-style, descriptive — e.g. `myproject-db-choice`, `deploy-never-force-push`
- `tags`: include the project name and topic — e.g. `["myproject", "database"]`. Tags must be non-empty and must not contain commas (the server rejects both)
- `project`: project name for project-specific entries, empty string for cross-project knowledge
- `source`: set to the agent or person writing the entry — e.g. `"claude-code"`, `"cursor"`, `"josh"`

## Example — saving a decision

```
memory_set(
  id="myproject-db-choice",
  title="PostgreSQL over MySQL for myproject",
  body="Chose PostgreSQL for JSONB support and team familiarity. MySQL evaluated and rejected.",
  type="decision",
  tags=["myproject", "database", "infrastructure"],
  source="claude-code",
  project="myproject"
)
```

## Example — saving feedback

```
memory_set(
  id="feedback-no-trailing-summaries",
  title="Do not summarize completed work at end of response",
  body="User finds trailing summaries redundant. End responses with what's next, not what was done.",
  type="feedback",
  tags=["feedback", "communication"],
  source="claude-code",
  project=""
)
```
