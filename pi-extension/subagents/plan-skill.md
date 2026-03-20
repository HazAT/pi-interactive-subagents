---
name: plan
description: >
  Planning workflow. Spawns an interactive planner sub-agent
  in a multiplexer pane with shared session context. Use when asked to "plan",
  "brainstorm", "I want to build X", or "let's design". Requires the
  subagents extension and a supported multiplexer (cmux/tmux/zellij).
---

# Plan

A planning workflow that offloads brainstorming and plan creation to a dedicated interactive subagent, keeping the main session clean for orchestration.

**Announce at start:** "Let me investigate first, then I'll open a dedicated planning session where we can work through this together."

---



## The Flow

```
Phase 1: Quick Investigation (main session)
    ↓
Phase 2: Spawn Planner Subagent (interactive — user collaborates here)
    ↓
Phase 3: Review Plan & Todos (main session)
    ↓
Phase 4: Execute Todos (workers)
    ↓
Phase 5: Review
```

---

## Phase 1: Quick Investigation

Before spawning the planner, orient yourself:

```bash
ls -la
find . -type f -name "*.ts" | head -20  # or relevant extension
cat package.json 2>/dev/null | head -30
```

Spend 30–60 seconds. The goal is to give the planner useful context — not to do a full scout.

**If deeper context is needed** (large codebase, unfamiliar architecture), spawn an autonomous scout subagent first:

```typescript
subagent({
  name: "Scout",
  agent: "scout",
  interactive: false,
  task: "Analyze the codebase. Map file structure, key modules, patterns, and conventions. Summarize findings concisely for a planning session."
})
```

Read the scout's summary from the subagent result before proceeding.

---

## Phase 2: Spawn Planner Subagent

Spawn the interactive planner. The `planner` agent definition has the full brainstorming workflow built in — clarify, explore, validate design, write plan, create todos.

```typescript
subagent({
  name: "Planner",
  agent: "planner",
  interactive: true,
  task: `Plan: [what the user wants to build]

Context from investigation:
[paste relevant findings from Phase 1 here]`
})
```

**The user works with the planner in the subagent.** The main session waits. When the user is done, they press Ctrl+D and the subagent.s summary is returned to the main session.

---

## Phase 3: Review Plan & Todos

Once the subagent closes, read the plan and todos:

```typescript
todo({ action: "list" })
```

Review with the user:
> "Here's what the planner produced: [brief summary]. Ready to execute, or anything to adjust?"

---

## Phase 4: Execute Todos

Spawn a scout first for context, then workers sequentially:

```typescript
// 1. Scout gathers context
subagent({
  name: "Scout",
  agent: "scout",
  interactive: false,
  task: "Gather context for implementing [feature]. Read the plan at [plan path]. Identify all files that will be created/modified, map existing patterns and conventions."
})

// 2. Workers execute todos sequentially — one at a time
subagent({
  name: "Worker",
  agent: "worker",
  interactive: false,
  task: "Implement TODO-xxxx. Mark the todo as done. Plan: [plan path]\n\nScout context: [paste scout summary]"
})

// Check result, then next todo
subagent({
  name: "Worker",
  agent: "worker",
  interactive: false,
  task: "Implement TODO-yyyy. Mark the todo as done. Plan: [plan path]\n\nScout context: [paste scout summary]"
})
```

**Always run workers sequentially in the same git repo** — parallel workers will conflict on commits.

---

## Phase 5: Review

After all todos are complete:

```typescript
subagent({
  name: "Reviewer",
  agent: "reviewer",
  interactive: false,
  task: "Review the recent changes. Plan: [plan path]"
})
```

Triage findings:
- **P0** — Real bugs, security issues → fix now
- **P1** — Genuine traps, maintenance dangers → fix before merging
- **P2** — Minor issues → fix if quick, note otherwise
- **P3** — Nits → skip

Create todos for P0/P1, run workers to fix, re-review only if fixes were substantial.

---

## ⚠️ Completion Checklist

Before reporting done:

1. ✅ All worker todos closed?
2. ✅ Every todo has a polished commit (using the `commit` skill)?
3. ✅ Reviewer has run?
4. ✅ Reviewer findings triaged and addressed?
