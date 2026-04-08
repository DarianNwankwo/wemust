# wemust

Deterministic orchestration for AI agents. Agents do the creative work — coordination runs on state machines, exit codes, and file locks. No LLM inference in the coordination loop.

## The Problem

When multiple AI agents work on a project simultaneously, you need coordination: who works on what, when tasks are done, what's blocked, what conflicts. Most approaches solve this with more LLM inference — an "orchestrator agent" that makes judgment calls.

This is fragile. LLMs hallucinate, lose context, and make inconsistent decisions. Coordination doesn't need intelligence — it needs determinism.

## The Idea

Separate the stochastic (creative work) from the deterministic (coordination):

- **Agents** claim tasks, write code, and submit work. This is where LLM inference happens.
- **wemust** validates submissions against executable acceptance criteria (shell commands that return exit code 0 or non-zero), transitions task states, locks resources, and unblocks dependents. No LLM involved.

The acceptance criteria ARE the specification. If `pnpm type-check` returns 0, the task passes. If it returns non-zero, it fails. The agent's opinion doesn't matter.

## Quick Start

```bash
# Initialize a project
node bin/wemust.mjs init my-project

# Add tasks with executable acceptance criteria
node bin/wemust.mjs add "Create user model" \
  --writes src/user.mjs \
  --criterion "File exists:test -f src/user.mjs" \
  --criterion "Exports User:node -e \"import('./src/user.mjs').then(m => { if (!m.User) process.exit(1) })\""

node bin/wemust.mjs add "Create user tests" \
  --writes test/user.test.mjs \
  --reads src/user.mjs \
  --blocked-by MY-PRO-1 \
  --criterion "Tests pass:node test/user.test.mjs"

# Register agents
node bin/wemust.mjs register --agent worker-1
node bin/wemust.mjs register --agent worker-2

# Agents claim and work tasks
node bin/wemust.mjs claim MY-PRO-1 --agent worker-1
# ... agent writes the code ...
node bin/wemust.mjs submit MY-PRO-1

# Watch everything
node bin/wemust.mjs orchestrate --auto-assign
```

## How It Works

### Task State Machine

Every transition is deterministic — triggered by events, not LLM judgment:

```
pending → in_progress → validating → completed
                            ↓
                          failed → (re-claim) → in_progress
                            ↓ (after max_retries)
                         abandoned
```

### Acceptance Criteria = Shell Commands

```json
{
  "acceptance_criteria": [
    { "name": "Types compile", "command": "pnpm type-check" },
    { "name": "Tests pass", "command": "pnpm test" },
    { "name": "File exists", "command": "test -f src/model.ts" }
  ]
}
```

Exit code 0 = pass. Anything else = fail. No interpretation needed.

### Resource Locking

Tasks declare what they read and write. Two agents can't write the same resource simultaneously:

```json
{
  "resources": {
    "writes": ["src/auth.ts", "src/middleware.ts"],
    "reads": ["src/types.ts"]
  }
}
```

### Dependency Blocking

Tasks can declare dependencies. Blocked tasks can't be claimed until dependencies complete:

```json
{ "blocked_by": ["TASK-1", "TASK-2"] }
```

When TASK-1 and TASK-2 both complete, the blocked task automatically becomes claimable.

## CLI Reference

### Project Management

| Command | Description |
|---|---|
| `init <name>` | Initialize a new wemust project |
| `add "title" [options]` | Add a task |
| `check` | Validate the manifest |
| `snapshot` | JSON snapshot (for dashboards/APIs) |

### Task Operations

| Command | Description |
|---|---|
| `list [--status <s>]` | List tasks, optionally filtered |
| `status <taskId>` | Full task details + failure context |
| `claim <taskId> --agent <id>` | Claim a task (atomic, checks locks + deps) |
| `release <taskId>` | Release a claimed task back to pending |
| `submit <taskId>` | Run acceptance criteria, transition state |
| `validate <taskId>` | Dry-run criteria (no state change) |
| `reopen <taskId> [--reason <text>]` | Reopen completed/failed/abandoned task |

### Agent Management

