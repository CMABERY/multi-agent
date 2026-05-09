import { access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  AgentRegistrySchema,
  AgentSchema,
  ExecutorTypeSchema,
  ModelTierSchema,
  ReviewerPersonaSchema
} from "./schemas.js";
import { loadJson, saveJson, saveText } from "./storage.js";

type ExecutorType = z.infer<typeof ExecutorTypeSchema>;
type ModelTier = z.infer<typeof ModelTierSchema>;
type ReviewerPersona = z.infer<typeof ReviewerPersonaSchema>;

const SAFE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SAFE_PROTOCOL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SAFE_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SAFE_PERMISSIONS = {
  external_actions: false,
  destructive_actions: false,
  credential_access: false,
  paid_actions: false,
  public_actions: false
} as const;

export interface ScaffoldResult {
  summary: string;
  changedPaths: string[];
  rollback: string[];
  notes: string[];
  nextCommand: string;
  reason: string;
}

export interface ScaffoldAgentInput {
  id: string;
  role: string;
  executor: string;
  modelTier?: string;
  model?: string;
  maxCost?: number;
  allowedTools?: string[];
  commandAllowlist?: string[];
}

export interface ScaffoldReviewerInput {
  id: string;
  persona: string;
  modelTier?: string;
  model?: string;
  maxCost?: number;
}

export interface ScaffoldProtocolInput {
  name: string;
  title?: string;
  body?: string;
}

export interface ScaffoldCommandInput {
  agentId: string;
  command: string;
  role?: string;
  modelTier?: string;
}

export async function scaffoldAgent(root: string, input: ScaffoldAgentInput): Promise<ScaffoldResult> {
  const id = requireSafeId(input.id, "Agent id");
  const role = requireNonEmpty(input.role, "Agent role");
  if (role.includes("Reviewer")) {
    throw new Error("Use maw scaffold reviewer for Reviewer agents to ensure a persona is set.");
  }
  const executor = parseExecutor(input.executor);
  const modelTier = parseModelTier(input.modelTier ?? defaultTierFor(executor));
  const allowedTools = sanitizeStringList(input.allowedTools, "allowed tool");
  if (input.commandAllowlist && input.commandAllowlist.length > 0 && executor !== "local_command") {
    throw new Error(
      "--allow-command is only valid for executor local_command; refusing to scaffold a " + executor + " agent with command allowlist entries."
    );
  }
  const commandAllowlist =
    executor === "local_command" ? sanitizeCommandList(input.commandAllowlist) : [];
  const maxCost = input.maxCost ?? defaultMaxCostFor(executor);
  if (maxCost < 0) throw new Error("max cost must be a nonnegative number.");

  const registry = AgentRegistrySchema.parse(await loadJson(root, "state/agent_registry.json"));
  if (registry.agents.some((agent) => agent.agent_id === id)) {
    throw new Error("Agent " + id + " already exists. Refusing to overwrite.");
  }

  const draft: Record<string, unknown> = {
    agent_id: id,
    role,
    executor_type: executor,
    model_tier: modelTier,
    allowed_tools: allowedTools,
    command_allowlist: commandAllowlist,
    permissions: { ...SAFE_PERMISSIONS },
    max_cost_usd: maxCost
  };
  if (input.model) draft.model = requireNonEmpty(input.model, "model");

  const agent = AgentSchema.parse(draft);
  registry.agents.push(agent);
  AgentRegistrySchema.parse(registry);
  await saveJson(root, "state/agent_registry.json", registry);

  return {
    summary: "Scaffolded agent " + id + ".",
    changedPaths: ["state/agent_registry.json"],
    rollback: ["Remove agent " + id + " from state/agent_registry.json, then run maw doctor."],
    notes: [],
    nextCommand: "maw doctor",
    reason: "verify scaffolded extension before routing work."
  };
}

