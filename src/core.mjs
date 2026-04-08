/**
 * wemust core — deterministic agent orchestration engine
 *
 * All state transitions, validation, locking, and event logging.
 * No CLI concerns — pure logic that can be imported by CLI, MCP server, or web UI.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const DEFAULT_TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_RETRIES = 3;
const CRITERION_TIMEOUT_MS = 30_000;

// ═══════════════════════════════════════════════════════════════════════
// File Locking — atomic mkdir
// ═══════════════════════════════════════════════════════════════════════

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      writeFileSync(resolve(lockPath, "pid"), String(process.pid));
      return;
    } catch (err) {
      if (err.code === "EEXIST") {
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* spin */ }
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Failed to acquire lock at ${lockPath} after ${LOCK_TIMEOUT_MS}ms`
  );
}

function releaseLock(lockPath) {
  try {
    const pidFile = resolve(lockPath, "pid");
    if (existsSync(pidFile)) unlinkSync(pidFile);
    rmdirSync(lockPath);
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════════════════════════════════
// Manifest — load, save, validate
// ═══════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} Criterion
 * @property {string} name
 * @property {string} command
 */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 * @property {'pending'|'in_progress'|'validating'|'completed'|'failed'|'abandoned'} status
 * @property {string|null} agent
 * @property {{writes?: string[], reads?: string[]}} [resources]
 * @property {string[]} [blocked_by]
 * @property {Criterion[]} [acceptance_criteria]
 * @property {number} [priority]  — higher = more important
 * @property {number} [max_retries]
 * @property {number} [retry_count]
 * @property {number} [ttl_ms]
 * @property {string} [claimed_at]
 * @property {string} [completed_at]
 * @property {Object[]} [failure_details]
 * @property {Object[]} [reopen_history]
 * @property {string[]} [artifacts]
 * @property {Object} [context]
 */

/**
 * @typedef {Object} Agent
 * @property {string} id
 * @property {'available'|'busy'|'offline'} status
 * @property {string|null} current_task
 * @property {string} [registered_at]
 * @property {string} [last_heartbeat]
 */

/**
 * @typedef {Object} Manifest
 * @property {string} project
 * @property {string|null} orchestrator
 * @property {Task[]} tasks
 * @property {Agent[]} [agents]
 */

export function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(`No wemust.json found at ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (!manifest.agents) manifest.agents = [];
  return manifest;
}

export function saveManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Execute fn with exclusive manifest access. fn receives manifest, returns truthy to save.
 */