| Command | Description |
|---|---|
| `register --agent <id>` | Register a worker agent |
| `unregister --agent <id>` | Unregister (releases any claimed tasks) |
| `heartbeat --agent <id>` | Record heartbeat (prevents TTL expiry) |
| `agents` | List registered agents |

### Orchestration

| Command | Description |
|---|---|
| `orchestrate [--poll <ms>] [--auto-assign]` | Watch mode — monitors state, expires stale tasks, optionally auto-assigns |

### Add Task Options

```
--writes <resource>          Resource this task writes (repeatable)
--reads <resource>           Resource this task reads (repeatable)
--blocked-by <taskId>        Dependency (repeatable)
--criterion "name:command"   Acceptance criterion (repeatable)
--priority <n>               Higher = dispatched first (default 0)
--max-retries <n>            Failures before abandoned (default 3)
--desc "description"         Task description
--context '{"key":"val"}'    JSON context passed to the worker
```

## Features

- **File locking** — Atomic `mkdir`-based lock prevents concurrent manifest corruption
- **Resource conflicts** — Detected deterministically from task declarations
- **Dependency chains** — Tasks auto-unblock when dependencies complete
- **Priority ordering** — Higher priority tasks are dispatched first
- **Max retries** — Tasks escalate to `abandoned` after N failures
- **Task TTL** — Stale tasks auto-release after timeout (default 30 min)
- **Agent registry** — Track available workers, heartbeat for liveness
- **Auto-assign** — Orchestrator round-robins unblocked tasks to available agents
- **Event log** — Append-only `wemust.log` records every state transition
- **Artifact tracking** — Records which files a task actually created on completion
- **Reopen with history** — Reopen completed tasks with reason tracking, warns about downstream impact
- **Rich failure context** — Failed criteria capture exit code, stdout, stderr
- **Schema validation** — Catches manifest errors before they cause runtime failures
- **JSON snapshot** — `snapshot` command outputs dashboard-ready JSON

## Architecture

```
src/core.mjs    — Engine: state machine, locking, validation, events
bin/wemust.mjs  — CLI: human/agent interface to the engine
docs/PROTOCOL.md — Agent-readable spec (drop into CLAUDE.md)
```

The core is a pure-logic module with no CLI concerns. Import it directly:

```javascript
import { claimTask, submitTask, withLock } from "wemust/core";
```

This enables building on top of wemust:
- **MCP server** — Expose as tools for Claude Code, Cursor, etc.
- **Web dashboard** — Read `snapshot` output to render a task board
- **CI integration** — Run `wemust submit` in CI pipelines

## Using with AI Agents

Copy `docs/PROTOCOL.md` into your project's `CLAUDE.md` (or equivalent). Any sufficiently intelligent LLM will follow the protocol:

1. `list --status pending` to see available tasks
2. `claim <taskId> --agent <id>` to take ownership
3. Read the task description and acceptance criteria
4. Do the creative work
5. `validate <taskId>` to check before submitting
6. `submit <taskId>` to finalize

The criteria encode the interface contracts, so agents working in parallel on independent tasks will produce compatible outputs — as long as the criteria are specific enough.

## Manifest Format

Projects are defined in `wemust.json`:

```json
{
  "project": "my-app",
  "orchestrator": null,
  "tasks": [
    {
      "id": "MY-APP-1",
      "title": "Create the parser",
      "description": "Build a markdown parser that exports parse(text)",
      "status": "pending",
      "agent": null,
      "resources": { "writes": ["src/parser.mjs"], "reads": [] },
      "blocked_by": [],
      "acceptance_criteria": [
        { "name": "File exists", "command": "test -f src/parser.mjs" },
        { "name": "Parses headings", "command": "node -e \"...\"" }
      ],
      "priority": 0,
      "max_retries": 3,
      "ttl_ms": 1800000,
      "context": { "notes": "Use regex, no external deps" }
    }
  ],
  "agents": []
}
```

## Roadmap

- [ ] MCP server — Expose wemust as tools for LLM agents
- [ ] Web dashboard — Real-time task board powered by `snapshot`
- [ ] Task templates — Reusable acceptance criteria patterns
- [ ] `wemust wait <taskId>` — Block until a task becomes claimable
- [ ] Webhook notifications — HTTP callbacks on state transitions

## License

MIT
# wemust
