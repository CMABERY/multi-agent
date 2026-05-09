import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { nextId } from "./ids.js";
import { incrementMetric } from "./metrics.js";
import { collectPlanIssues } from "./planCheck.js";
import {
  AgentRegistrySchema,
  ArtifactIndexSchema,
  DeploymentPlanStoreSchema,
  IntentQueueSchema,
  LearningMemorySchema,
  OrchestratorOutputSchema,
  TaskBoardSchema,
  type AgentRegistry,
  type DeploymentAssignment,
  type DeploymentPlan,
  type IntelligenceIssue,
  type Intent,
  type LearningRule,
  type ModelConfig,
  type OrchestratorOutput,
  type Task
} from "./schemas.js";
import {
  createDefaultModelClient,
  estimateModelCostUsd,
  loadModelConfig,
  type ModelClient,
  selectModel
} from "./openai.js";
import { loadJson, loadJsonOrDefault, nowIso, saveJson, saveText } from "./storage.js";

const ORCHESTRATOR_INSTRUCTIONS = [
  "You are the orchestrator agent for a local multi-agent workflow runtime.",
  "Convert the user intent into a prompt contract, bounded tasks, registered-agent assignments, and decision records.",
  "Return only strict JSON with this shape:",
  "{",
  "  \"prompt_contract_markdown\": \"# Prompt Contract...\",",
  "  \"tasks\": [{",
  "    \"title\": \"Task title\",",
  "    \"owner_agent_id\": \"registered_agent_id\",",
  "    \"owner_role\": \"Role name\",",
  "    \"executor\": \"model_agent|local_command|dry_run\",",
  "    \"model_tier\": \"low|mid|high\",",
  "    \"input_context\": [\"state/prompt_contract.md\"],",
  "    \"output_required\": \"Required output\",",
  "    \"acceptance_criteria\": [\"Specific criterion\"],",
  "    \"dependencies\": [\"T-001\"],",
  "    \"risk_level\": \"low|medium|high\",",
  "    \"review_required\": true,",
  "    \"approval_required\": false",
  "  }],",
  "  \"deployment_plan\": {",
  "    \"approval_required\": true,",
  "    \"assignments\": [{",
  "      \"task_id\": \"T-001\",",
  "      \"agent_id\": \"registered_agent_id\",",
  "      \"executor\": \"model_agent|local_command|dry_run\",",
  "      \"model_tier\": \"low|mid|high\",",
  "      \"reason\": \"Why this target is appropriate\",",
  "      \"approval_required\": false",
  "    }]",
  "  },",
  "  \"decisions\": [{\"decision\": \"Decision\", \"rationale\": \"Rationale\", \"owner\": \"orchestrator\"}]",
  "}",
  "Use task ids T-001, T-002, etc. in the order tasks appear. Approval is required before deployment execution."
].join("\n");

export async function createIntent(
  root: string,
  input: {
    text: string;
    constraints?: string[];
    riskLevel?: "low" | "medium" | "high";
    budget?: string;
  }
): Promise<Intent> {
  const queue = IntentQueueSchema.parse(await loadJson(root, "state/intent_queue.json"));
  const now = nowIso();
  const intent: Intent = {
    intent_id: nextId(
      "I",
      queue.intents.map((entry) => entry.intent_id)
    ),
    text: input.text,
    constraints: input.constraints ?? [],
    risk_level: input.riskLevel ?? "medium",
    budget: input.budget,
    status: "new",
    created_at: now,
    updated_at: now
  };
  queue.intents.push(intent);
  await saveJson(root, "state/intent_queue.json", queue);
  return intent;
}

