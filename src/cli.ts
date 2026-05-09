import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { recordApproval } from "./approvals.js";
import { renderAutoPlanResult, runAutoPlan } from "./autoPlan.js";
import { postureExitCode, runBootstrap } from "./bootstrap.js";
import { computeConsensus } from "./consensus.js";
import { runContextCheck } from "./contextCheck.js";
import { renderDoctorReport, runOperatorDoctor } from "./operatorDoctor.js";
import {
  deriveOperatorMetrics,
  readOperatorExperience,
  renderOperatorExperienceReport
} from "./operatorExperience.js";
import { renderCurrentTransitionGuidance } from "./operatorGuidance.js";
import {
  readTransactionSummary,
  type TransactionStatusSummary
} from "./operatorTransactions.js";
import {
  readOperatorState,
  resolveActiveDeploymentId,
  resolveActiveIntentId,
  resolveActiveTaskId,
  type OperatorCondition,
  type OperatorReadiness,
  type OperatorState
} from "./operatorState.js";
import { createIntent, orchestrateIntent } from "./orchestrator.js";
import { updateAgentPerformance } from "./performance.js";
import { runPlanCheck } from "./planCheck.js";
import { generateReport } from "./report.js";
import { migrateLegacyReviews, recordReview } from "./reviews.js";
import { runRetrospective } from "./retrospective.js";
import { runDeployment } from "./runner.js";
import {
  renderScaffoldResult,
  scaffoldAgent,
  scaffoldCommand,
  scaffoldProtocol,
  scaffoldReviewer
} from "./scaffold.js";
import type { BootstrapWorkType } from "./schemas.js";
import { writeWorkflowScore } from "./scoring.js";
import { validateWorkspace } from "./validator.js";
import { initWorkspace } from "./workspace.js";

const VALID_WORK_TYPES: BootstrapWorkType[] = ["ordinary", "stateful", "architecture", "risky"];

