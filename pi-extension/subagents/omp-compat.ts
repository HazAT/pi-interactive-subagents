/**
 * oh-my-pi (omp) compatibility layer.
 *
 * Resolves the correct agent config directory and maps CLI arguments
 * between pi and omp formats. Zero behavioural change when running as pi.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";

// ── Agent config directory ───────────────────────────────────────────────────

const ompAgentDir = join(homedir(), ".omp", "agent");
const piAgentDir = join(homedir(), ".pi", "agent");

/**
 * Resolve the agent config directory.
 * Priority: PI_CODING_AGENT_DIR env > ~/.omp/agent > ~/.pi/agent.
 */
export function resolveAgentConfigDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) return envDir;
  if (existsSync(ompAgentDir)) return ompAgentDir;
  return piAgentDir;
}

// ── CLI binary name ──────────────────────────────────────────────────────────

/**
 * Derive the default CLI binary from the active agent config directory.
 * PI_SUBAGENT_CLI env var takes priority.
 */
export function resolveDefaultCli(): string {
  const envCli = process.env.PI_SUBAGENT_CLI?.trim();
  if (envCli) return envCli;
  return basename(dirname(resolveAgentConfigDir())).replace(/^\./, "");
}

// ── CLI argument mapping ─────────────────────────────────────────────────────

export interface SessionArgs {
  /** CLI arguments for session handling. */
  args: string[];
  /**
   * When non-null, the CLI uses --session-dir instead of --session.
   * After the process exits, call findLatestSessionFile(sessionDir)
   * to locate the actual session file.
   */
  sessionDir: string | null;
}

/**
 * Build session-related CLI args.
 *
 * Pi supports `--session <file>` for exact session file path.
 * omp uses `--session-dir <dir>` so it creates the session in a known
 * parent directory; `--auto-approve` skips interactive prompts.
 * After the process exits, call findLatestSessionFile(sessionDir)
 * to locate the actual JSONL.
 */
export function buildSessionArgs(cli: string, sessionFile: string): SessionArgs {
  if (cli === "omp") {
    const sessionDir = dirname(sessionFile);
    return {
      args: ["--session-dir", sessionDir, "--auto-approve"],
      sessionDir,
    };
  }
  return { args: ["--session", sessionFile], sessionDir: null };
}

// ── Session file lookup ──────────────────────────────────────────────────────

/**
 * Find the most recently created .jsonl session file in a directory.
 *
 * Used after an omp subagent exits. Since each subagent gets its own
 * session directory (via --session-dir), the newest .jsonl is
 * guaranteed to be from this run.
 *
 * Returns the full path, or null if no .jsonl files are found.
 * Excludes `excludePath` (the plugin's own placeholder file).
 */
export function findLatestSessionFile(sessionDir: string, excludePath?: string): string | null {
  if (!existsSync(sessionDir)) return null;
  let latest: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const fullPath = join(sessionDir, entry);
    if (fullPath === excludePath) continue;
    try {
      const stat = statSync(fullPath);
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { path: fullPath, mtime: stat.mtimeMs };
      }
    } catch {
      // ignore unreadable files
    }
  }
  return latest?.path ?? null;
}
