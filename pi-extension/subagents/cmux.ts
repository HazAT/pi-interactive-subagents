import { execSync } from "node:child_process";
import { basename } from "node:path";

export function isCmuxAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH;
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

/**
 * Create a new cmux terminal as a right split and set its tab title.
 * The subagent appears side-by-side with the orchestrator.
 * Returns the surface ref (e.g. "surface:42").
 */
export function createSurface(name: string): string {
  const out = execSync(`cmux new-split right`, {
    encoding: "utf8",
  }).trim();
  // Output: "OK surface:42 workspace:3"
  const match = out.match(/surface:\d+/);
  if (!match) {
    throw new Error(`Unexpected cmux new-split output: ${out}`);
  }
  const surface = match[0];
  // Rename the tab so the subagent name is visible
  execSync(`cmux rename-tab --surface ${shellEscape(surface)} ${shellEscape(name)}`, {
    encoding: "utf8",
  });
  // Focus the new split so the user doesn't accidentally type in the orchestrator
  execSync(`cmux focus-panel --panel ${shellEscape(surface)}`, {
    encoding: "utf8",
  });
  return surface;
}

/**
 * Rename the current tab (the one running this process).
 * Explicitly passes CMUX_SURFACE_ID so it works even when the tab isn't focused.
 */
export function renameCurrentTab(title: string): void {
  const surfaceId = process.env.CMUX_SURFACE_ID;
  if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
  execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, { encoding: "utf8" });
}

/**
 * Rename the current workspace (sidebar entry).
 * Uses CMUX_WORKSPACE_ID from env automatically.
 */
export function renameWorkspace(title: string): void {
  execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, { encoding: "utf8" });
}

/**
 * Send a command string to a cmux surface. Appends \n to execute.
 */
export function sendCommand(surface: string, command: string): void {
  execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
    encoding: "utf8",
  });
}

/**
 * Read the screen contents of a cmux surface.
 */
export function readScreen(surface: string, lines = 50): string {
  return execSync(
    `cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`,
    { encoding: "utf8" }
  );
}

/**
 * Close a cmux surface.
 */
export function closeSurface(surface: string): void {
  execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
    encoding: "utf8",
  });
}

/**
 * Poll a surface until the __SUBAGENT_DONE_N__ sentinel appears.
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

    const screen = readScreen(surface, 5);
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
