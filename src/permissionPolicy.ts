import { nextId } from "./ids.js";
import {
  PermissionAuditStoreSchema,
  type Agent,
  type CommandSpecSchema,
  type PermissionAuditEvent,
  type PermissionGrant,
  type Task
} from "./schemas.js";
import type { z } from "zod";
import { loadJsonOrDefault, nowIso, saveJson } from "./storage.js";

type CommandSpec = z.infer<typeof CommandSpecSchema>;

export interface ToolActionSignals {
  dependencyArtifactCount: number;
  workspaceContextPathCount: number;
}

export interface CommandActionSignals {
  commandName: string;
  argCount: number;
}

export type ToolAuthorizationRequest = {
  kind: "tool.web_search";
  agent: Agent;
  task: Task;
  signals: ToolActionSignals;
};

export type CommandAuthorizationRequest = {
  kind: "command.execute";
  agent: Agent;
  task: Task;
  signals: CommandActionSignals;
};

export type ActionAuthorizationRequest =
  | ToolAuthorizationRequest
  | CommandAuthorizationRequest;

export interface PolicyDecision {
  decision: "allow" | "deny";
  required_grants: PermissionGrant[];
  granted_grants: PermissionGrant[];
  missing_grants: PermissionGrant[];
  reason: string;
}

export function classifyToolAuthorization(input: {
  toolType: string;
  agent: Agent;
  task: Task;
  signals: ToolActionSignals;
}): ToolAuthorizationRequest | undefined {
  if (input.toolType !== "web_search") return undefined;
  return {
    kind: "tool.web_search",
    agent: input.agent,
    task: input.task,
    signals: input.signals
  };
}

export function classifyCommandAuthorization(input: {
  commandSpec: CommandSpec;
  agent: Agent;
  task: Task;
}): CommandAuthorizationRequest {
  return {
    kind: "command.execute",
    agent: input.agent,
    task: input.task,
    signals: {
      commandName: input.commandSpec.command,
      argCount: input.commandSpec.args.length
    }
  };
}

export function requiredGrantsFor(request: ActionAuthorizationRequest): PermissionGrant[] {
  if (request.kind === "tool.web_search") {
    const required: PermissionGrant[] = ["PublicSearch"];
    const carriesPrivateContext =
      request.signals.dependencyArtifactCount > 0 ||
      request.signals.workspaceContextPathCount > 1;
    if (carriesPrivateContext) required.push("PrivateQueryEgress");
    return required;
  }
  if (request.kind === "command.execute") {
    return ["LocalCommandExecute"];
  }
  return [];
}

export function effectiveGrants(agent: Agent): PermissionGrant[] {
  const explicit = (agent.permissions.policy_grants ?? []) as PermissionGrant[];
  const grants = new Set<PermissionGrant>(explicit);
  if (agent.permissions.external_actions) grants.add("PublicSearch");
  return Array.from(grants);
}

export function evaluateAuthorization(request: ActionAuthorizationRequest): PolicyDecision {
  const required = requiredGrantsFor(request);
  const granted = effectiveGrants(request.agent);
  const grantedSet = new Set(granted);
  const missing = required.filter((grant) => !grantedSet.has(grant));
  if (missing.length === 0) {
    return {
      decision: "allow",
      required_grants: required,
      granted_grants: granted,
      missing_grants: [],
      reason:
        "Agent " +
        request.agent.agent_id +
        " holds all grants required for " +
        request.kind +
        (required.length > 0 ? " (" + required.join(", ") + ")" : "") +
        "."
    };
  }
  return {
    decision: "deny",
    required_grants: required,
    granted_grants: granted,
    missing_grants: missing,
    reason:
      "Default-deny: agent " +
      request.agent.agent_id +
      " is missing grants for " +
      request.kind +
      ": " +
      missing.join(", ") +
      "."
  };
}

function flattenSignals(request: ActionAuthorizationRequest): Record<string, string | number> {
  if (request.kind === "tool.web_search") {
    return {
      dependency_artifact_count: request.signals.dependencyArtifactCount,
      workspace_context_path_count: request.signals.workspaceContextPathCount
    };
  }
  if (request.kind === "command.execute") {
    return {
      command_name: request.signals.commandName,
      arg_count: request.signals.argCount
    };
  }
  return {};
}

export async function recordPermissionAudit(
  root: string,
  input: {
    deploymentId?: string;
    request: ActionAuthorizationRequest;
    decision: PolicyDecision;
  }
): Promise<PermissionAuditEvent> {
  const store = PermissionAuditStoreSchema.parse(
    await loadJsonOrDefault(root, "state/permission_audit.json", { events: [] })
  );
  const event: PermissionAuditEvent = {
    event_id: nextId(
      "PA",
      store.events.map((entry) => entry.event_id)
    ),
    created_at: nowIso(),
    deployment_id: input.deploymentId,
    task_id: input.request.task.task_id,
    agent_id: input.request.agent.agent_id,
    action_kind: input.request.kind,
    action_signals: flattenSignals(input.request),
    required_grants: input.decision.required_grants,
    granted_grants: input.decision.granted_grants,
    missing_grants: input.decision.missing_grants,
    decision: input.decision.decision,
    reason: input.decision.reason
  };
  store.events.push(event);
  await saveJson(root, "state/permission_audit.json", store);
  return event;
}
