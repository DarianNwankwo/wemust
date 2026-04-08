# wemust — Development Guide

## What This Is

wemust is a deterministic agent orchestration CLI. It coordinates AI agents through executable acceptance criteria — no LLM inference in the coordination loop.

## Project Structure

```
src/core.mjs      — Engine: all state machine logic, locking, validation, events
bin/wemust.mjs    — CLI: parses args, calls core functions, formats output
docs/PROTOCOL.md  — Agent-readable protocol spec (for LLM workers)
```

`core.mjs` is the source of truth. The CLI is a thin wrapper. Any new transport (MCP server, web API) should import from core, not duplicate logic.

## Key Design Decisions

**No external dependencies.** The entire project runs on Node.js built-ins (`fs`, `child_process`, `path`). This is intentional — wemust should work anywhere Node runs without `npm install`.

**File-based state.** The manifest is `wemust.json`, the event log is `wemust.log`, the lock is `.wemust.lock/` (a directory, because `mkdir` is atomic). No database, no server process required for basic use.

**Deterministic transitions.** Every state transition is triggered by a concrete event (command exit code, timeout expiry, explicit user action). No function in core.mjs makes a judgment call — it's all `if/then`.

**Acceptance criteria are commands.** A criterion is `{ name: string, command: string }`. The command runs in a shell. Exit 0 = pass, non-zero = fail. stdout and stderr are captured for failure diagnostics.

## Working on wemust

### Adding a new command

1. Add the core logic as a function in `src/core.mjs` — pure logic, no console output
2. Add the CLI wrapper in `bin/wemust.mjs` — parse args, call core, format output
3. Use `withLock()` for any function that mutates the manifest
4. Call `emitEvent()` for any state transition (this writes to `wemust.log`)

### Testing

Run the CLI against a temp project:

```bash
cd /tmp && mkdir test-wemust && cd test-wemust
node ~/Development/wemust/bin/wemust.mjs init test
node ~/Development/wemust/bin/wemust.mjs add "Hello world" --criterion "true:true"
node ~/Development/wemust/bin/wemust.mjs claim TEST-1 --agent test
node ~/Development/wemust/bin/wemust.mjs submit TEST-1
```

### Conventions

- All exports from `core.mjs` take `manifest` and `manifestPath` as first args (manifest for the data, path for event logging)
- Read-only functions don't need locks — they call `loadManifest()` directly
- Mutating functions should be called inside `withLock()` by the caller (CLI or MCP server)
- The CLI should never import from anywhere except `../src/core.mjs`
- Event log lines are tab-separated: `timestamp  taskId  transition  detail`

## Upcoming Work

### MCP Server (priority)

Wrap core functions as MCP tools. Each CLI command maps to one tool:

| CLI Command | MCP Tool | Description |
|---|---|---|
| `list` | `list_tasks` | Returns task array |
| `claim` | `claim_task` | Claims task, returns result |
| `submit` | `submit_task` | Runs criteria, returns pass/fail + details |
| `status` | `get_task` | Returns full task object |
| `reopen` | `reopen_task` | Reopens, returns affected dependents |

The MCP server should import from `src/core.mjs` and use `withLock()` for mutations. No new state management logic — just transport.

### Web Dashboard

The `snapshot` command returns a JSON object with everything the dashboard needs:

```javascript
import { loadManifest, getSnapshot } from "wemust/core";
const manifest = loadManifest("./wemust.json");
const data = getSnapshot(manifest);
// data.summary, data.tasks, data.agents, data.resourceLocks, data.readyToClaim
```

Serve this on a local HTTP endpoint. The frontend can be a single HTML file with inline JS that polls the endpoint.

### Task Templates

Allow defining reusable acceptance criteria patterns:

```json
{
  "templates": {
    "node-module": [
      { "name": "File exists", "command": "test -f {{file}}" },
      { "name": "Exports function", "command": "node -e \"import('./{{file}}').then(m => { if (typeof m.{{export}} !== 'function') process.exit(1) })\"" }
    ]
  }
}
```

Add to the manifest schema. `addTask` would accept `--template node-module --file src/parser.mjs --export parse`.