export function createCli(root = process.cwd()): Command {
  const program = new Command();
  program.name("maw").description("Agentic orchestrator runtime").version("0.1.0");

  program.command("init").description("Initialize a workflow workspace").action(async () => {
    await initWorkspace(root);
    console.log("Initialized multi-agent workflow workspace.");
    await printTransitionGuidance(root);
  });

  program.command("status").description("Summarize current workflow state and next action").action(async () => {
    const [state, transactions] = await Promise.all([
      readOperatorState(root),
      readTransactionSummary(root)
    ]);
    console.log(renderOperatorStatus(state, transactions));
  });

  program
    .command("next")
    .option("--reason", "Also print the recommendation reason")
    .description("Print the single recommended next command")
    .action(async (options: { reason?: boolean }) => {
      const state = await readOperatorState(root);
      if (options.reason) {
        console.log(state.recommended_next_command + "\nReason: " + state.recommended_next_reason);
        return;
      }
      console.log(state.recommended_next_command);
    });

  program.command("doctor").description("Diagnose workspace and workflow issues without modifying state").action(async () => {
    console.log(renderDoctorReport(await runOperatorDoctor(root)));
  });

  const intent = program.command("intent").description("Manage user intents");
  intent
    .command("create")
    .option("--text <text>", "User task or intent (inline text)")
    .option("--text-file <path>", "Read user task or intent from a file at path")
    .option("--constraint <constraint...>", "Constraint to add")
    .option("--risk <risk>", "Risk level: low, medium, high", "medium")
    .option("--budget <budget>", "Budget description")
    .action(
      async (options: {
        text?: string;
        textFile?: string;
        constraint?: string[];
        risk: string;
        budget?: string;
      }) => {
        const text = await resolveIntentText(options);
        const created = await createIntent(root, {
          text,
          constraints: options.constraint ?? [],
          riskLevel: options.risk,
          budget: options.budget
        });
        console.log("Created intent " + created.intent_id + ".");
        await printTransitionGuidance(root);
      }
    );

  program
    .command("orchestrate")
    .option("--intent <intentId>", "Intent id such as I-001; defaults to the active intent")
    .description("Ask the orchestrator agent to create a contract, task graph, and deployment plan")
    .action(async (options: { intent?: string }) => {
      const intentId = await resolveActiveIntentId(root, options.intent);
      const result = await orchestrateIntent(root, { intentId });
      console.log("Created deployment " + (result.deployment_id) + " with tasks " + (result.task_ids.join(", ")) + ".");
      await printTransitionGuidance(root);
    });

  program
    .command("plan")
    .option("--text <text>", "User task or intent (inline text)")
    .option("--text-file <path>", "Read user task or intent from a file at path")
    .option("--constraint <constraint...>", "Constraint to add")
    .option("--risk <risk>", "Risk level: low, medium, high", "medium")
    .option("--budget <budget>", "Budget description")
    .option("--json", "Print machine-readable JSON")
    .description(
      "Create an intent and chain orchestrate plus plan-check, stopping at the approval gate"
    )
    .action(
      async (options: {
        text?: string;
        textFile?: string;
        constraint?: string[];
        risk: string;
        budget?: string;
        json?: boolean;
      }) => {
        const text = await resolveIntentText(options);
        const result = await runAutoPlan(root, {
          text,
          constraints: options.constraint ?? [],
          riskLevel: options.risk,
          budget: options.budget
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(renderAutoPlanResult(result));
          await printTransitionGuidance(root);
        }
        if (result.plan_check_high_severity) process.exitCode = 1;
      }
    );

  const approval = program.command("approval").description("Record human approval decisions");
  approval
    .command("record")
    .option("--deployment <deploymentId>", "Deployment id such as DP-001; defaults to the active deployment")
    .requiredOption("--approver <name>", "Approver name")
    .requiredOption("--scope <scope>", "Exact approved or rejected scope")
    .option("--decision <decision>", "approved or rejected", "approved")
    .action(
      async (options: {
        deployment?: string;
        approver: string;
        scope: string;
        decision: "approved" | "rejected";
      }) => {
        const deploymentId = await resolveActiveDeploymentId(root, options.deployment);
        const approvalRecord = await recordApproval(root, {
          deploymentId,
          approver: options.approver,
          decision: options.decision,
          scope: options.scope
        });
        console.log("Recorded approval " + approvalRecord.approval_id + ".");
        await printTransitionGuidance(root);
      }
    );

  const review = program.command("review").description("Record independent task reviews");
  review
    .command("record")
    .option("--task <taskId>", "Task id such as T-001; defaults to the active task")
    .requiredOption("--reviewer <reviewer>", "Reviewer id or name")
    .option("--status <status>", "pass or fail", "pass")
    .option("--issue <issue...>", "Issue text to record for fail reviews")
    .action(
      async (options: {
        task?: string;
        reviewer: string;
        status: "pass" | "fail";
        issue?: string[];
      }) => {
        const taskId = await resolveActiveTaskId(root, options.task);
        const issues = (options.issue ?? []).map((issue, index) => ({
          issue_id: "I-" + (String(index + 1).padStart(3, "0")),
          severity: "medium" as const,
          category: "manual_review",
          description: issue,
          evidence: issue,
          recommended_fix: "Address the recorded review issue and recheck."
        }));
        const reviewRecord = await recordReview(root, {
          taskId,
          reviewer: options.reviewer,
          status: options.status,
          issues,
          malformed: true,
          freeFormAssessment: "Manual legacy-style CLI review; not load-bearing without structured criteria."
        });
        console.log("Recorded review " + reviewRecord.review_id + ".");
        await printTransitionGuidance(root);
      }
    );

  const consensus = program.command("consensus").description("Compute multi-reviewer consensus");
  consensus
    .command("compute")
    .option("--task <taskId>", "Task id such as T-001; defaults to the active task")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { task?: string; json?: boolean }) => {
      const taskId = await resolveActiveTaskId(root, options.task);
      const record = await computeConsensus(root, { taskId });
      if (options.json) {
        console.log(JSON.stringify(record, null, 2));
        return;
      }
      console.log("Consensus " + (record.consensus_id) + ": " + (record.overall_verdict));
      await printTransitionGuidance(root);
    });

  program
    .command("migrate")
    .description("Migrate legacy pre-v0.3 review records to structured abstentions")
    .action(async () => {
      const result = await migrateLegacyReviews(root);
      console.log("Migrated " + (result.migratedCount) + " legacy reviews.");
      await printTransitionGuidance(root);
    });

  program
    .command("run")
    .option("--deployment <deploymentId>", "Deployment id such as DP-001; defaults to the active deployment")
    .option("--execute", "Allow approved local-command adapters to execute")
    .option("--rerun", "Explicitly rerun a completed or failed deployment")
    .description("Run an approved deployment plan")
    .action(async (options: { deployment?: string; execute?: boolean; rerun?: boolean }) => {
      const deploymentId = await resolveActiveDeploymentId(root, options.deployment);
      const result = await runDeployment(root, {
        deploymentId,
        execute: Boolean(options.execute),
        rerun: Boolean(options.rerun)
      });
      console.log("Completed: " + (result.completed.join(", ") || "none"));
      if (result.failed.length > 0) console.log("Failed: " + (result.failed.join(", ")));
      await printTransitionGuidance(root);
      if (result.failed.length > 0) process.exitCode = 1;
    });

  program.command("validate").description("Validate workflow state consistency").action(async () => {
    const result = await validateWorkspace(root);
    if (result.valid) {
      console.log("Workflow state is valid.");
      await printTransitionGuidance(root);
      return;
    }
    for (const issue of result.issues) {
      console.error("" + (issue.code) + ": " + (issue.message));
    }
    process.exitCode = 1;
  });

  program
    .command("score")
    .option("--deployment <deploymentId>", "Deployment id such as DP-001; defaults to the active deployment")
    .option("--json", "Print machine-readable JSON")
    .description("Compute workflow intelligence yield for a deployment")
    .action(async (options: { deployment?: string; json?: boolean }) => {
      const deploymentId = await resolveActiveDeploymentId(root, options.deployment);
      const score = await writeWorkflowScore(root, { deploymentId });
      if (options.json) {
        console.log(JSON.stringify(score, null, 2));
        return;
      }
      console.log("Workflow Score " + (score.score_id));
      console.log("Deployment: " + (score.deployment_id));
      console.log("Verified Useful Outputs: " + (score.verified_useful_outputs));
      console.log("Consensus Pass Count: " + (score.consensus_pass_count));
      console.log("Consensus Split Count: " + (score.consensus_split_count));
      console.log("Consensus Insufficient Count: " + (score.consensus_insufficient_count));
      console.log("Review Pass Rate: " + (score.review_pass_rate.toFixed(3)));
      console.log("Workflow Intelligence Yield: " + (score.workflow_intelligence_yield.toFixed(4)));
      await printTransitionGuidance(root);
    });

  program
    .command("plan-check")
    .option("--deployment <deploymentId>", "Deployment id such as DP-001; defaults to the active deployment")
    .option("--json", "Print machine-readable JSON")
    .description("Check a deployment plan before approval or execution")
    .action(async (options: { deployment?: string; json?: boolean }) => {
      const deploymentId = await resolveActiveDeploymentId(root, options.deployment);
      const check = await runPlanCheck(root, { deploymentId });
      if (options.json) {
        console.log(JSON.stringify(check, null, 2));
      } else {
        console.log("Plan Check " + (check.check_id) + ": " + (check.status));
        for (const issue of check.issues) {
          console.log("" + (issue.severity.toUpperCase()) + " " + (issue.code) + " " + (issue.target) + ": " + (issue.message));
          console.log("Fix: " + (issue.recommended_fix));
        }
        await printTransitionGuidance(root);
      }
      if (check.issues.some((issue) => issue.severity === "high")) process.exitCode = 1;
    });

  program
    .command("context-check")
    .option("--task <taskId>", "Task id such as T-007; defaults to the active task")
    .option("--json", "Print machine-readable JSON")
    .description("Check whether a task has sufficient scoped context")
    .action(async (options: { task?: string; json?: boolean }) => {
      const taskId = await resolveActiveTaskId(root, options.task);
      const check = await runContextCheck(root, { taskId });
      if (options.json) {
        console.log(JSON.stringify(check, null, 2));
      } else {
        console.log("Context Check " + (check.check_id) + ": " + (check.status));
        for (const issue of check.issues) {
          console.log("" + (issue.severity.toUpperCase()) + " " + (issue.code) + " " + (issue.target) + ": " + (issue.message));
          console.log("Fix: " + (issue.recommended_fix));
        }
        await printTransitionGuidance(root);
      }
      if (check.issues.some((issue) => issue.severity === "high")) process.exitCode = 1;
    });

  program
    .command("retrospective")
    .option("--deployment <deploymentId>", "Deployment id such as DP-001; defaults to the active deployment")
    .option("--json", "Print machine-readable JSON")
    .description("Generate a deterministic retrospective and update learning memory")
    .action(async (options: { deployment?: string; json?: boolean }) => {
      const deploymentId = await resolveActiveDeploymentId(root, options.deployment);
      const retrospective = await runRetrospective(root, { deploymentId });
      if (options.json) {
        console.log(JSON.stringify(retrospective, null, 2));
        return;
      }
      console.log("Retrospective " + (retrospective.retrospective_id));
      console.log("Path: " + (retrospective.path));
      console.log("Learned Rules: " + (retrospective.learned_rule_ids.join(", ") || "none"));
      await printTransitionGuidance(root);
    });

  const performance = program.command("performance").description("Manage agent performance memory");
  performance
    .command("update")
    .option("--deployment <deploymentId>", "Deployment id such as DP-001; defaults to the active deployment")
    .option("--json", "Print machine-readable JSON")
    .description("Update agent/executor performance stats from a deployment")
    .action(async (options: { deployment?: string; json?: boolean }) => {
      const deploymentId = await resolveActiveDeploymentId(root, options.deployment);
      const agents = await updateAgentPerformance(root, { deploymentId });
      if (options.json) {
        console.log(JSON.stringify({ agents }, null, 2));
        return;
      }
      for (const agent of agents) {
        if (!agent.performance) continue;
        console.log(
          "" + (agent.agent_id) + ": assigned=" + (agent.performance.tasks_assigned) + " completed=" + (agent.performance.tasks_completed) + " failed=" + (agent.performance.tasks_failed)
        );
      }
      await printTransitionGuidance(root);
    });

  const scaffold = program
    .command("scaffold")
    .description("Add sanctioned extensions: agent, reviewer, protocol, or local-command profile");

  scaffold
    .command("agent")
    .requiredOption("--id <id>", "Agent identifier")
    .requiredOption("--role <role>", "Agent role")
    .requiredOption("--executor <executor>", "model_agent, local_command, or dry_run")
    .option("--model-tier <tier>", "low, mid, or high")
    .option("--model <model>", "Explicit model name")
    .option("--max-cost <amount>", "Max cost in USD")
    .option("--allow-tool <tool...>", "Allowed tool names")
    .option("--allow-command <command...>", "Allowlisted commands (local_command only)")
    .description("Scaffold a sanctioned agent in state/agent_registry.json")
    .action(
      async (options: {
        id: string;
        role: string;
        executor: string;
        modelTier?: string;
        model?: string;
        maxCost?: string;
        allowTool?: string[];
        allowCommand?: string[];
      }) => {
        const result = await scaffoldAgent(root, {
          id: options.id,
          role: options.role,
          executor: options.executor,
          modelTier: options.modelTier,
          model: options.model,
          maxCost: parseMaxCost(options.maxCost),
          allowedTools: options.allowTool,
          commandAllowlist: options.allowCommand
        });
        console.log(renderScaffoldResult(result));
      }
    );

  scaffold
    .command("reviewer")
    .requiredOption("--id <id>", "Reviewer agent identifier")
    .requiredOption("--persona <persona>", "default, skeptical, completeness, rigor, or adversarial")
    .option("--model-tier <tier>", "low, mid, or high")
    .option("--model <model>", "Explicit model name")
    .option("--max-cost <amount>", "Max cost in USD")
    .description("Scaffold a sanctioned Reviewer Agent in state/agent_registry.json")
    .action(
      async (options: {
        id: string;
        persona: string;
        modelTier?: string;
        model?: string;
        maxCost?: string;
      }) => {
        const result = await scaffoldReviewer(root, {
          id: options.id,
          persona: options.persona,
          modelTier: options.modelTier,
          model: options.model,
          maxCost: parseMaxCost(options.maxCost)
        });
        console.log(renderScaffoldResult(result));
      }
    );

  scaffold
    .command("protocol")
    .requiredOption("--name <name>", "Protocol slug (lowercase letters, digits, hyphens)")
    .option("--title <title>", "Human-readable title")
    .option("--body <body>", "Optional body text under Purpose")
    .description("Scaffold a sanctioned protocol document under protocols/")
    .action(
      async (options: { name: string; title?: string; body?: string }) => {
        const result = await scaffoldProtocol(root, {
          name: options.name,
          title: options.title,
          body: options.body
        });
        console.log(renderScaffoldResult(result));
      }
    );

  scaffold
    .command("command")
    .requiredOption("--agent-id <id>", "Local-command agent identifier")
    .requiredOption("--command <command>", "Bare executable name to allowlist")
    .option("--role <role>", "Agent role for newly created agents")
    .option("--model-tier <tier>", "low, mid, or high")
    .description("Scaffold a sanctioned local-command execution profile in state/agent_registry.json")
    .action(
      async (options: {
        agentId: string;
        command: string;
        role?: string;
        modelTier?: string;
      }) => {
        const result = await scaffoldCommand(root, {
          agentId: options.agentId,
          command: options.command,
          role: options.role,
          modelTier: options.modelTier
        });
        console.log(renderScaffoldResult(result));
      }
    );

  const operator = program
    .command("operator")
    .description("Inspect operator-experience metrics");

  operator
    .command("metrics")
    .description("Print the local operator-experience metrics report")
    .action(async () => {
      const experience = await readOperatorExperience(root);
      const metrics = deriveOperatorMetrics(experience);
      console.log(renderOperatorExperienceReport(metrics));
    });

  program.command("report").description("Print a workflow execution report").action(async () => {
    console.log(await generateReport(root));
  });

  program
    .command("bootstrap")
    .option("--json", "Print the JSON packet instead of Markdown")
    .option("--work-type <type>", "ordinary|stateful|architecture|risky", "ordinary")
    .option("--persist", "Write the packet to state/bootstrap/BS-NNN.{md,json}")
    .description("Generate a session-readiness packet pairing continuity with counter-context")
    .action(async (options: { json?: boolean; workType: string; persist?: boolean }) => {
      if (!VALID_WORK_TYPES.includes(options.workType as BootstrapWorkType)) {
        throw new Error(
          "Invalid --work-type " + (options.workType) + ". Valid: " + (VALID_WORK_TYPES.join(", ")) + "."
        );
      }
      const result = await runBootstrap(root, {
        workType: options.workType as BootstrapWorkType,
        persist: Boolean(options.persist)
      });
      if (options.json) {
        console.log(JSON.stringify(result.packet, null, 2));
      } else {
        console.log(result.markdown);
        await printTransitionGuidance(root);
      }
      process.exitCode = postureExitCode(result.packet.posture);
    });

  return program;
}