export function withLock(manifestPath, fn) {
  const lockPath = manifestPath.replace(/\.json$/, ".lock");
  acquireLock(lockPath);
  try {
    const manifest = loadManifest(manifestPath);
    const shouldSave = fn(manifest);
    if (shouldSave) saveManifest(manifestPath, manifest);
    return manifest;
  } finally {
    releaseLock(lockPath);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Schema Validation
// ═══════════════════════════════════════════════════════════════════════

export function validateManifest(manifest) {
  const errors = [];

  if (!manifest.project) errors.push("Missing 'project' field.");
  if (!Array.isArray(manifest.tasks)) errors.push("Missing 'tasks' array.");

  const ids = new Set();
  for (const task of manifest.tasks ?? []) {
    if (!task.id) errors.push(`Task missing 'id'.`);
    if (!task.title) errors.push(`Task ${task.id ?? "?"} missing 'title'.`);
    if (ids.has(task.id)) errors.push(`Duplicate task ID: ${task.id}`);
    ids.add(task.id);

    for (const depId of task.blocked_by ?? []) {
      if (!ids.has(depId) && !(manifest.tasks ?? []).some((t) => t.id === depId)) {
        errors.push(`Task ${task.id} blocked_by '${depId}' which doesn't exist.`);
      }
    }

    for (const c of task.acceptance_criteria ?? []) {
      if (!c.name) errors.push(`Task ${task.id}: criterion missing 'name'.`);
      if (!c.command) errors.push(`Task ${task.id}: criterion '${c.name ?? "?"}' missing 'command'.`);
    }
  }

  return errors;
}

// ═══════════════════════════════════════════════════════════════════════
// Event Log
// ═══════════════════════════════════════════════════════════════════════

export function logEvent(manifestPath, event) {
  const logPath = manifestPath.replace(/\.json$/, ".log");
  const ts = new Date().toISOString();
  const line = `${ts}  ${event.taskId ?? "—"}  ${event.transition ?? event.type}  ${event.detail ?? ""}\n`;
  appendFileSync(logPath, line);
}

function emitEvent(manifestPath, taskId, transition, detail) {
  logEvent(manifestPath, { taskId, transition, detail });
}

// ═══════════════════════════════════════════════════════════════════════
// Queries (read-only, no lock needed)
// ═══════════════════════════════════════════════════════════════════════

export function findTask(manifest, taskId) {
  return manifest.tasks.find((t) => t.id === taskId) ?? null;
}

export function getBlockers(manifest, task) {
  if (!task.blocked_by?.length) return [];
  return task.blocked_by.filter((depId) => {
    const dep = findTask(manifest, depId);
    return dep && dep.status !== "completed";
  });
}

export function getUnblockedPending(manifest) {
  return manifest.tasks
    .filter((t) => t.status === "pending" && getBlockers(manifest, t).length === 0)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function getResourceLocks(manifest) {
  const locks = {};
  for (const task of manifest.tasks) {
    if (task.status === "in_progress" || task.status === "claimed") {
      for (const r of task.resources?.writes ?? []) {
        locks[r] = task.id;
      }
    }
  }
  return locks;
}

export function getResourceConflicts(manifest, task) {
  const locks = getResourceLocks(manifest);
  return (task.resources?.writes ?? [])
    .filter((r) => locks[r] && locks[r] !== task.id)
    .map((r) => ({ resource: r, heldBy: locks[r] }));
}

export function getStaleTasks(manifest) {
  const now = Date.now();
  return manifest.tasks.filter((t) => {
    if (t.status !== "in_progress") return false;
    const ttl = t.ttl_ms ?? DEFAULT_TASK_TTL_MS;
    const claimedAt = t.claimed_at ? new Date(t.claimed_at).getTime() : 0;
    return claimedAt > 0 && now - claimedAt > ttl;
  });
}

export function findAgent(manifest, agentId) {
  return manifest.agents?.find((a) => a.id === agentId) ?? null;
}

// ═══════════════════════════════════════════════════════════════════════
// Acceptance Criteria Runner
// ═══════════════════════════════════════════════════════════════════════

export function runCriteria(task, cwd) {
  const results = [];
  for (const criterion of task.acceptance_criteria ?? []) {
    const start = Date.now();
    try {
      const stdout = execSync(criterion.command, {
        cwd,
        stdio: "pipe",
        timeout: CRITERION_TIMEOUT_MS,
      });
      results.push({
        name: criterion.name,
        command: criterion.command,
        pass: true,
        stdout: stdout?.toString()?.slice(0, 500) ?? "",
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        name: criterion.name,
        command: criterion.command,
        pass: false,
        exitCode: err.status ?? 1,
        stdout: err.stdout?.toString()?.slice(0, 500) ?? "",
        stderr: err.stderr?.toString()?.slice(0, 500) ?? "",
        error: err.stderr?.toString()?.slice(0, 500) || err.stdout?.toString()?.slice(0, 500) || err.message,
        durationMs: Date.now() - start,
      });
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
// Commands (mutating — use withLock externally, or call locked variants)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Initialize a new wemust project.
 */
export function initProject(manifestPath, projectName) {
  if (existsSync(manifestPath)) {
    throw new Error(`wemust.json already exists at ${manifestPath}`);
  }
  const manifest = {
    project: projectName,
    orchestrator: null,
    tasks: [],
    agents: [],
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  saveManifest(manifestPath, manifest);
  logEvent(manifestPath, { type: "project_init", detail: projectName });
  return manifest;
}

/**
 * Add a task to the manifest.
 */
export function addTask(manifest, manifestPath, opts) {
  // Auto-generate ID
  const prefix = manifest.project?.toUpperCase()?.slice(0, 6) ?? "TASK";
  const maxNum = manifest.tasks.reduce((max, t) => {
    const match = t.id.match(new RegExp(`^${prefix}-(\\d+)$`));
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);
  const id = opts.id ?? `${prefix}-${maxNum + 1}`;

  const task = {
    id,
    title: opts.title,
    description: opts.description ?? null,
    status: "pending",
    agent: null,
    resources: {
      writes: opts.writes ?? [],
      reads: opts.reads ?? [],
    },
    blocked_by: opts.blocked_by ?? [],
    acceptance_criteria: (opts.criteria ?? []).map((c) =>
      typeof c === "string"
        ? { name: c, command: c }
        : c
    ),
    priority: opts.priority ?? 0,
    max_retries: opts.max_retries ?? DEFAULT_MAX_RETRIES,
    retry_count: 0,
    ttl_ms: opts.ttl_ms ?? DEFAULT_TASK_TTL_MS,
    context: opts.context ?? null,
  };

  manifest.tasks.push(task);
  emitEvent(manifestPath, id, "task_added", task.title);
  return task;
}

/**
 * Claim a task for an agent.
 */
export function claimTask(manifest, manifestPath, taskId, agentId) {
  const task = findTask(manifest, taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  if (task.status !== "pending" && task.status !== "failed") {
    throw new Error(`Cannot claim task in status "${task.status}". Must be pending or failed.`);
  }

  const blockers = getBlockers(manifest, task);
  if (blockers.length) {
    throw new Error(`Task ${taskId} is blocked by: ${blockers.join(", ")}`);
  }

  const conflicts = getResourceConflicts(manifest, task);
  if (conflicts.length) {
    const detail = conflicts.map((c) => `"${c.resource}" locked by ${c.heldBy}`).join(", ");
    throw new Error(`Resource conflict: ${detail}`);
  }

  task.status = "in_progress";
  task.agent = agentId;
  task.claimed_at = new Date().toISOString();
  delete task.failure_details;

  // Update agent registry
  const agent = findAgent(manifest, agentId);
  if (agent) {
    agent.status = "busy";
    agent.current_task = taskId;
  }

  emitEvent(manifestPath, taskId, "pending → in_progress", `agent=${agentId}`);
  return task;
}

/**
 * Release a claimed task back to pending.
 */
export function releaseTask(manifest, manifestPath, taskId) {
  const task = findTask(manifest, taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  const prevAgent = task.agent;
  task.status = "pending";
  task.agent = null;
  delete task.claimed_at;

  if (prevAgent) {
    const agent = findAgent(manifest, prevAgent);
    if (agent) {
      agent.status = "available";
      agent.current_task = null;
    }
  }

  emitEvent(manifestPath, taskId, "released → pending", `was=${prevAgent}`);
  return task;
}

/**
 * Submit a task — run acceptance criteria and transition state.
 * Returns { passed, results, task }.
 */
export function submitTask(manifest, manifestPath, taskId, cwd) {
  const task = findTask(manifest, taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  if (task.status !== "in_progress") {
    throw new Error(`Cannot submit task in status "${task.status}". Must be in_progress.`);
  }

  emitEvent(manifestPath, taskId, "in_progress → validating", "");

  const results = runCriteria(task, cwd);
  const allPass = results.every((r) => r.pass);

  if (allPass) {
    task.status = "completed";
    task.completed_at = new Date().toISOString();
    task.artifacts = (task.resources?.writes ?? []).filter((f) => {
      try { return existsSync(resolve(cwd, f)); } catch { return false; }
    });
    delete task.failure_details;

    // Free agent
    const agent = findAgent(manifest, task.agent);
    if (agent) {
      agent.status = "available";
      agent.current_task = null;
    }

    emitEvent(manifestPath, taskId, "validating → completed", `criteria=${results.length}/${results.length}`);

    // Find newly unblocked tasks
    const unblocked = manifest.tasks.filter(
      (t) =>
        t.blocked_by?.includes(taskId) &&
        t.status === "pending" &&
        getBlockers(manifest, t).length === 0
    );

    return { passed: true, results, task, unblocked };
  } else {
    task.retry_count = (task.retry_count ?? 0) + 1;
    const maxRetries = task.max_retries ?? DEFAULT_MAX_RETRIES;

    if (task.retry_count >= maxRetries) {
      task.status = "abandoned";
      task.failure_details = results.filter((r) => !r.pass);
      emitEvent(manifestPath, taskId, "validating → abandoned", `retries=${task.retry_count}/${maxRetries}`);
    } else {
      task.status = "failed";
      task.failure_details = results.filter((r) => !r.pass);
      emitEvent(manifestPath, taskId, "validating → failed", `retry ${task.retry_count}/${maxRetries}`);
    }

    const passed = results.filter((r) => r.pass).length;
    return { passed: false, results, task, unblocked: [] };
  }
}

/**
 * Reopen a completed or failed task.
 */
export function reopenTask(manifest, manifestPath, taskId, reason, requestedBy) {
  const task = findTask(manifest, taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  if (task.status !== "completed" && task.status !== "failed" && task.status !== "abandoned") {
    throw new Error(`Cannot reopen task in status "${task.status}".`);
  }

  if (!task.reopen_history) task.reopen_history = [];
  task.reopen_history.push({
    at: new Date().toISOString(),
    previousStatus: task.status,
    previousAgent: task.agent,
    reason: reason || "Reopened for rework",
    requestedBy: requestedBy || "orchestrator",
  });

  task.status = "pending";
  task.agent = null;
  task.retry_count = 0;
  delete task.completed_at;
  delete task.failure_details;

  emitEvent(manifestPath, taskId, `${task.reopen_history.at(-1).previousStatus} → pending (reopen)`, reason);

  // Find downstream tasks that might be affected
  const dependents = manifest.tasks.filter(
    (t) => t.blocked_by?.includes(taskId) && t.status !== "pending"
  );

  return { task, dependents };
}

/**
 * Record agent heartbeat.
 */
export function heartbeat(manifest, manifestPath, agentId) {
  let agent = findAgent(manifest, agentId);
  if (!agent) {
    // Auto-register on first heartbeat
    agent = { id: agentId, status: "available", current_task: null, registered_at: new Date().toISOString() };
    manifest.agents.push(agent);
  }
  agent.last_heartbeat = new Date().toISOString();
  if (agent.current_task) {
    agent.status = "busy";
  }
  return agent;
}

/**
 * Register an agent.
 */
export function registerAgent(manifest, manifestPath, agentId) {
  if (findAgent(manifest, agentId)) {
    throw new Error(`Agent ${agentId} already registered.`);
  }
  const agent = {
    id: agentId,
    status: "available",
    current_task: null,
    registered_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
  };
  manifest.agents.push(agent);
  emitEvent(manifestPath, null, "agent_registered", agentId);
  return agent;
}

/**
 * Unregister an agent.
 */
export function unregisterAgent(manifest, manifestPath, agentId) {
  const idx = manifest.agents.findIndex((a) => a.id === agentId);
  if (idx === -1) throw new Error(`Agent ${agentId} not found.`);
  const agent = manifest.agents[idx];

  // Release any claimed task
  if (agent.current_task) {
    const task = findTask(manifest, agent.current_task);
    if (task && task.status === "in_progress") {
      task.status = "pending";
      task.agent = null;
      delete task.claimed_at;
      emitEvent(manifestPath, task.id, "released (agent unregistered)", agentId);
    }
  }

  manifest.agents.splice(idx, 1);
  emitEvent(manifestPath, null, "agent_unregistered", agentId);
}

/**
 * Expire stale tasks — release tasks that exceeded their TTL.
 */
export function expireStaleTasks(manifest, manifestPath) {
  const stale = getStaleTasks(manifest);
  for (const task of stale) {
    const prevAgent = task.agent;
    task.status = "pending";
    task.agent = null;
    delete task.claimed_at;

    if (prevAgent) {
      const agent = findAgent(manifest, prevAgent);
      if (agent) {
        agent.status = "offline";
        agent.current_task = null;
      }
    }

    emitEvent(manifestPath, task.id, "in_progress → pending (expired)", `was=${prevAgent}, ttl=${task.ttl_ms ?? DEFAULT_TASK_TTL_MS}ms`);
  }
  return stale;
}

/**
 * Auto-assign unblocked tasks to available agents (round-robin by priority).
 */
export function autoAssign(manifest, manifestPath) {
  const available = (manifest.agents ?? []).filter((a) => a.status === "available");
  const ready = getUnblockedPending(manifest); // already sorted by priority

  const assignments = [];
  let agentIdx = 0;

  for (const task of ready) {
    if (agentIdx >= available.length) break;

    const conflicts = getResourceConflicts(manifest, task);
    if (conflicts.length) continue;

    const agent = available[agentIdx];
    task.status = "in_progress";
    task.agent = agent.id;
    task.claimed_at = new Date().toISOString();
    delete task.failure_details;

    agent.status = "busy";
    agent.current_task = task.id;

    assignments.push({ taskId: task.id, agentId: agent.id });
    emitEvent(manifestPath, task.id, "pending → in_progress (auto)", `agent=${agent.id}`);
    agentIdx++;
  }

  return assignments;
}

/**
 * Get a full status snapshot for the dashboard.
 */
export function getSnapshot(manifest) {
  const tasks = manifest.tasks;
  const agents = manifest.agents ?? [];

  return {
    project: manifest.project,
    summary: {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      in_progress: tasks.filter((t) => t.status === "in_progress").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      abandoned: tasks.filter((t) => t.status === "abandoned").length,
    },
    agents: agents.map((a) => ({
      id: a.id,
      status: a.status,
      currentTask: a.current_task,
      lastHeartbeat: a.last_heartbeat,
    })),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      agent: t.agent,
      priority: t.priority ?? 0,
      retries: `${t.retry_count ?? 0}/${t.max_retries ?? DEFAULT_MAX_RETRIES}`,
      blocked: getBlockers(manifest, t),
      artifacts: t.artifacts ?? [],
    })),
    resourceLocks: getResourceLocks(manifest),
    readyToClaim: getUnblockedPending(manifest).map((t) => t.id),
  };
}
