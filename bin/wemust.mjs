#!/usr/bin/env node

/**
 * wemust CLI — deterministic agent orchestration
 */

import { resolve } from "node:path";
import {
  loadManifest,
  withLock,
  validateManifest,
  findTask,
  getBlockers,
  getUnblockedPending,
  getStaleTasks,
  runCriteria,
  initProject,
  addTask,
  claimTask,
  releaseTask,
  submitTask,
  reopenTask,
  registerAgent,
  unregisterAgent,
  heartbeat,
  expireStaleTasks,
  autoAssign,
  getSnapshot,
} from "../src/core.mjs";

const MANIFEST = resolve(process.cwd(), "wemust.json");
const args = process.argv.slice(2);
const cmd = args[0];

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

function getArgAll(flag) {
  const values = [];
  let idx = args.indexOf(flag);
  while (idx !== -1) {
    if (args[idx + 1]) values.push(args[idx + 1]);
    idx = args.indexOf(flag, idx + 1);
  }
  return values;
}

function getRestAfter(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args.slice(idx + 1).join(" ") : null;
}

// ─── Output helpers ───

function printList(manifest, statusFilter) {
  const tasks = statusFilter
    ? manifest.tasks.filter((t) => t.status === statusFilter)
    : manifest.tasks;

  if (!tasks.length) { console.log("No tasks found."); return; }

  console.log(`\n  ${"ID".padEnd(12)} ${"STATUS".padEnd(14)} ${"PRI".padEnd(4)} ${"AGENT".padEnd(12)} TITLE`);
  console.log(`  ${"─".repeat(12)} ${"─".repeat(14)} ${"─".repeat(4)} ${"─".repeat(12)} ${"─".repeat(30)}`);
  for (const t of tasks) {
    const pri = t.priority ?? 0;
    console.log(`  ${t.id.padEnd(12)} ${t.status.padEnd(14)} ${String(pri).padEnd(4)} ${(t.agent ?? "—").padEnd(12)} ${t.title}`);
  }
  console.log();
}

function printTask(manifest, taskId) {
  const task = findTask(manifest, taskId);
  if (!task) { console.error(`Task ${taskId} not found.`); process.exit(1); }

  console.log(`\n  Task:       ${task.id}`);
  console.log(`  Title:      ${task.title}`);
  if (task.description) console.log(`  Desc:       ${task.description}`);
  console.log(`  Status:     ${task.status}`);
  console.log(`  Agent:      ${task.agent ?? "unassigned"}`);
  console.log(`  Priority:   ${task.priority ?? 0}`);
  console.log(`  Retries:    ${task.retry_count ?? 0}/${task.max_retries ?? 3}`);
  console.log(`  TTL:        ${(task.ttl_ms ?? 1800000) / 1000}s`);
  console.log(`  Writes:     ${(task.resources?.writes ?? []).join(", ") || "none"}`);
  console.log(`  Reads:      ${(task.resources?.reads ?? []).join(", ") || "none"}`);
  console.log(`  Blocked by: ${(task.blocked_by ?? []).join(", ") || "none"}`);
  console.log(`  Criteria:   ${(task.acceptance_criteria ?? []).length} checks`);
  if (task.artifacts?.length) console.log(`  Artifacts:  ${task.artifacts.join(", ")}`);
  if (task.context) console.log(`  Context:    ${JSON.stringify(task.context)}`);
  if (task.failure_details?.length) {
    console.log(`  Failures:`);
    for (const f of task.failure_details) {
      console.log(`    ✗ ${f.name}`);
      console.log(`      command:   ${f.command}`);
      if (f.exitCode !== undefined) console.log(`      exit code: ${f.exitCode}`);
      if (f.stderr) console.log(`      stderr:    ${f.stderr.split("\n")[0]}`);
      if (f.stdout) console.log(`      stdout:    ${f.stdout.split("\n")[0]}`);
    }
  }
  if (task.reopen_history?.length) {
    console.log(`  Reopen history:`);
    for (const r of task.reopen_history) {
      console.log(`    - ${r.at} by ${r.requestedBy}: ${r.reason}`);
    }
  }
  console.log();
}