async function printTransitionGuidance(root: string): Promise<void> {
  console.log(await renderCurrentTransitionGuidance(root));
}

async function resolveIntentText(options: {
  text?: string;
  textFile?: string;
}): Promise<string> {
  if (options.text !== undefined && options.textFile !== undefined) {
    throw new Error("Pass either --text or --text-file, not both.");
  }
  if (options.text !== undefined) return options.text;
  if (options.textFile !== undefined) {
    try {
      return await readFile(options.textFile, "utf8");
    } catch {
      throw new Error("Could not read --text-file " + options.textFile + ".");
    }
  }
  throw new Error("Either --text or --text-file is required.");
}

function parseMaxCost(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error("--max-cost must be a finite number.");
  }
  return value;
}

function renderOperatorStatus(
  state: OperatorState,
  transactions: TransactionStatusSummary
): string {
  return [
    "Workflow State: " + state.workflow_state,
    "Active Intent: " + (state.active_intent_id ?? "none"),
    "Active Deployment: " + (state.active_deployment_id ?? "none"),
    "Active Task: " + (state.active_task_id ?? "none"),
    "",
    "Readiness:",
    ...renderReadiness(state.readiness),
    "",
    "Blockers:",
    ...renderConditions(state.blockers),
    "",
    "Stale Conditions:",
    ...renderConditions(state.stale_conditions),
    "",
    "Risky Conditions:",
    ...renderConditions(state.risky_conditions),
    "",
    "Transactions:",
    ...renderTransactions(transactions),
    "",
    "Next: " + state.recommended_next_command,
    "Reason: " + state.recommended_next_reason
  ].join("\n");
}

