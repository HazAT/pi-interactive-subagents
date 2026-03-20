import { execSync, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execSync(`command -v ${command}`, { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

function muxPreference(): MuxBackend | null {
  const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (pref === "cmux" || pref === "tmux" || pref === "zellij") return pref;
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

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
  return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
  return isZellijRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;

  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isTmuxRuntimeAvailable()) return "tmux";
  if (isZellijRuntimeAvailable()) return "zellij";
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
  return "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), or zellij (`zellij --session pi`, then run `pi`).";
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

function waitForFile(path: string, timeoutMs = 5000): string {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
    Atomics.wait(sleeper, 0, 0, 20);
  }
  throw new Error(`Timed out waiting for zellij pane id file: ${path}`);
}

function zellijActionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", ["action", ...args], {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
}

async function zellijActionAsync(args: string[], surface?: string): Promise<string> {
  const { stdout } = await execFileAsync("zellij", ["action", ...args], {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
  return stdout;
}

/**
 * Create a new terminal pane as a right split and set its title.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij).
 */
export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right");
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij).
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
    execSync(`cmux focus-panel --panel ${shellEscape(surface)}`, {
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
    } else if (process.env.TMUX_PANE) {
      // Always target the pane where pi is running, not whatever
      // the user happens to have focused in another tmux window.
      args.push("-t", process.env.TMUX_PANE);
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
    execFileSync("tmux", ["select-pane", "-t", pane], { encoding: "utf8" });
    return pane;
  }

  // zellij
  const directionArg = direction === "left" || direction === "right" ? "right" : "down";
  const tokenPath = join(
    tmpdir(),
    `pi-subagent-zellij-pane-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];

  try {
    zellijActionSync(args, fromSurface);
  } catch {
    if (!fromSurface) throw new Error("Failed to create zellij pane");
    zellijActionSync(args);
  }

  // IMPORTANT: do not pass a long-running command to `new-pane`.
  // zellij keeps the `action new-pane -- <cmd>` process attached until <cmd>
  // exits. If <cmd> is an interactive shell, the parent call hangs forever.
  // Instead, create a normal shell pane first, then ask the focused pane
  // to print its own $ZELLIJ_PANE_ID into a temp file.
  const captureIdCmd = `echo "$ZELLIJ_PANE_ID" > ${shellEscape(tokenPath)}`;
  zellijActionSync(["write-chars", captureIdCmd]);
  zellijActionSync(["write", "13"]);

  const paneId = waitForFile(tokenPath);
  try {
    rmSync(tokenPath, { force: true });
  } catch {}

  if (!paneId || !/^\d+$/.test(paneId)) {
    throw new Error(`Unexpected zellij pane id: ${paneId || "(empty)"}`);
  }

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
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
    return;
  }

  zellijActionSync(["rename-tab", title]);
}

/**
 * Rename the current workspace/session where supported.
 */
export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
      return;
    }

    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{session_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
    return;
  }

  zellijActionSync(["rename-session", title]);
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

  zellijActionSync(["write-chars", command], surface);
  zellijActionSync(["write", "13"], surface);
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return execSync(
      `cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`,
      { encoding: "utf8" }
    );
  }

  if (backend === "tmux") {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`], {
      encoding: "utf8",
    });
  }

  const tmpPath = join(
    tmpdir(),
    `pi-subagent-zellij-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  try {
    zellijActionSync(["dump-screen", tmpPath], surface);
    const raw = readFileSync(tmpPath, "utf8");
    return tailLines(raw, lines);
  } finally {
    try { rmSync(tmpPath, { force: true }); } catch {}
  }
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
      { encoding: "utf8" }
    );
    return stdout;
  }

  if (backend === "tmux") {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" }
    );
    return stdout;
  }

  const tmpPath = join(
    tmpdir(),
    `pi-subagent-zellij-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  try {
    await zellijActionAsync(["dump-screen", tmpPath], surface);
    const raw = readFileSync(tmpPath, "utf8");
    return tailLines(raw, lines);
  } finally {
    try { rmSync(tmpPath, { force: true }); } catch {}
  }
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

  zellijActionSync(["close-pane"], surface);
}

/**
 * Poll a pane until the __SUBAGENT_DONE_N__ sentinel appears.
 * Returns the process exit code embedded in the sentinel.
 * Throws if the signal is aborted before the sentinel is found.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: { interval: number; onTick?: (elapsed: number) => void }
): Promise<number> {
  const start = Date.now();

  while (true) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const screen = await readScreenAsync(surface, 5);
    const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
    if (match) {
      return parseInt(match[1], 10);
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
