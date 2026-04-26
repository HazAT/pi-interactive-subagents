/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn REAL pi sessions with REAL LLM calls (haiku by default).
 * Each test creates a mux surface, runs pi with a task that uses the subagent
 * tool, and verifies the outcome via marker files and screen output.
 *
 * Costs: ~$0.01-0.05 per test run (haiku).
 * Duration: ~30-90s per test.
 *
 * Run inside a supported multiplexer:
 *   cmux bash -c 'npm run test:integration'
 *   tmux new 'npm run test:integration'
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions (default: anthropic/claude-haiku-4-5)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  trackTempFile,
  readScreen,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No mux backend available — skipping subagent lifecycle integration tests");
  console.log("   Run inside cmux or tmux to enable these tests.");
}

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 3 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    // ── Basic spawn + completion ──

    it("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `echo-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: subagent created the marker file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
      assert.ok(
        content.includes(`PASS_${id}`),
        `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
      );

      // Verify: outer pi received the subagent result
      const screen = await waitForScreen(
        surface,
        /INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
        PI_TIMEOUT,
      );

      // Verify: session file was created (shown in steer result)
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);

        const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
        assert.ok(lines.length >= 2, `Session should have ≥2 entries, got ${lines.length}`);

        const header = JSON.parse(lines[0]);
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.id, "Session header should have an id");
      }
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from surfacing false stalled status", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-status-${id}.txt`;
      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `status-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Status-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readScreen(surface, 300);
      assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
      assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

      const completionScreen = await waitForScreen(
        surface,
        /STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
        PI_TIMEOUT,
        300,
      );
      assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
    });

    // ── Parallel subagent spawn ──

    it("spawns two subagents in parallel and both complete", async () => {
      const id = uniqueId();
      const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
      const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
      trackTempFile(env, fileA);
      trackTempFile(env, fileB);

      const surface = createTrackedSurface(env, `parallel-${id}`);
      await sleep(1000);

      const task = [
        `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
        ``,
        `First call:`,
        `  name: "ParaA-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
        ``,
        `Call both subagent tools NOW, do not wait between them.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Both marker files should appear
      const [contentA, contentB] = await Promise.all([
        waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
        waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
      ]);

      assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
      assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
    });

    // ── Fork mode ──

    it("fork mode creates a child session linked to the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `fork-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Fork-${id}"`,
        `  fork: true`,
        `  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
        `Do not set the agent parameter. Just set name, fork, and task.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: forked subagent created the file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
      assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);

      // Wait for the outer pi to show the result
      const screen = await waitForScreen(
        surface,
        /FORK_COMPLETE|completed|Sub-agent.*"Fork/i,
        PI_TIMEOUT,
      );

      // Verify: the forked session has a parent link
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

        const entries = readFileSync(sessionFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const header = entries[0];
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.parentSession, "Fork session should have parentSession field");
        // Fork sessions include parent context (model_change entries etc.)
        assert.ok(entries.length >= 2, "Fork session should have context entries beyond header");
      }
    });

    // ── caller_ping ──

    it("subagent caller_ping sends notification back to the parent", async () => {
      const id = uniqueId();

      const surface = createTrackedSurface(env, `ping-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Ping-${id}"`,
        `  agent: "test-ping"`,
        `  task: "PING_TEST_${id}"`,
        `Just call the subagent tool once. Do not do anything else before calling it.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-ping agent calls caller_ping, which steers a "needs help" message
      // back to the outer pi. Look for it on screen.
      const screen = await waitForScreen(
        surface,
        /needs help|PING|caller_ping|ping/i,
        PI_TIMEOUT,
      );

      assert.ok(
        /needs help|PING/i.test(screen),
        `Screen should show ping notification. Got:\n${screen.slice(-800)}`,
      );
    });

    // ── Agent discovery ──

    it("subagent discovers project-local test agents", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `discovery-${id}`);
      await sleep(1000);

      // Use subagents_list to verify test agents are discoverable,
      // then spawn one to prove it works end-to-end.
      const task = [
        `First, call the subagents_list tool to see available agents.`,
        `Then call the subagent tool:`,
        `  name: "Disco-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent (discovered from project .pi/agents/) should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
    });

    // ── Subagent with custom system prompt ──

    it("passes systemPrompt to subagent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `sysprompt-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these parameters:`,
        `  name: "SysP-${id}"`,
        `  agent: "test-echo"`,
        `  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
        `  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
        `After the subagent completes, say SYSPROMPT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
      assert.ok(content.includes(`SYSPROMPT_${id}`), `System prompt test marker should exist`);
    });
  });
}
