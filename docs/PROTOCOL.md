# wemust Agent Protocol

You are interacting with a **wemust** orchestrated project. This document tells you exactly how to participate as a worker agent. Follow it mechanically.

## Your Role

You are a **worker agent**. Your job:
1. Claim a task
2. Do the creative work (write code, create files, etc.)
3. Submit the task for validation
4. If validation fails, fix your work and submit again

You do NOT decide whether your work passes — the validator does. You do NOT update task states — the CLI does. You do NOT resolve conflicts — the orchestrator does.

## Commands

All commands run from the project root (where `wemust.json` lives).

### See what's available

```bash
node wemust.mjs list                    # all tasks
node wemust.mjs list --status pending   # only claimable tasks
node wemust.mjs status <TASK-ID>        # full task details
```

### Claim a task

```bash
node wemust.mjs claim <TASK-ID> --agent <YOUR-AGENT-ID>
```

This will fail if:
- The task is blocked by incomplete dependencies
- Another agent holds a conflicting resource lock
- The task is not in `pending` or `failed` status

### Do the work

Read the task's `description` and `context` fields. Create the files, write the code, do whatever the task requires. The `acceptance_criteria` tell you exactly what must be true when you're done.

### Validate (dry-run)

```bash
node wemust.mjs validate <TASK-ID>
```

This runs the acceptance criteria without changing state. Use it to check your work before submitting.

### Submit

```bash
node wemust.mjs submit <TASK-ID>
```

This runs all acceptance criteria. If ALL pass (exit code 0), the task moves to `completed`. If ANY fail, it moves to `failed` and you can see what went wrong:

```bash
node wemust.mjs status <TASK-ID>
```

The failure details include the command, exit code, stdout, and stderr for each failed criterion.

### Retry after failure

If submission failed, fix the issue and submit again:

```bash
# Task is now in "failed" status — re-claim it
node wemust.mjs claim <TASK-ID> --agent <YOUR-AGENT-ID>
# Fix the code...
node wemust.mjs submit <TASK-ID>
```

After `max_retries` failures (default 3), the task moves to `abandoned` and requires manual intervention via `reopen`.

### Heartbeat (if long-running)

If your task takes more than a few minutes, send heartbeats to prevent timeout:

```bash
node wemust.mjs heartbeat --agent <YOUR-AGENT-ID>
```

Tasks have a TTL (default 30 minutes). If you don't submit or heartbeat within that window, the task is automatically released for another agent.

## What You Must NOT Do

- Do NOT edit `wemust.json` directly — use the CLI
- Do NOT write to files claimed by another task's `resources.writes`
- Do NOT decide whether criteria passed — the validator's exit code is the source of truth
- Do NOT skip validation — always submit through the CLI

## Reading Acceptance Criteria

Each criterion has a `name` and a `command`. The command is a shell command that returns exit code 0 for pass, non-zero for fail. Read the commands to understand what your code must do:

```json
{
  "name": "Exports greet function",
  "command": "node -e \"import('./src/greet.mjs').then(m => { if (typeof m.greet !== 'function') process.exit(1) })\""
}
```

This tells you: the file must export a function called `greet`. The criteria ARE the specification.

## Task Lifecycle

```
pending → in_progress → validating → completed
                            ↓
                          failed → (re-claim) → in_progress → ...
                            ↓ (after max_retries)
                         abandoned
```

You only control `pending → in_progress` (claim) and `in_progress → validating` (submit). Everything else is automatic.