export async function orchestrateIntent(
  root: string,
  input: {
    intentId: string;
    modelClient?: ModelClient;
  }
): Promise<{ deployment_id: string; task_ids: string[] }> {
  const queue = IntentQueueSchema.parse(await loadJson(root, "state/intent_queue.json"));
  const intent = queue.intents.find((entry) => entry.intent_id === input.intentId);
  if (!intent) throw new Error("Intent not found: " + (input.intentId));

  const planStore = DeploymentPlanStoreSchema.parse(
    await loadJson(root, "state/deployment_plan.json")
  );
  const existingDeployments = planStore.deployment_plans
    .filter((entry) => entry.intent_id === intent.intent_id)
    .map((entry) => entry.deployment_id);
  if (existingDeployments.length > 0 || intent.status !== "new") {
    const deploymentSuffix =
      existingDeployments.length > 0
        ? " Existing deployments: " + existingDeployments.join(", ") + "."
        : "";
    throw new Error(
      "Intent " + intent.intent_id + " cannot be re-orchestrated (status: " + intent.status + ")." + deploymentSuffix
    );
  }

  const registry = AgentRegistrySchema.parse(await loadJson(root, "state/agent_registry.json"));
  const config = await loadModelConfig(root);
  const client = input.modelClient ?? (await createDefaultModelClient(root));
  const model = selectModel(config, "orchestrator");
  const board = TaskBoardSchema.parse(await loadJson(root, "state/task_board.json"));
  const artifactIndex = ArtifactIndexSchema.parse(await loadJson(root, "artifacts/artifact_index.json"));
  const activeRules = await loadActiveLearningRules(root, config);
  const instructions = buildOrchestratorInstructions(activeRules);
  const baseInput = buildOrchestratorInput(intent, registry);
  const now = nowIso();
  const deploymentId = nextId(
    "DP",
    planStore.deployment_plans.map((entry) => entry.deployment_id)
  );
  const existingTaskIds = board.tasks.map((entry) => entry.task_id);
  let revisionInput = "";
  let lastHighIssues: IntelligenceIssue[] = [];

  for (let attempt = 0; attempt <= config.orchestrator_max_retries; attempt += 1) {
    const output = await requestOrchestratorOutput(root, {
      client,
      config,
      model,
      instructions,
      input: revisionInput ? "" + (baseInput) + "\n\n" + (revisionInput) : baseInput
    });
    const proposed = buildProposedDeployment({
      output,
      intent,
      registry,
      deploymentId,
      existingTaskIds,
      now
    });
    const highIssues = collectPlanIssues({
      plan: proposed.plan,
      tasks: proposed.tasks,
      registry,
      artifactIndex,
      config
    }).filter((issue) => issue.severity === "high");
    if (highIssues.length === 0) {
      if (attempt > 0) {
        output.decisions = [
          {
            decision: "Revised orchestrator plan to address pre-flight violations",
            rationale: "Auto-revision after " + (attempt) + " retry(ies). Resolved triggers: " + (uniqueCodes(lastHighIssues).join(", ")) + ".",
            owner: "orchestrator"
          },
          ...output.decisions
        ];
      }
      board.tasks.push(...proposed.tasks);
      planStore.deployment_plans.push(proposed.plan);
      intent.status = "planned";
      intent.updated_at = nowIso();

      await saveText(root, "state/prompt_contract.md", output.prompt_contract_markdown);
      await saveJson(root, "state/task_board.json", board);
      await saveJson(root, "state/deployment_plan.json", planStore);
      await saveJson(root, "state/intent_queue.json", queue);
      await appendDecisions(root, output.decisions);

      return { deployment_id: deploymentId, task_ids: proposed.tasks.map((task) => task.task_id) };
    }
    lastHighIssues = highIssues;
    revisionInput = buildRevisionInput(highIssues);
  }

  throw new Error(
    "Orchestrator could not produce a valid plan after " + (config.orchestrator_max_retries) + " retries. Final violations: " + (uniqueCodes(lastHighIssues).join(", ")) + "."
  );
}

async function requestOrchestratorOutput(
  root: string,
  input: {
    client: ModelClient;
    config: ModelConfig;
    model: string;
    instructions: string;
    input: string;
  }
): Promise<OrchestratorOutput> {
  const response = await input.client.createResponse({
    model: input.model,
    instructions: input.instructions,
    input: input.input,
    maxOutputTokens: input.config.max_output_tokens
  });
  await incrementMetric(root, "model_calls", estimateModelCostUsd(input.config, input.model, response.usage));
  if (response.truncated) {
    throw new Error("Model response truncated at max_output_tokens (" + (input.config.max_output_tokens) + ").");
  }
  return OrchestratorOutputSchema.parse(parseModelJson(response.text));
}

function buildProposedDeployment(input: {
  output: OrchestratorOutput;
  intent: Intent;
  registry: AgentRegistry;
  deploymentId: string;
  existingTaskIds: string[];
  now: string;
}): { tasks: Task[]; plan: DeploymentPlan } {
  const createdTaskIds = input.output.tasks.map((_, index) =>
    nextId("T", [
      ...input.existingTaskIds,
      ...Array.from({ length: index }, (_unused, i) => "T-" + (String(input.existingTaskIds.length + i + 1).padStart(3, "0")))
    ])
  );
  const taskIdMap = new Map<string, string>();
  createdTaskIds.forEach((taskId, index) => {
    taskIdMap.set("T-" + (String(index + 1).padStart(3, "0")), taskId);
  });

  const knownAgents = new Set(input.registry.agents.map((agent) => agent.agent_id));
  const tasks: Task[] = input.output.tasks.map((task, index) => {
    if (!knownAgents.has(task.owner_agent_id)) {
      throw new Error("Orchestrator selected unknown agent: " + (task.owner_agent_id));
    }
    return {
      ...task,
      task_id: createdTaskIds[index] ?? nextId("T", [...input.existingTaskIds, ...createdTaskIds]),
      dependencies: task.dependencies.map((dependency) => taskIdMap.get(dependency) ?? dependency),
      status: "queued",
      artifacts: [],
      deployment_id: input.deploymentId,
      created_at: input.now,
      updated_at: input.now
    };
  });

  const createdTaskIdSet = new Set(tasks.map((task) => task.task_id));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!createdTaskIdSet.has(dependency) && !input.existingTaskIds.includes(dependency)) {
        throw new Error("Task " + (task.task_id) + " depends on unknown task " + (dependency));
      }
    }
  }

  const assignments: DeploymentAssignment[] = input.output.deployment_plan.assignments.map((assignment) => {
    const taskId = taskIdMap.get(assignment.task_id) ?? assignment.task_id;
    const task = tasks.find((entry) => entry.task_id === taskId);
    if (!task) throw new Error("Deployment assignment references unknown task: " + (assignment.task_id));
    if (!knownAgents.has(assignment.agent_id)) {
      throw new Error("Deployment assignment references unknown agent: " + (assignment.agent_id));
    }
    return {
      ...assignment,
      task_id: taskId
    };
  });

  const plan: DeploymentPlan = {
    deployment_id: input.deploymentId,
    intent_id: input.intent.intent_id,
    status: "proposed",
    approval_required: true,
    assignments,
    created_at: input.now,
    updated_at: input.now
  };
  return { tasks, plan };
}

