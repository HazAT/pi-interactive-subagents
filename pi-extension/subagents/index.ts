import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename, dirname, join } from "node:path";
import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  exitStatusVar,
  renameCurrentTab,
  renameWorkspace,
} from "./cmux.ts";
import { getNewEntries, findLastAssistantMessage } from "./session.ts";

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Fork the current session — sub-agent gets full conversation context. Use for iterate/bugfix patterns.",
    }),
  ),
});

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  cwd?: string;
  body?: string;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set(["subagent", "subagents_list", "subagent_resume"]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(homedir(), ".pi", "agent", "agents", `${agentName}.md`),
    join(dirname(new URL(import.meta.url).pathname), "../../agents", `${agentName}.md`),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const frontmatter = match[1];
    const get = (key: string) => {
      const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : undefined;
    };
    // Extract body (everything after frontmatter)
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
    const spawningRaw = get("spawning");
    const autoExitRaw = get("auto-exit");
    return {
      model: get("model"),
      tools: get("tools"),
      skills: get("skill") ?? get("skills"),
      thinking: get("thinking"),
      denyTools: get("deny-tools"),
      spawning: spawningRaw != null ? spawningRaw === "true" : undefined,
      autoExit: autoExitRaw != null ? autoExitRaw === "true" : undefined,
      cwd: get("cwd"),
      body: body || undefined,
    };
  }
  return null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
  if (kind === "tab-title") {
    return {
      content: [
        { type: "text" as const, text: `Terminal multiplexer not available. ${muxSetupHint()}` },
      ],
      details: { error: "mux not available" },
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the artifact directory path for the current session.
 * Same convention as the write_artifact tool:
 *   ~/.pi/history/<project>/artifacts/<session-id>/
 */
function getArtifactDir(cwd: string, sessionId: string): string {
  const project = basename(cwd);
  return join(homedir(), ".pi", "history", project, "artifacts", sessionId);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

/**
 * Try to find and measure a specific session file, or discover
 * the right one from new files in the session directory.
 *
 * When `trackedFile` is provided, measures that file directly.
 * Otherwise scans for new files not in `existingFiles` or `excludeFiles`.
 *
 * Returns { file, entries, bytes } — `file` is the path that was measured,
 * so callers can lock onto it for subsequent calls.
 */
/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  entries?: number;
  bytes?: number;
  forkCleanupFile?: string;
  abortController?: AbortController;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const right =
      agent.entries != null && agent.bytes != null
        ? ` ${agent.entries} msgs (${formatBytes(agent.bytes)}) `
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

export const __test__ = {
  borderLine,
  renderSubagentWidgetLines,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string }; cwd: string },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");

  const sessionDir = dirname(sessionFile);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  // Build the task message
  // When forking, the sub-agent already has the full conversation context.
  // Only send the user's task as a clean message — no wrapper instructions
  // that would confuse the agent into thinking it needs to restart.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const agentType = params.agent ?? params.name;
  const tabTitleInstruction = denySet.has("set_tab_title")
    ? ""
    : `As your FIRST action, set the tab title using set_tab_title. ` +
      `The title MUST start with [${agentType}] followed by a short description of your current task. ` +
      `Example: "[${agentType}] Analyzing auth module". Keep it concise.`;
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const roleBlock = identity ? `\n\n${identity}` : "";
  const fullTask = params.fork
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${tabTitleInstruction}\n\n${params.task}\n\n${summaryInstruction}`;

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  // For fork mode, create a clean copy of the session that excludes
  // the "Use subagent..." meta-message and tool call that triggered this.
  // The forked session sees only the original conversation + the user's actual task.
  let forkCleanupFile: string | undefined;
  if (params.fork) {
    const raw = readFileSync(sessionFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());

    // Walk backwards to find the last user message (the meta-instruction)
    // and truncate everything from there onwards
    let truncateAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "user") {
          truncateAt = i;
          break;
        }
      } catch {}
    }

    const cleanLines = lines.slice(0, truncateAt);
    forkCleanupFile = join(tmpdir(), `pi-fork-clean-${Date.now()}.jsonl`);
    writeFileSync(forkCleanupFile, cleanLines.join("\n") + "\n", "utf8");
    parts.push("--fork", shellEscape(forkCleanupFile));
  }

  const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (effectiveModel) {
    const model = effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel;
    parts.push("--model", shellEscape(model));
  }

  if (effectiveTools) {
    const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const builtins = effectiveTools
      .split(",")
      .map((t) => t.trim())
      .filter((t) => BUILTIN_TOOLS.has(t));
    if (builtins.length > 0) {
      parts.push("--tools", shellEscape(builtins.join(",")));
    }
  }

  if (effectiveSkills) {
    for (const skill of effectiveSkills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      parts.push(shellEscape(`/skill:${skill}`));
    }
  }

  // Build env prefix: denied tools + subagent identity
  const envParts: string[] = [];
  if (denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  const envPrefix = envParts.join(" ") + " ";

  // Pass task to the sub-agent.
  // For fork mode, pass as a plain quoted argument — the forked session already
  // has the full conversation context, so the message arrives as if the user typed it.
  // For non-fork mode, write to an artifact file and pass via @file to handle
  // long task descriptions with role/instructions safely.
  if (params.fork) {
    parts.push(shellEscape(fullTask));
  } else {
    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.cwd, sessionId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    parts.push(`@${artifactPath}`);
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(process.cwd(), rawCwd)
    : null;
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
  sendCommand(surface, command);

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    forkCleanupFile,
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface and fork file,
 * and removes the entry from runningSubagents.
 */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile, forkCleanupFile } = running;

  try {
    const exitCode = await pollForExit(surface, signal, {
      interval: 1000,
      onTick() {
        // Update entries/bytes for widget display
        try {
          if (existsSync(sessionFile)) {
            const stat = statSync(sessionFile);
            const raw = readFileSync(sessionFile, "utf8");
            running.entries = raw.split("\n").filter((l) => l.trim()).length;
            running.bytes = stat.size;
          }
        } catch {}
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Extract summary from the known session file
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (exitCode !== 0
          ? `Sub-agent exited with code ${exitCode}`
          : "Sub-agent exited without output");
    } else {
      summary =
        exitCode !== 0
          ? `Sub-agent exited with code ${exitCode}`
          : "Sub-agent exited without output";
    }

    closeSurface(surface);
    runningSubagents.delete(running.id);

    // Clean up temp fork file
    if (forkCleanupFile) {
      try {
        unlinkSync(forkCleanupFile);
      } catch {}
    }

    return { name, task, summary, sessionFile, exitCode, elapsed };
  } catch (err: any) {
    if (forkCleanupFile) {
      try {
        unlinkSync(forkCleanupFile);
      } catch {}
    }
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. Results are delivered later via a steer message. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        "Either wait for the steer message or move on to other work.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. Results are delivered later via a steer message. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        "Either wait for the steer message or move on to other work.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult("subagents");
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane, sends command)
        const running = await launchSubagent(params, ctx);

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh when first agent launches
        startWidgetRefresh();

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget(); // reflect removal from Map immediately
            const sessionRef = result.sessionFile
              ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
              : "";
            const content =
              result.exitCode !== 0
                ? `Sub-agent "${running.name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
                : `Sub-agent "${running.name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;

            pi.sendMessage(
              {
                customType: "subagent_result",
                content,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
        const cwdHint = args.cwd ? theme.fg("dim", ` in ${args.cwd}`) : "";
        let text =
          "▸ " + theme.fg("toolTitle", theme.bold(args.name ?? "(unnamed)")) + agent + cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        const task = args.task ?? "";
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const agents = new Map<
          string,
          { name: string; description?: string; model?: string; source: string }
        >();

        const dirs = [
          {
            path: join(dirname(new URL(import.meta.url).pathname), "../../agents"),
            source: "package",
          },
          { path: join(homedir(), ".pi", "agent", "agents"), source: "global" },
          { path: join(process.cwd(), ".pi", "agents"), source: "project" },
        ];

        for (const { path: dir, source } of dirs) {
          if (!existsSync(dir)) continue;
          for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
            const content = readFileSync(join(dir, file), "utf8");
            const match = content.match(/^---\n([\s\S]*?)\n---/);
            if (!match) continue;
            const frontmatter = match[1];
            const get = (key: string) => {
              const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
              return m ? m[1].trim() : undefined;
            };
            const name = get("name") ?? file.replace(/\.md$/, "");
            agents.set(name, {
              name,
              description: get("description"),
              model: get("model"),
              source,
            });
          }
        }

        if (agents.size === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const list = [...agents.values()];
        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });

  // ── set_tab_title tool ──
  if (shouldRegister("set_tab_title"))
    pi.registerTool({
      name: "set_tab_title",
      label: "Set Tab Title",
      description:
        "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
        "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
      promptSnippet:
        "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
        "(e.g. planning, executing todos, reviewing). Keep titles short and informative.",
      parameters: Type.Object({
        title: Type.String({
          description: "New tab title (also applied to workspace/session when supported)",
        }),
      }),

      async execute(_toolCallId, params) {
        if (!isMuxAvailable()) {
          return muxUnavailableResult("tab-title");
        }
        try {
          renameCurrentTab(params.title);
          renameWorkspace(params.title);
          return {
            content: [{ type: "text", text: `Title set to: ${params.title}` }],
            details: { title: params.title },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Failed to set title: ${err?.message}` }],
            details: { error: err?.message },
          };
        }
      },
    });

  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate) {
        const name = params.name ?? "Resume";
        const startTime = Date.now();

        if (!isMuxAvailable()) {
          return muxUnavailableResult("subagents");
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

        const surface = createSurface(name);
        await new Promise<void>((resolve) => setTimeout(resolve, 500));

        // Build pi resume command
        const parts = ["pi", "--session", shellEscape(params.sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(
          dirname(new URL(import.meta.url).pathname),
          "subagent-done.ts",
        );
        parts.push("-e", shellEscape(subagentDonePath));

        let cleanupMsgFile: string | undefined;
        if (params.message) {
          const msgFile = join(tmpdir(), `subagent-resume-${Date.now()}.md`);
          writeFileSync(msgFile, params.message, "utf8");
          cleanupMsgFile = msgFile;
          parts.push(`@${msgFile}`);
        }

        const command = `${parts.join(" ")}${cleanupMsgFile ? `; rm -f ${shellEscape(cleanupMsgFile)}` : ""}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
        sendCommand(surface, command);

        // Register as a running subagent for widget tracking
        const id = Math.random().toString(16).slice(2, 10);
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget();
            const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
            const summary =
              findLastAssistantMessage(allEntries) ??
              (result.exitCode !== 0
                ? `Resumed session exited with code ${result.exitCode}`
                : "Resumed session exited without new output");
            const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `${summary}${sessionRef}`,
                display: true,
                details: {
                  name,
                  task: params.message ?? "resumed session",
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: params.sessionPath,
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: { id, name, sessionPath: params.sessionPath, status: "started" },
        };
      },
    });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args?.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn =
          exitCode === 0
            ? (text: string) => theme.bg("toolSuccessBg", text)
            : (text: string) => theme.bg("toolErrorBg", text);
        const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "");

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // /plan command — start the full planning workflow
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Rename workspace and tab to show this is a planning session
      if (isMuxAvailable()) {
        try {
          const label = task.length > 40 ? task.slice(0, 40) + "..." : task;
          renameWorkspace(`🎯 ${label}`);
          renameCurrentTab(`🎯 Plan: ${label}`);
        } catch {
          // non-critical -- do not block the plan
        }
      }

      // Load the plan skill from the subagents extension directory
      const planSkillPath = join(dirname(new URL(import.meta.url).pathname), "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(
        `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
      );
    },
  });
}
// test