export async function scaffoldReviewer(
  root: string,
  input: ScaffoldReviewerInput
): Promise<ScaffoldResult> {
  const id = requireSafeId(input.id, "Reviewer id");
  const persona = parsePersona(input.persona);
  const modelTier = parseModelTier(input.modelTier ?? "high");
  const maxCost = input.maxCost ?? 1;
  if (maxCost < 0) throw new Error("max cost must be a nonnegative number.");

  const registry = AgentRegistrySchema.parse(await loadJson(root, "state/agent_registry.json"));
  if (registry.agents.some((agent) => agent.agent_id === id)) {
    throw new Error("Agent " + id + " already exists. Refusing to overwrite.");
  }

  const draft: Record<string, unknown> = {
    agent_id: id,
    role: "Reviewer Agent",
    executor_type: "model_agent",
    model_tier: modelTier,
    reviewer_persona: persona,
    allowed_tools: [],
    command_allowlist: [],
    permissions: { ...SAFE_PERMISSIONS },
    max_cost_usd: maxCost
  };
  if (input.model) draft.model = requireNonEmpty(input.model, "model");

  const agent = AgentSchema.parse(draft);
  registry.agents.push(agent);
  AgentRegistrySchema.parse(registry);
  await saveJson(root, "state/agent_registry.json", registry);

  return {
    summary: "Scaffolded reviewer " + id + " with persona " + persona + ".",
    changedPaths: ["state/agent_registry.json"],
    rollback: ["Remove agent " + id + " from state/agent_registry.json, then run maw doctor."],
    notes: [],
    nextCommand: "maw doctor",
    reason: "verify scaffolded reviewer before high-risk review work."
  };
}

export async function scaffoldProtocol(
  root: string,
  input: ScaffoldProtocolInput
): Promise<ScaffoldResult> {
  const name = requireSafeProtocolName(input.name);
  const title = input.title && input.title.trim().length > 0 ? input.title.trim() : titleCase(name);
  if (input.title !== undefined && input.title.trim().length === 0) {
    throw new Error("Protocol title must be non-empty when provided.");
  }
  const relativePath = "protocols/" + name + ".md";
  const protocolsDir = resolve(root, "protocols");
  const target = resolve(protocolsDir, name + ".md");
  if (target !== join(protocolsDir, name + ".md") || !target.startsWith(protocolsDir + sep)) {
    throw new Error("Protocol path escape blocked: " + relativePath);
  }
  if (await pathExists(target)) {
    throw new Error("Protocol " + relativePath + " already exists. Refusing to overwrite.");
  }

  const content = renderProtocol(title, input.body);
  await saveText(root, relativePath, content);

  return {
    summary: "Scaffolded protocol " + relativePath + ".",
    changedPaths: [relativePath],
    rollback: ["Delete " + relativePath + ", then run maw status."],
    notes: [],
    nextCommand: "maw status",
    reason: "verify scaffolded protocol before referencing it from a task."
  };
}

export async function scaffoldCommand(
  root: string,
  input: ScaffoldCommandInput
): Promise<ScaffoldResult> {
  const agentId = requireSafeId(input.agentId, "Agent id");
  const command = requireSafeCommand(input.command);
  const role = input.role && input.role.trim().length > 0 ? input.role.trim() : "Shell Agent";
  if (input.role !== undefined && input.role.trim().length === 0) {
    throw new Error("Role must be non-empty when provided.");
  }
  const modelTier = parseModelTier(input.modelTier ?? "low");

  const registry = AgentRegistrySchema.parse(await loadJson(root, "state/agent_registry.json"));
  const existingIndex = registry.agents.findIndex((agent) => agent.agent_id === agentId);

  let summary: string;
  let rollback: string[];

  if (existingIndex < 0) {
    const draft: Record<string, unknown> = {
      agent_id: agentId,
      role,
      executor_type: "local_command",
      model_tier: modelTier,
      allowed_tools: [],
      command_allowlist: [command],
      permissions: { ...SAFE_PERMISSIONS },
      max_cost_usd: 0
    };
    const agent = AgentSchema.parse(draft);
    registry.agents.push(agent);
    summary = "Scaffolded command profile " + agentId + " for " + command + ".";
    rollback = [
      "Remove " + command + " from " + agentId + " command_allowlist, or remove agent " + agentId + " entirely if it was created only for this command."
    ];
  } else {
    const existing = registry.agents[existingIndex];
    if (!existing) {
      throw new Error("Agent " + agentId + " could not be loaded from registry.");
    }
    if (existing.executor_type !== "local_command") {
      throw new Error(
        "Agent " + agentId + " is executor_type " + existing.executor_type + ", not local_command. Refusing to add a command profile."
      );
    }
    if (existing.command_allowlist.includes(command)) {
      summary = "Command " + command + " is already on " + agentId + " allowlist; no change.";
      rollback = ["Remove " + command + " from " + agentId + " command_allowlist if it is no longer needed."];
    } else {
      const updated = AgentSchema.parse({
        ...existing,
        command_allowlist: [...existing.command_allowlist, command]
      });
      registry.agents[existingIndex] = updated;
      summary = "Added command " + command + " to " + agentId + " allowlist.";
      rollback = ["Remove " + command + " from " + agentId + " command_allowlist in state/agent_registry.json."];
    }
  }

  AgentRegistrySchema.parse(registry);
  await saveJson(root, "state/agent_registry.json", registry);

  return {
    summary,
    changedPaths: ["state/agent_registry.json"],
    rollback,
    notes: ["Local execution still requires deployment approval and maw run --execute."],
    nextCommand: "maw doctor",
    reason: "verify command policy before approving local execution."
  };
}

