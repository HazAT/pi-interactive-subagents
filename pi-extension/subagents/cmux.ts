import { execSync, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

function muxPreference(): MuxBackend | null {
  const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (pref === "cmux" || pref === "tmux" || pref === "zellij" || pref === "wezterm") return pref;
  return null;
}

function isCmuxRuntimeAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function isTmuxRuntimeAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

function isZellijRuntimeAvailable(): boolean {
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

function isWezTermRuntimeAvailable(): boolean {
  return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
}

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
  return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
  return isZellijRuntimeAvailable();
}

export function isWezTermAvailable(): boolean {
  return isWezTermRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;
  if (pref === "wezterm") return isWezTermRuntimeAvailable() ? "wezterm" : null;

  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isTmuxRuntimeAvailable()) return "tmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  if (isWezTermRuntimeAvailable()) return "wezterm";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  const pref = muxPreference();
  if (pref === "cmux") {
    return "Start pi inside cmux (`cmux pi`).";
  }
  if (pref === "tmux") {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  }
  if (pref === "zellij") {
    return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
  }
  if (pref === "wezterm") {
    return "Start pi inside WezTerm.";
  }
  return "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), or WezTerm.";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  return backend;
}

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish).
 */
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

function zellijPaneId(surface: string): string {
  return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (surface) {
    env.ZELLIJ_PANE_ID = zellijPaneId(surface);
  }
  return env;
}

/**
 * Pane-scoped zellij actions that must target a specific pane via --pane-id
 * (the ZELLIJ_PANE_ID env var is ignored by most of these).
 * See https://github.com/HazAT/pi-interactive-subagents/issues/19
 */
const ZELLIJ_PANE_SCOPED_ACTIONS = new Set([
  "close-pane",
  "dump-screen",
  "rename-pane",
  "move-pane",
  "write",
  "write-chars",
  "send-keys",
]);

function zellijActionArgs(args: string[], surface?: string): string[] {
  if (!surface) return ["action", ...args];
  const action = args[0];
  if (!ZELLIJ_PANE_SCOPED_ACTIONS.has(action)) return ["action", ...args];
  // Don't double-add if caller already specified it.
  if (args.includes("--pane-id") || args.includes("-p")) return ["action", ...args];
  return ["action", action, "--pane-id", zellijPaneId(surface), ...args.slice(1)];
}

function zellijActionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
}

async function zellijActionAsync(args: string[], surface?: string): Promise<string> {
  const { stdout } = await execFileAsync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
  return stdout;
}

/** Tracked subagent pane for cmux — reused across subagent launches. */
let cmuxSubagentPane: string | null = null;

/**
 * Create a new terminal surface for a subagent.
 *
 * For cmux: the first call creates a right-split pane; subsequent calls add
 * tabs to that same pane (avoiding ever-narrower splits).
 * For tmux/zellij/wezterm: falls back to split behavior.
 *
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm).
 */
export function createSurface(name: string): string {
  const backend = getMuxBackend();

  if (backend === "cmux" && cmuxSubagentPane) {
    // Verify the pane still exists before adding a tab to it
    try {
      const tree = execSync(`cmux tree`, { encoding: "utf8" });
      if (tree.includes(cmuxSubagentPane)) {
        return createSurfaceInPane(name, cmuxSubagentPane);
      }
    } catch {}
    // Pane is gone — fall through to create a new split
    cmuxSubagentPane = null;
  }

  // On tmux, target the parent pi's pane so splits follow the agent, not the user's focus.
  // See https://github.com/HazAT/pi-interactive-subagents/issues/12
  const fromSurface = backend === "tmux" ? process.env.TMUX_PANE : undefined;
  const surface = createSurfaceSplit(name, "right", fromSurface);

  // For cmux, remember the pane so future subagents become tabs in it
  if (backend === "cmux") {
    try {
      const info = execSync(`cmux identify --surface ${shellEscape(surface)}`, {
        encoding: "utf8",
      });
      const parsed = JSON.parse(info);
      const paneRef = parsed?.caller?.pane_ref;
      if (paneRef) {
        cmuxSubagentPane = paneRef;
      }
    } catch {}
  }

  return surface;
}

/**
 * Create a new surface (tab) in an existing cmux pane.
 */