function buildOrchestratorInput(intent: Intent, registry: AgentRegistry): string {
  return [
    "Intent ID: " + (intent.intent_id),
    "User Intent: " + (intent.text),
    "Risk Level: " + (intent.risk_level),
    "Budget: " + (intent.budget ?? "not specified"),
    "Constraints: " + (intent.constraints.length > 0 ? intent.constraints.join("; ") : "none"),
    "",
    "Registered agents:",
    ...registry.agents.map((agent) => formatAgentForOrchestrator(agent))
  ].join("\n");
}

function formatAgentForOrchestrator(agent: AgentRegistry["agents"][number]): string {
  const base = "- " + (agent.agent_id) + ": " + (agent.role) + "; executor=" + (agent.executor_type) + "; tier=" + (agent.model_tier ?? "unspecified");
  const performance = agent.performance;
  if (!performance || performance.tasks_assigned === 0) return base;
  const tokens = [
    "assigned=" + (performance.tasks_assigned),
    "completed=" + (performance.tasks_completed),
    "failed=" + (performance.tasks_failed),
    "reviews=" + (performance.review_passes) + "/" + (performance.review_failures)
  ];
  if (performance.dry_run_deliverable_mismatches > 0) {
    tokens.push("dry_run_mismatches=" + (performance.dry_run_deliverable_mismatches));
  }
  return "" + (base) + "; " + (tokens.join(" "));
}

async function loadActiveLearningRules(root: string, config: ModelConfig): Promise<LearningRule[]> {
  const memory = LearningMemorySchema.parse(
    await loadJsonOrDefault(root, "state/learning_memory.json", { learning_rules: [] })
  );
  return memory.learning_rules
    .filter((rule) => rule.confidence * rule.times_seen >= config.learning_rule_threshold)
    .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))
    .slice(0, config.learning_rule_cap);
}

function buildOrchestratorInstructions(rules: LearningRule[]): string {
  if (rules.length === 0) return ORCHESTRATOR_INSTRUCTIONS;
  return [
    ORCHESTRATOR_INSTRUCTIONS,
    "",
    "## Active learning rules from prior runs",
    "These rules were derived from past failures. Plans that violate them will be rejected.",
    ...rules.map((rule) => "- " + (rule.rule) + " (trigger: " + (rule.trigger) + "; seen: " + (rule.times_seen) + " times)"),
    "If your plan triggers any of these, expect rejection and revision."
  ].join("\n");
}

function buildRevisionInput(issues: IntelligenceIssue[]): string {
  return [
    "The previous plan was rejected for these high-severity violations:",
    ...issues.flatMap((issue) => [
      "- " + (issue.code) + " at " + (issue.target) + ": " + (issue.message),
      "  Recommended fix: " + (issue.recommended_fix)
    ]),
    "",
    "Produce a revised plan that addresses every violation. Keep all other fields identical unless changing them is necessary to resolve a violation."
  ].join("\n");
}

function uniqueCodes(issues: IntelligenceIssue[]): string[] {
  return Array.from(new Set(issues.map((issue) => issue.code)));
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  return JSON.parse(json);
}

async function appendDecisions(
  root: string,
  decisions: Array<{ decision: string; rationale: string; owner: string; dissent?: string }>
): Promise<void> {
  if (decisions.length === 0) return;
  const current = await readFile(join(root, "state/decision_log.md"), "utf8");
  const entries = decisions
    .map((decision) =>
      [
        "## " + (decision.decision),
        "",
        "Rationale: " + (decision.rationale),
        "Owner: " + (decision.owner),
        "Date: " + (nowIso()),
        decision.dissent ? "Dissent: " + (decision.dissent) : undefined,
        ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n");
  const seed = "# Decision Log\n\nNo decisions recorded yet.";
  const base = current.trim() === seed ? "# Decision Log" : current.trim();
  await saveText(root, "state/decision_log.md", "" + (base) + "\n\n" + (entries));
}