export function renderScaffoldResult(result: ScaffoldResult): string {
  const lines: string[] = [result.summary, "", "Changed:"];
  for (const path of result.changedPaths) lines.push("- " + path);
  lines.push("");
  lines.push("Rollback:");
  for (const entry of result.rollback) lines.push("- " + entry);
  if (result.notes.length > 0) {
    lines.push("");
    lines.push("Note:");
    for (const note of result.notes) lines.push("- " + note);
  }
  lines.push("");
  lines.push("Next: " + result.nextCommand);
  lines.push("Reason: " + result.reason);
  return lines.join("\n");
}

function renderProtocol(title: string, body: string | undefined): string {
  const purpose =
    body && body.trim().length > 0 ? body.trim() : "Describe the purpose of this protocol.";
  return [
    "# " + title,
    "",
    "Purpose:",
    purpose,
    "",
    "Required Inputs:",
    "List inputs the operator must supply before following this protocol.",
    "",
    "Steps:",
    "1. First step.",
    "2. Second step.",
    "",
    "Acceptance Criteria:",
    "List how to verify the protocol completed correctly.",
    "",
    "Rollback:",
    "Describe how to revert if the protocol cannot complete safely.",
    ""
  ].join("\n");
}

function titleCase(name: string): string {
  return name
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(label + " must be non-empty.");
  }
  return value.trim();
}

function requireSafeId(value: string, label: string): string {
  const trimmed = requireNonEmpty(value, label);
  if (!SAFE_ID_PATTERN.test(trimmed)) {
    throw new Error(label + " must start with a letter and contain only letters, digits, underscore, or hyphen.");
  }
  return trimmed;
}

function requireSafeProtocolName(value: string): string {
  const trimmed = requireNonEmpty(value, "Protocol name");
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    /\s/.test(trimmed)
  ) {
    throw new Error("Protocol name must not contain slash, backslash, dot-dot, or whitespace.");
  }
  if (!SAFE_PROTOCOL_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      "Protocol name must be lowercase letters, digits, and hyphens only, and must not start or end with a hyphen."
    );
  }
  return trimmed;
}

function requireSafeCommand(value: string): string {
  const trimmed = requireNonEmpty(value, "Command");
  if (/\s/.test(trimmed) || /[\\/;&|<>()*?"'\x60$]/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(
      "Command must be a bare executable name without whitespace, slash, backslash, or shell separators."
    );
  }
  if (!SAFE_COMMAND_PATTERN.test(trimmed)) {
    throw new Error(
      "Command must start with a letter or digit and contain only letters, digits, underscore, hyphen, or dot."
    );
  }
  return trimmed;
}

function parseExecutor(value: string): ExecutorType {
  const result = ExecutorTypeSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Executor must be one of model_agent, local_command, or dry_run.");
  }
  return result.data;
}

function parseModelTier(value: string): ModelTier {
  const result = ModelTierSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Model tier must be one of low, mid, or high.");
  }
  return result.data;
}

function parsePersona(value: string): ReviewerPersona {
  const result = ReviewerPersonaSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "Persona must be one of default, skeptical, completeness, rigor, or adversarial."
    );
  }
  return result.data;
}

function defaultTierFor(executor: ExecutorType): ModelTier {
  if (executor === "local_command") return "low";
  return "mid";
}

function defaultMaxCostFor(executor: ExecutorType): number {
  if (executor === "model_agent") return 1;
  return 0;
}

function sanitizeStringList(values: string[] | undefined, label: string): string[] {
  if (!values || values.length === 0) return [];
  const cleaned: string[] = [];
  for (const value of values) {
    const trimmed = requireNonEmpty(value, label);
    if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
  }
  return cleaned;
}

function sanitizeCommandList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const cleaned: string[] = [];
  for (const value of values) {
    const trimmed = requireSafeCommand(value);
    if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
  }
  return cleaned;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