function createSurfaceInPane(name: string, pane: string): string {
  const out = execSync(`cmux new-surface --pane ${shellEscape(pane)}`, {
    encoding: "utf8",
  }).trim();
  const match = out.match(/surface:\d+/);
  if (!match) {
    throw new Error(`Unexpected cmux new-surface output: ${out}`);
  }
  const surface = match[0];
  execSync(`cmux rename-tab --surface ${shellEscape(surface)} ${shellEscape(name)}`, {
    encoding: "utf8",
  });
  return surface;
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const surfaceArg = fromSurface ? ` --surface ${shellEscape(fromSurface)}` : "";
    const out = execSync(`cmux new-split ${direction}${surfaceArg}`, {
      encoding: "utf8",
    }).trim();
    const match = out.match(/surface:\d+/);
    if (!match) {
      throw new Error(`Unexpected cmux new-split output: ${out}`);
    }
    const surface = match[0];
    execSync(`cmux rename-tab --surface ${shellEscape(surface)} ${shellEscape(name)}`, {
      encoding: "utf8",
    });
    return surface;
  }

  if (backend === "tmux") {
    const args = ["split-window"];
    if (direction === "left" || direction === "right") {
      args.push("-h");
    } else {
      args.push("-v");
    }
    if (direction === "left" || direction === "up") {
      args.push("-b");
    }
    if (fromSurface) {
      args.push("-t", fromSurface);
    }
    args.push("-P", "-F", "#{pane_id}");

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }

    try {
      execFileSync("tmux", ["select-pane", "-t", pane, "-T", name], { encoding: "utf8" });
    } catch {
      // Optional.
    }
    return pane;
  }

  if (backend === "wezterm") {
    const args = ["cli", "split-pane"];
    if (direction === "left") args.push("--left");
    else if (direction === "right") args.push("--right");
    else if (direction === "up") args.push("--top");
    else args.push("--bottom");
    args.push("--cwd", process.cwd());
    if (fromSurface) {
      args.push("--pane-id", fromSurface);
    }
    const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
    if (!paneId || !/^\d+$/.test(paneId)) {
      throw new Error(`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`);
    }
    try {
      execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], {
        encoding: "utf8",
      });
    } catch {
      // Optional — tab title is cosmetic.
    }
    return paneId;
  }

  // zellij
  const directionArg = direction === "left" || direction === "right" ? "right" : "down";
  const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];

  let rawId: string;
  try {
    rawId = zellijActionSync(args, fromSurface).trim();
  } catch {
    if (!fromSurface) throw new Error("Failed to create zellij pane");
    rawId = zellijActionSync(args).trim();
  }

  // zellij returns the pane ID as e.g. "terminal_7" — extract the numeric part.
  // Previously we sent `write-chars "echo $ZELLIJ_PANE_ID"` to a temp file, but
  // `write-chars` without --pane-id targets the focused pane, which raced on tab switches.
  const idMatch = rawId.match(/(\d+)/);
  if (!idMatch) {
    throw new Error(`Unexpected zellij pane id from new-pane: ${rawId || "(empty)"}`);
  }
  const paneId = idMatch[1];

  const surface = `pane:${paneId}`;

  if (direction === "left" || direction === "up") {
    try {
      zellijActionSync(["move-pane", direction], surface);
    } catch {
      // Optional layout polish.
    }
  }

  try {
    zellijActionSync(["rename-pane", name], surface);
  } catch {
    // Optional.
  }

  return surface;
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-tab-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    execFileSync("wezterm", args, { encoding: "utf8" });
    return;
  }

  // zellij: rename the agent's own pane, not the whole tab. In multi-pane layouts,
  // rename-tab clobbers the user's tab title whenever a subagent starts or /plan runs.
  // Closes #21.
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (paneId) {
    zellijActionSync(["rename-pane", title], `pane:${paneId}`);
  } else {
    zellijActionSync(["rename-pane", title]);
  }
}

/**
 * Rename the current workspace/session where supported.
 */
export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
      return;
    }

    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-window-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    try {
      execFileSync("wezterm", args, { encoding: "utf8" });
    } catch {
      // Optional — window title is cosmetic.
    }
    return;
  }

  // Skip session rename for zellij. rename-session renames the socket file
  // but the ZELLIJ_SESSION_NAME env var in the parent process keeps the old
  // name, so all subsequent `zellij action ...` CLI calls fail with
  // "There is no active session!" because the CLI can't find the socket.
  // Additionally, pi titles often contain special characters (em dashes,
  // spaces) that fail zellij's session name validation on lookup.
  // rename-tab (called separately) is sufficient for user-visible naming.
}

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync(
      "wezterm",
      ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\n"],
      { encoding: "utf8" },
    );
    return;
  }

  zellijActionSync(["write-chars", command], surface);
  zellijActionSync(["write", "13"], surface);
}

/**
 * Send one Escape keypress to an active pane.
 */
export function sendEscape(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execFileSync("cmux", ["send", "--surface", surface, "\u001b"], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", "\u001b"], {
      encoding: "utf8",
    });
    return;
  }

  zellijActionSync(["write", "27"], surface);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return execSync(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, {
      encoding: "utf8",
    });
  }

  if (backend === "tmux") {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      {
        encoding: "utf8",
      },
    );
  }

  if (backend === "wezterm") {
    const raw = execFileSync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(raw, lines);
  }

  // Zellij 0.44+: use --pane-id flag + stdout instead of env var + temp file.
  // The ZELLIJ_PANE_ID env var doesn't reliably target other panes for dump-screen,
  // and --path may silently fail to create the file. Stdout capture is robust.
  const paneId = zellijPaneId(surface);
  const raw = execFileSync(
    "zellij",
    ["action", "dump-screen", "--pane-id", paneId],
    { encoding: "utf8" },
  );
  return tailLines(raw, lines);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const { stdout } = await execFileAsync(
      "cmux",
      ["read-screen", "--surface", surface, "--lines", String(lines)],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "tmux") {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "wezterm") {
    const { stdout } = await execFileAsync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(stdout, lines);
  }

  // Zellij 0.44+: use --pane-id flag + stdout instead of env var + temp file.
  const paneId = zellijPaneId(surface);
  const { stdout } = await execFileAsync(
    "zellij",
    ["action", "dump-screen", "--pane-id", paneId],
    { encoding: "utf8" },
  );
  return tailLines(stdout, lines);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
      encoding: "utf8",
    });
    return;
  }

  zellijActionSync(["close-pane"], surface);
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "sentinel";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  while (true) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by subagent_done / caller_ping)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          if (data.type === "ping") {
            return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
          }
          return { reason: "done", exitCode: 0 };
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            if (data.type === "ping") {
              return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
            }
            return { reason: "done", exitCode: 0 };
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
