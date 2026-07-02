import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { existsSync } from "node:fs";
import { resolveAgentConfigDir, resolveDefaultCli, buildSessionArgs, findLatestSessionFile } from "../pi-extension/subagents/omp-compat.ts";

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) { delete process.env[name]; return; }
  process.env[name] = value;
}

describe("resolveAgentConfigDir", () => {
  const saved: Record<string, string | undefined> = {};
  before(() => { saved["PI_CODING_AGENT_DIR"] = process.env.PI_CODING_AGENT_DIR; });
  after(() => { for (const [k, v] of Object.entries(saved)) restoreEnvVar(k, v); });

  it("PI_CODING_AGENT_DIR env var takes priority", () => {
    process.env.PI_CODING_AGENT_DIR = "/custom/dir";
    assert.equal(resolveAgentConfigDir(), "/custom/dir");
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it("returns ~/.omp/agent when it exists, otherwise ~/.pi/agent", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const result = resolveAgentConfigDir();
    if (existsSync(join(homedir(), ".omp", "agent"))) {
      assert.equal(result, join(homedir(), ".omp", "agent"));
    } else {
      assert.equal(result, join(homedir(), ".pi", "agent"));
    }
  });
});

describe("resolveDefaultCli", () => {
  const saved: Record<string, string | undefined> = {};
  before(() => { saved["PI_SUBAGENT_CLI"] = process.env.PI_SUBAGENT_CLI; });
  after(() => { for (const [k, v] of Object.entries(saved)) restoreEnvVar(k, v); });

  it("PI_SUBAGENT_CLI takes priority", () => {
    process.env.PI_SUBAGENT_CLI = "custom";
    assert.equal(resolveDefaultCli(), "custom");
    delete process.env.PI_SUBAGENT_CLI;
  });

  it("derives name from active config dir", () => {
    delete process.env.PI_SUBAGENT_CLI;
    const cli = resolveDefaultCli();
    assert.ok(cli === "omp" || cli === "pi", `expected 'omp' or 'pi', got '${cli}'`);
  });
});

describe("buildSessionArgs", () => {
  const file = "/tmp/sessions/abc.jsonl";

  it("pi: --session with file, sessionDir is null", () => {
    const r = buildSessionArgs("pi", file);
    assert.deepEqual(r.args, ["--session", file]);
    assert.equal(r.sessionDir, null);
  });

  it("omp: --session-dir with directory + --auto-approve", () => {
    const r = buildSessionArgs("omp", file);
    assert.deepEqual(r.args, ["--session-dir", "/tmp/sessions", "--auto-approve"]);
    assert.equal(r.sessionDir, "/tmp/sessions");
    // Must NOT contain legacy flags
    assert.ok(!r.args.includes("--session"), "should not use --session");
    assert.ok(!r.args.includes("-p"), "should not use -p");
    assert.ok(!r.args.includes("--mode"), "should not use --mode");
  });
});

describe("findLatestSessionFile", () => {
  it("returns null for non-existent directory", () => {
    assert.equal(findLatestSessionFile("/tmp/nonexistent-dir-12345"), null);
  });

  it("finds the most recently modified .jsonl file", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-test-"));
    try {
      writeFileSync(join(dir, "older.jsonl"), "{}\n");
      const start = Date.now();
      while (Date.now() - start < 10) {} // busy wait 10ms
      writeFileSync(join(dir, "newer.jsonl"), "{}\n");
      const result = findLatestSessionFile(dir);
      assert.ok(result?.endsWith("newer.jsonl"), `expected newer.jsonl, got ${result}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes the specified path", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-test-"));
    try {
      const exclude = join(dir, "exclude.jsonl");
      writeFileSync(exclude, "{}\n");
      writeFileSync(join(dir, "other.jsonl"), "{}\n");
      const result = findLatestSessionFile(dir, exclude);
      assert.ok(result?.endsWith("other.jsonl"), `expected other.jsonl, got ${result}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-.jsonl files", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-test-"));
    try {
      writeFileSync(join(dir, "data.txt"), "not jsonl");
      writeFileSync(join(dir, "session.jsonl"), "{}\n");
      const result = findLatestSessionFile(dir);
      assert.ok(result?.endsWith("session.jsonl"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