// ─── Command dispatch ───

try {
  switch (cmd) {
    case "init": {
      const name = args[1];
      if (!name) { console.error("Usage: wemust init <project-name>"); process.exit(1); }
      initProject(MANIFEST, name);
      console.log(`Initialized wemust project "${name}" at ${MANIFEST}`);
      break;
    }

    case "add": {
      const title = args[1];
      if (!title) { console.error("Usage: wemust add \"Task title\" [options]"); process.exit(1); }

      withLock(MANIFEST, (manifest) => {
        const task = addTask(manifest, MANIFEST, {
          title,
          description: getArg("--desc"),
          writes: getArgAll("--writes"),
          reads: getArgAll("--reads"),
          blocked_by: getArgAll("--blocked-by"),
          criteria: getArgAll("--criterion").map((c) => {
            const [name, ...cmdParts] = c.split(":");
            return cmdParts.length ? { name: name.trim(), command: cmdParts.join(":").trim() } : { name: c, command: c };
          }),
          priority: getArg("--priority") ? parseInt(getArg("--priority"), 10) : 0,
          max_retries: getArg("--max-retries") ? parseInt(getArg("--max-retries"), 10) : undefined,
          context: getArg("--context") ? JSON.parse(getArg("--context")) : undefined,
        });
        console.log(`Added task ${task.id}: "${task.title}"`);
        return true;
      });
      break;
    }

    case "list": {
      const manifest = loadManifest(MANIFEST);
      const errors = validateManifest(manifest);
      if (errors.length) {
        console.error("Manifest validation errors:");
        errors.forEach((e) => console.error(`  - ${e}`));
      }
      printList(manifest, getArg("--status"));
      break;
    }

    case "status": {
      const manifest = loadManifest(MANIFEST);
      printTask(manifest, args[1]);
      break;
    }

    case "claim": {
      const agentId = getArg("--agent");
      if (!agentId) { console.error("--agent is required."); process.exit(1); }
      withLock(MANIFEST, (manifest) => {
        const task = claimTask(manifest, MANIFEST, args[1], agentId);
        console.log(`Task ${task.id} claimed by ${agentId}. Status: in_progress`);
        return true;
      });
      break;
    }

    case "release": {
      withLock(MANIFEST, (manifest) => {
        const task = releaseTask(manifest, MANIFEST, args[1]);
        console.log(`Task ${task.id} released. Status: pending`);
        return true;
      });
      break;
    }

    case "submit": {
      // Run criteria outside lock (can be slow), then lock to update state
      const manifest = loadManifest(MANIFEST);
      const task = findTask(manifest, args[1]);
      if (!task) { console.error(`Task ${args[1]} not found.`); process.exit(1); }
      if (task.status !== "in_progress") {
        console.error(`Cannot submit task in status "${task.status}". Must be in_progress.`);
        process.exit(1);
      }

      console.log(`\nValidating ${args[1]}...`);
      const results = runCriteria(task, process.cwd());
      const allPass = results.every((r) => r.pass);

      for (const r of results) {
        console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
        if (!r.pass && r.stderr) console.log(`         stderr: ${r.stderr.split("\n")[0]}`);
        if (!r.pass && r.stdout) console.log(`         stdout: ${r.stdout.split("\n")[0]}`);
      }

      withLock(MANIFEST, (m) => {
        const result = submitTask(m, MANIFEST, args[1], process.cwd());
        if (result.passed) {
          console.log(`\n  ✓ Task ${args[1]} COMPLETED (${results.length}/${results.length} criteria passed)\n`);
          for (const u of result.unblocked) {
            console.log(`  → Task ${u.id} is now unblocked and ready to claim.`);
          }
          if (result.task.artifacts?.length) {
            console.log(`  Artifacts: ${result.task.artifacts.join(", ")}`);
          }
        } else {
          const passed = results.filter((r) => r.pass).length;
          const retryInfo = `(retry ${result.task.retry_count}/${result.task.max_retries ?? 3})`;
          console.log(`\n  ✗ Task ${args[1]} ${result.task.status.toUpperCase()} ${retryInfo} (${passed}/${results.length} criteria passed)\n`);
        }
        return true;
      });
      break;
    }

    case "validate": {
      const manifest = loadManifest(MANIFEST);
      const task = findTask(manifest, args[1]);
      if (!task) { console.error(`Task ${args[1]} not found.`); process.exit(1); }
      console.log(`\nDry-run validation for ${args[1]}...`);
      const results = runCriteria(task, process.cwd());
      for (const r of results) {
        console.log(`  [dry-run] ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
      }
      const passed = results.filter((r) => r.pass).length;
      console.log(`\n  ${passed}/${results.length} criteria would pass.\n`);
      break;
    }

    case "reopen": {
      const reason = getRestAfter("--reason");
      withLock(MANIFEST, (manifest) => {
        const { task, dependents } = reopenTask(manifest, MANIFEST, args[1], reason);
        console.log(`Task ${task.id} reopened. Status: pending`);
        if (reason) console.log(`  Reason: ${reason}`);
        if (dependents.length) {
          console.log(`\n  ⚠ Downstream tasks may be affected:`);
          for (const d of dependents) {
            console.log(`    - ${d.id} (${d.status}) depends on ${task.id}`);
          }
        }
        return true;
      });
      break;
    }

    case "register": {
      const agentId = getArg("--agent") ?? args[1];
      if (!agentId) { console.error("Usage: wemust register --agent <id>"); process.exit(1); }
      withLock(MANIFEST, (manifest) => {
        registerAgent(manifest, MANIFEST, agentId);
        console.log(`Agent ${agentId} registered.`);
        return true;
      });
      break;
    }

    case "unregister": {
      const agentId = getArg("--agent") ?? args[1];
      if (!agentId) { console.error("Usage: wemust unregister --agent <id>"); process.exit(1); }
      withLock(MANIFEST, (manifest) => {
        unregisterAgent(manifest, MANIFEST, agentId);
        console.log(`Agent ${agentId} unregistered.`);
        return true;
      });
      break;
    }

    case "heartbeat": {
      const agentId = getArg("--agent") ?? args[1];
      if (!agentId) { console.error("Usage: wemust heartbeat --agent <id>"); process.exit(1); }
      withLock(MANIFEST, (manifest) => {
        heartbeat(manifest, MANIFEST, agentId);
        return true;
      });
      break;
    }

    case "agents": {
      const manifest = loadManifest(MANIFEST);
      const agents = manifest.agents ?? [];
      if (!agents.length) { console.log("No agents registered."); break; }
      console.log(`\n  ${"ID".padEnd(14)} ${"STATUS".padEnd(12)} ${"TASK".padEnd(12)} LAST HEARTBEAT`);
      console.log(`  ${"─".repeat(14)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(24)}`);
      for (const a of agents) {
        console.log(`  ${a.id.padEnd(14)} ${a.status.padEnd(12)} ${(a.current_task ?? "—").padEnd(12)} ${a.last_heartbeat ?? "never"}`);
      }
      console.log();
      break;
    }

    case "snapshot": {
      const manifest = loadManifest(MANIFEST);
      console.log(JSON.stringify(getSnapshot(manifest), null, 2));
      break;
    }

    case "orchestrate": {
      const pollMs = getArg("--poll") ? parseInt(getArg("--poll"), 10) : 2000;
      const doAutoAssign = args.includes("--auto-assign");

      console.log(`\n  wemust orchestrator started (poll=${pollMs}ms, auto-assign=${doAutoAssign})\n`);

      const manifest = loadManifest(MANIFEST);
      printList(manifest, null);

      const ready = getUnblockedPending(manifest);
      if (ready.length) {
        console.log(`  Ready to claim:`);
        for (const t of ready) console.log(`    🟢 ${t.id}: "${t.title}"`);
        console.log();
      }

      let prevStates = {};
      for (const t of manifest.tasks) prevStates[t.id] = t.status;

      const poll = () => {
        withLock(MANIFEST, (m) => {
          // Expire stale tasks
          const expired = expireStaleTasks(m, MANIFEST);
          for (const t of expired) {
            console.log(`  [${ts()}] ⏰ ${t.id} expired (TTL exceeded), released to pending`);
          }

          // Auto-assign if enabled
          if (doAutoAssign) {
            const assignments = autoAssign(m, MANIFEST);
            for (const a of assignments) {
              console.log(`  [${ts()}] 📋 Auto-assigned ${a.taskId} → ${a.agentId}`);
            }
          }

          // Detect state changes
          for (const task of m.tasks) {
            const prev = prevStates[task.id];
            if (prev && prev !== task.status) {
              console.log(`  [${ts()}] ${task.id}: ${prev} → ${task.status}${task.agent ? ` (${task.agent})` : ""}`);
            }
            prevStates[task.id] = task.status;
          }

          // Report newly ready tasks
          const nowReady = getUnblockedPending(m);
          for (const t of nowReady) {
            if (prevStates[t.id] === "pending") {
              // Only report if it just became unblocked (deps changed)
            }
          }

          // Check all done
          if (m.tasks.every((t) => t.status === "completed")) {
            console.log(`\n  ✓ All ${m.tasks.length} tasks completed.\n`);
            for (const t of m.tasks) {
              const reopens = t.reopen_history?.length ?? 0;
              const note = reopens > 0 ? ` (reopened ${reopens}x)` : "";
              console.log(`    ${t.id.padEnd(12)} ${(t.agent ?? "—").padEnd(12)} completed${note}`);
            }
            console.log();
            process.exit(0);
          }

          // Stuck detection
          const incomplete = m.tasks.filter((t) => t.status !== "completed");
          const inProg = incomplete.filter((t) => t.status === "in_progress" || t.status === "validating");
          const readyNow = getUnblockedPending(m);
          if (inProg.length === 0 && readyNow.length === 0 && incomplete.length > 0) {
            const failed = incomplete.filter((t) => t.status === "failed" || t.status === "abandoned");
            console.log(`\n  ⚠ Stuck: ${failed.length} failed/abandoned, nothing in progress or ready.`);
          }

          return expired.length > 0 || (doAutoAssign && m.tasks.some((t) => t.status === "in_progress"));
        });
      };

      const ts = () => new Date().toISOString().slice(11, 19);
      setInterval(poll, pollMs);
      break;
    }

    case "check": {
      const manifest = loadManifest(MANIFEST);
      const errors = validateManifest(manifest);
      if (errors.length) {
        console.error(`\n  ${errors.length} validation error(s):\n`);
        errors.forEach((e) => console.error(`    - ${e}`));
        console.log();
        process.exit(1);
      } else {
        console.log(`\n  ✓ Manifest is valid. ${manifest.tasks.length} tasks, ${(manifest.agents ?? []).length} agents.\n`);
      }
      break;
    }

    default:
      console.log(`
  wemust — Deterministic agent orchestration

  Project:
    init <name>                           Initialize a new wemust project
    add "title" [options]                 Add a task
    check                                 Validate the manifest
    snapshot                              JSON snapshot (for dashboard/API)

  Tasks:
    list [--status <status>]              List tasks
    status <taskId>                       Task details + failure context
    claim <taskId> --agent <id>           Claim a task (atomic, locks resources)
    release <taskId>                      Release a claimed task
    submit <taskId>                       Run criteria, transition state
    validate <taskId>                     Dry-run criteria (no state change)
    reopen <taskId> [--reason <text>]     Reopen completed/failed/abandoned task

  Agents:
    register --agent <id>                 Register a worker agent
    unregister --agent <id>               Unregister (releases claimed tasks)
    heartbeat --agent <id>                Record agent heartbeat
    agents                                List registered agents

  Orchestration:
    orchestrate [--poll <ms>] [--auto-assign]
                                          Watch mode — monitor, expire stale,
                                          optionally auto-assign to agents

  Add task options:
    --writes <resource>                   Resource this task writes (repeatable)
    --reads <resource>                    Resource this task reads (repeatable)
    --blocked-by <taskId>                 Dependency (repeatable)
    --criterion "name:command"            Acceptance criterion (repeatable)
    --priority <n>                        Priority (higher = first, default 0)
    --max-retries <n>                     Max retries before abandoned (default 3)
    --desc "description"                  Task description
    --context '{"key":"value"}'           JSON context for the worker
`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