function renderTransactions(summary: TransactionStatusSummary): string[] {
  const counts = summary.counts;
  const lines = [
    "- Counts: Planned=" +
      counts.Planned +
      " Committed=" +
      counts.Committed +
      " Failed=" +
      counts.Failed +
      " Aborted=" +
      counts.Aborted
  ];
  if (summary.recent_non_committed.length === 0) {
    lines.push("- Recent non-Committed: none");
    return lines;
  }
  lines.push("- Recent non-Committed:");
  for (const tx of summary.recent_non_committed) {
    const reason = tx.failure_reason ? ": " + tx.failure_reason : "";
    lines.push(
      "  - " +
        tx.transaction_id +
        " [" +
        tx.status +
        "] " +
        tx.action_kind +
        " " +
        tx.task_id +
        "/" +
        tx.agent_id +
        reason
    );
  }
  return lines;
}

function renderReadiness(readiness: OperatorReadiness): string[] {
  return [
    "workspace_initialized",
    "state_valid",
    "has_active_intent",
    "has_active_deployment",
    "plan_check_current",
    "plan_check_passed",
    "approval_present",
    "execution_ready",
    "verification_complete",
    "score_current",
    "retrospective_present",
    "performance_current"
  ].map((key) => "- " + key + ": " + (readiness[key as keyof OperatorReadiness] ? "yes" : "no"));
}

function renderConditions(conditions: OperatorCondition[]): string[] {
  if (conditions.length === 0) return ["- none"];
  return conditions.map((condition) => {
    const target = condition.target ? " " + condition.target : "";
    return "- " + condition.code + " [" + condition.severity + "]" + target + ": " + condition.message;
  });
}
