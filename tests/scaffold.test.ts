import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createCli } from "../src/cli.js";
import { AgentRegistrySchema } from "../src/schemas.js";
import { saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

interface CliResult {
  output: string;
  exitCode: string | number | undefined;
  error: unknown;
}

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-scaffold-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli(root: string, args: string[]): Promise<CliResult> {
  const lines: string[] = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const log = vi.spyOn(console, "log").mockImplementation((message?: unknown, ...rest: unknown[]) => {
    lines.push([message, ...rest].map((entry) => String(entry)).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((message?: unknown, ...rest: unknown[]) => {
    lines.push([message, ...rest].map((entry) => String(entry)).join(" "));
  });
  const program = createCli(root);
  program.exitOverride();
  program.configureOutput({
    writeOut: (value) => lines.push(value.endsWith("\n") ? value.slice(0, -1) : value),
    writeErr: (value) => lines.push(value.endsWith("\n") ? value.slice(0, -1) : value)
  });
  let thrown: unknown = undefined;
  try {
    await program.parseAsync(["node", "maw", ...args], { from: "node" });
  } catch (err) {
    thrown = err;
  } finally {
    log.mockRestore();
    errorSpy.mockRestore();
  }
  const exitCode = process.exitCode ?? (thrown !== undefined ? 1 : undefined);
  process.exitCode = previousExitCode;
  return {
    output: lines.length === 0 ? "" : lines.join("\n") + "\n",
    exitCode,
    error: thrown
  };
}

async function readRegistry(root: string) {
  const raw = await readFile(join(root, "state/agent_registry.json"), "utf8");
  return AgentRegistrySchema.parse(JSON.parse(raw));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe("scaffold commands", () => {
  test("scaffold agent creates schema-valid safe agent", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, [
        "scaffold",
        "agent",
        "--id",
        "researcher_2",
        "--role",
        "Research Agent",
        "--executor",
        "model_agent",
        "--model-tier",
        "mid"
      ]);

      expect(result.error).toBeUndefined();
      expect(result.output).toContain("Scaffolded agent researcher_2");
      expect(result.output).toContain("Changed:");
      expect(result.output).toContain("- state/agent_registry.json");
      expect(result.output).toContain("Rollback:");
      expect(result.output).toContain("Next: maw doctor");
      expect(result.output).toContain("Reason:");

      const registry = await readRegistry(root);
      const created = registry.agents.find((agent) => agent.agent_id === "researcher_2");
      expect(created).toBeDefined();
      expect(created?.role).toBe("Research Agent");
      expect(created?.executor_type).toBe("model_agent");
      expect(created?.model_tier).toBe("mid");
      expect(created?.permissions.external_actions).toBe(false);
      expect(created?.permissions.destructive_actions).toBe(false);
      expect(created?.permissions.credential_access).toBe(false);
      expect(created?.permissions.paid_actions).toBe(false);
      expect(created?.permissions.public_actions).toBe(false);
      expect(created?.command_allowlist).toEqual([]);
      expect(created?.allowed_tools).toEqual([]);
    });
  });

  test("scaffold agent refuses duplicate id", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const args = [
        "scaffold",
        "agent",
        "--id",
        "researcher_2",
        "--role",
        "Research Agent",
        "--executor",
        "model_agent"
      ];

      const first = await runCli(root, args);
      expect(first.error).toBeUndefined();

      const second = await runCli(root, args);
      expect(second.exitCode).toBe(1);

      const registry = await readRegistry(root);
      const matches = registry.agents.filter((agent) => agent.agent_id === "researcher_2");
      expect(matches).toHaveLength(1);
    });
  });

  test("scaffold agent refuses --allow-command for non-local-command executors", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const before = await readRegistry(root);

      const unsafe = await runCli(root, [
        "scaffold",
        "agent",
        "--id",
        "model_with_bad_allow",
        "--role",
        "Research Agent",
        "--executor",
        "model_agent",
        "--allow-command",
        "node;ls"
      ]);
      expect(unsafe.exitCode).toBe(1);

      const safe = await runCli(root, [
        "scaffold",
        "agent",
        "--id",
        "model_with_safe_allow",
        "--role",
        "Research Agent",
        "--executor",
        "model_agent",
        "--allow-command",
        "node"
      ]);
      expect(safe.exitCode).toBe(1);

      const dryRun = await runCli(root, [
        "scaffold",
        "agent",
        "--id",
        "dry_with_allow",
        "--role",
        "Builder Agent",
        "--executor",
        "dry_run",
        "--allow-command",
        "node"
      ]);
      expect(dryRun.exitCode).toBe(1);

      const after = await readRegistry(root);
      expect(after.agents.length).toBe(before.agents.length);
      expect(after.agents.find((agent) => agent.agent_id === "model_with_bad_allow")).toBeUndefined();
      expect(after.agents.find((agent) => agent.agent_id === "model_with_safe_allow")).toBeUndefined();
      expect(after.agents.find((agent) => agent.agent_id === "dry_with_allow")).toBeUndefined();
    });
  });

  test("scaffold reviewer creates valid reviewer", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, [
        "scaffold",
        "reviewer",
        "--id",
        "reviewer_adversarial",
        "--persona",
        "adversarial"
      ]);

      expect(result.error).toBeUndefined();
      expect(result.output).toContain("Scaffolded reviewer reviewer_adversarial");
      expect(result.output).toContain("Changed:");
      expect(result.output).toContain("- state/agent_registry.json");
      expect(result.output).toContain("Next: maw doctor");

      const registry = await readRegistry(root);
      const reviewer = registry.agents.find((agent) => agent.agent_id === "reviewer_adversarial");
      expect(reviewer?.role).toBe("Reviewer Agent");
      expect(reviewer?.executor_type).toBe("model_agent");
      expect(reviewer?.reviewer_persona).toBe("adversarial");
      expect(reviewer?.model_tier).toBe("high");
      expect(reviewer?.permissions.external_actions).toBe(false);
    });
  });

  test("scaffold protocol creates protocol file", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, [
        "scaffold",
        "protocol",
        "--name",
        "release-checklist",
        "--title",
        "Release Checklist"
      ]);

      expect(result.error).toBeUndefined();
      expect(result.output).toContain("protocols/release-checklist.md");
      expect(result.output).toContain("Changed:");
      expect(result.output).toContain("Rollback:");
      expect(result.output).toContain("Next:");

      const content = await readFile(join(root, "protocols/release-checklist.md"), "utf8");
      expect(content).toContain("# Release Checklist");
      expect(content).toContain("Purpose:");
      expect(content).toContain("Required Inputs:");
      expect(content).toContain("Steps:");
      expect(content).toContain("Acceptance Criteria:");
      expect(content).toContain("Rollback:");
    });
  });

  test("scaffold protocol rejects unsafe path", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const escape = await runCli(root, ["scaffold", "protocol", "--name", "../escape"]);
      expect(escape.exitCode).toBe(1);
      expect(await pathExists(join(root, "..", "escape.md"))).toBe(false);

      const slash = await runCli(root, ["scaffold", "protocol", "--name", "bad/name"]);
      expect(slash.exitCode).toBe(1);
      expect(await pathExists(join(root, "protocols", "bad", "name.md"))).toBe(false);

      const space = await runCli(root, ["scaffold", "protocol", "--name", "bad name"]);
      expect(space.exitCode).toBe(1);

      const dotdot = await runCli(root, ["scaffold", "protocol", "--name", ".."]);
      expect(dotdot.exitCode).toBe(1);
    });
  });

  test("scaffold protocol refuses overwrite", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const first = await runCli(root, ["scaffold", "protocol", "--name", "release-checklist"]);
      expect(first.error).toBeUndefined();
      const original = await readFile(join(root, "protocols/release-checklist.md"), "utf8");

      const second = await runCli(root, [
        "scaffold",
        "protocol",
        "--name",
        "release-checklist",
        "--title",
        "Should not appear"
      ]);
      expect(second.exitCode).toBe(1);

      const after = await readFile(join(root, "protocols/release-checklist.md"), "utf8");
      expect(after).toBe(original);
      expect(after).not.toContain("Should not appear");
    });
  });

  test("scaffold command creates local-command agent", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const result = await runCli(root, [
        "scaffold",
        "command",
        "--agent-id",
        "shell_node",
        "--command",
        "node"
      ]);

      expect(result.error).toBeUndefined();
      expect(result.output).toContain("shell_node");
      expect(result.output).toContain("node");
      expect(result.output).toContain("approval");
      expect(result.output).toContain("--execute");

      const registry = await readRegistry(root);
      const agent = registry.agents.find((entry) => entry.agent_id === "shell_node");
      expect(agent?.executor_type).toBe("local_command");
      expect(agent?.command_allowlist).toContain("node");
      expect(agent?.max_cost_usd).toBe(0);
      expect(agent?.permissions.external_actions).toBe(false);
      expect(agent?.permissions.destructive_actions).toBe(false);
      expect(agent?.permissions.credential_access).toBe(false);
      expect(agent?.permissions.paid_actions).toBe(false);
      expect(agent?.permissions.public_actions).toBe(false);
    });
  });

  test("scaffold command adds allowlist to existing local-command agent", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const before = await readRegistry(root);
      before.agents.push({
        agent_id: "shell_node",
        role: "Shell Agent",
        executor_type: "local_command",
        model_tier: "low",
        allowed_tools: [],
        command_allowlist: [],
        permissions: {
          external_actions: false,
          destructive_actions: false,
          credential_access: false,
          paid_actions: false,
          public_actions: false
        },
        max_cost_usd: 0
      });
      await saveJson(root, "state/agent_registry.json", before);

      const result = await runCli(root, [
        "scaffold",
        "command",
        "--agent-id",
        "shell_node",
        "--command",
        "node"
      ]);
      expect(result.error).toBeUndefined();

      const after = await readRegistry(root);
      const agent = after.agents.find((entry) => entry.agent_id === "shell_node");
      expect(agent?.command_allowlist).toContain("node");
      expect(agent?.role).toBe("Shell Agent");
      expect(agent?.executor_type).toBe("local_command");
      expect(agent?.model_tier).toBe("low");
    });
  });

  test("scaffold command rejects non-local-command existing agent", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const before = await readRegistry(root);
      const beforeAgent = before.agents.find((entry) => entry.agent_id === "researcher_1");
      expect(beforeAgent).toBeDefined();

      const result = await runCli(root, [
        "scaffold",
        "command",
        "--agent-id",
        "researcher_1",
        "--command",
        "node"
      ]);
      expect(result.exitCode).toBe(1);

      const after = await readRegistry(root);
      const afterAgent = after.agents.find((entry) => entry.agent_id === "researcher_1");
      expect(afterAgent).toEqual(beforeAgent);
    });
  });

  test("scaffold command rejects unsafe command names", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const before = await readRegistry(root);

      const unsafe = [
        "node --version",
        "/usr/bin/node",
        "node;ls",
        "node|cat",
        "node&echo",
        "..\\node",
        "rm rf"
      ];
      for (const command of unsafe) {
        const result = await runCli(root, [
          "scaffold",
          "command",
          "--agent-id",
          "shell_unsafe",
          "--command",
          command
        ]);
        expect(result.exitCode).toBe(1);
      }

      const after = await readRegistry(root);
      expect(after.agents.length).toBe(before.agents.length);
      expect(after.agents.find((entry) => entry.agent_id === "shell_unsafe")).toBeUndefined();
    });
  });

  test("scaffold module does not import openai code", async () => {
    const source = await readFile(join(process.cwd(), "src/scaffold.ts"), "utf8");
    expect(source).not.toMatch(/from ["']\.\/openai/);
    expect(source).not.toMatch(/from ["']openai/);
    expect(source).not.toMatch(/validateWorkspace/);
  });

  test("scaffold command group appears in help", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const root_help = await runCli(root, ["scaffold", "--help"]);
      expect(root_help.output).toContain("scaffold");
      expect(root_help.output).toContain("agent");
      expect(root_help.output).toContain("reviewer");
      expect(root_help.output).toContain("protocol");
      expect(root_help.output).toContain("command");
    });
  });
});
