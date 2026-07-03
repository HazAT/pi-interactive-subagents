import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// ── Types ────────────────────────────────────────────────────────────────────

export type HookEventName = "subagent-start" | "subagent-status" | "subagent-stop";

type LiveStatus = "starting" | "active" | "waiting" | "stalled" | "running";
type FinalStatus = "done" | "failed" | "cancelled";

interface HookBasePayload {
  version: 1;
  source: "pi-interactive-subagents";
  event: HookEventName;
  id: string;
  name: string;
  agent?: string;
  timestamp: string;
  sequence: number;
  session_file?: string;
  elapsed_ms?: number;
}

export type HookPayload =
  | (HookBasePayload & { event: "subagent-start"; status: "starting"; cwd?: string; surface?: string; interactive?: boolean })
  | (HookBasePayload & { event: "subagent-status"; status: LiveStatus; tool_name?: string; active_scope?: string; latest_event?: string; error?: string })
  | (HookBasePayload & { event: "subagent-stop"; status: FinalStatus; exit_code?: number; error?: string });

interface HookCommand {
  command: string;
  args: string[];
  events?: HookEventName[];
}

export interface HooksConfig {
  enabled?: boolean;
  status_throttle_ms?: number;
  timeout_ms?: number;
  commands?: HookCommand[];
}

// ── State ────────────────────────────────────────────────────────────────────

const DEFAULT_STATUS_THROTTLE_MS = 5000;
const DEFAULT_TIMEOUT_MS = 1000;

let sequenceCounter = 0;
const lastStatusBySubagent = new Map<string, LiveStatus>();
const lastStatusHookTime = new Map<string, number>();

// ── Config ───────────────────────────────────────────────────────────────────

export function loadHooksConfig(configPath?: string): HooksConfig | null {
  // 优先级：用户指定路径 > 用户级配置 > 插件级配置
  const paths = configPath
    ? [configPath]
    : [
        join(homedir(), ".pi", "agent", "hooks.json"),
        join(homedir(), ".omp", "agent", "hooks.json"),
        join(SUBAGENTS_DIR, "../..", "config.json"),
      ];

  for (const p of paths) {
    try {
      const raw = readFileSync(p, "utf8");
      const config = JSON.parse(raw);
      const hooks = config.hooks ?? null;
      if (hooks) return hooks;
    } catch {
      // 继续尝试下一个路径
    }
  }
  return null;
}

// ── Fire ─────────────────────────────────────────────────────────────────────

/**
 * Fire a hook by invoking the configured commands.
 * Each command receives the event name as a positional argument,
 * and the payload as a single JSON object on stdin.
 *
 * Example invocation:
 *   tmux-agent-sidebar hook pi subagent-start
 *   stdin: {"version":1,"source":"pi-interactive-subagents",...}
 *
 * Fire-and-forget: we don't await hook commands.
 * Fail-open: spawn failures never affect subagent lifecycle.
 */
export function fireHook(config: HooksConfig | null, event: HookEventName, payload: HookPayload): void {
  if (!config?.enabled) return;
  if (!config.commands?.length) return;

  // Status throttle: only throttle repeated same-status, not transitions
  if (event === "subagent-status") {
    const lastStatus = lastStatusBySubagent.get(payload.id);
    if (lastStatus === payload.status) {
      const throttleMs = config.status_throttle_ms ?? DEFAULT_STATUS_THROTTLE_MS;
      const lastTime = lastStatusHookTime.get(payload.id) ?? 0;
      if (Date.now() - lastTime < throttleMs) return;
    }
    lastStatusBySubagent.set(payload.id, payload.status);
    lastStatusHookTime.set(payload.id, Date.now());
  }

  const jsonPayload = JSON.stringify(payload);
  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  for (const cmd of config.commands) {
    if (cmd.events && !cmd.events.includes(event)) continue;

    try {
      const args = [...cmd.args, event];
      const child = spawn(cmd.command, args, {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
      });

      // Write payload to stdin and close
      child.stdin?.write(jsonPayload);
      child.stdin?.end();

      // Timeout guard
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
      }, timeoutMs);

      child.on("exit", () => clearTimeout(timer));
      child.on("error", () => clearTimeout(timer));

      child.unref();
    } catch {
      // Fail-open: swallow errors silently
    }
  }
}

/**
 * Clean up state for a finished subagent.
 */
export function cleanupHookState(id: string): void {
  lastStatusBySubagent.delete(id);
  lastStatusHookTime.delete(id);
}

/**
 * Get next sequence number for ordering.
 */
export function nextSequence(): number {
  return ++sequenceCounter;
}

// ── Lifecycle helpers ────────────────────────────────────────────────────────

/**
 * Emit subagent-start hook when a subagent is registered.
 */
export function emitSubagentStart(
  config: HooksConfig | null,
  opts: { id: string; name: string; agent?: string; sessionFile?: string; cwd?: string; surface?: string; interactive?: boolean },
): void {
  fireHook(config, "subagent-start", {
    version: 1,
    source: "pi-interactive-subagents",
    event: "subagent-start",
    id: opts.id,
    name: opts.name,
    agent: opts.agent,
    timestamp: new Date().toISOString(),
    sequence: nextSequence(),
    session_file: opts.sessionFile,
    status: "starting",
    cwd: opts.cwd,
    surface: opts.surface,
    interactive: opts.interactive,
  });
}

/**
 * Emit subagent-status hook during polling.
 */
export function emitSubagentStatus(
  config: HooksConfig | null,
  opts: { id: string; name: string; agent?: string; sessionFile?: string; status: LiveStatus; toolName?: string; activeScope?: string; latestEvent?: string; error?: string; elapsedMs?: number },
): void {
  fireHook(config, "subagent-status", {
    version: 1,
    source: "pi-interactive-subagents",
    event: "subagent-status",
    id: opts.id,
    name: opts.name,
    agent: opts.agent,
    timestamp: new Date().toISOString(),
    sequence: nextSequence(),
    session_file: opts.sessionFile,
    elapsed_ms: opts.elapsedMs,
    status: opts.status,
    tool_name: opts.toolName,
    active_scope: opts.activeScope,
    latest_event: opts.latestEvent,
    error: opts.error,
  });
}

/**
 * Emit subagent-stop hook when a subagent is unregistered.
 */
export function emitSubagentStop(
  config: HooksConfig | null,
  opts: { id: string; name: string; agent?: string; sessionFile?: string; status: FinalStatus; exitCode?: number; error?: string; elapsedMs?: number },
): void {
  fireHook(config, "subagent-stop", {
    version: 1,
    source: "pi-interactive-subagents",
    event: "subagent-stop",
    id: opts.id,
    name: opts.name,
    agent: opts.agent,
    timestamp: new Date().toISOString(),
    sequence: nextSequence(),
    session_file: opts.sessionFile,
    elapsed_ms: opts.elapsedMs,
    status: opts.status,
    exit_code: opts.exitCode,
    error: opts.error,
  });

  cleanupHookState(opts.id);
}
