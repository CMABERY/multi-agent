import { Command } from "commander";
import { recordApproval } from "./approvals.js";
import { postureExitCode, runBootstrap } from "./bootstrap.js";
import { computeConsensus } from "./consensus.js";
import { runContextCheck } from "./contextCheck.js";
import { createIntent, orchestrateIntent } from "./orchestrator.js";
import { updateAgentPerformance } from "./performance.js";
import { runPlanCheck } from "./planCheck.js";
import { generateReport } from "./report.js";
import { migrateLegacyReviews, recordReview } from "./reviews.js";
import { runRetrospective } from "./retrospective.js";
import { runDeployment } from "./runner.js";
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
  });

  const intent = program.command("intent").description("Manage user intents");
  intent
    .command("create")
    .requiredOption("--text <text>", "User task or intent")
    .option("--constraint <constraint...>", "Constraint to add")
    .option("--risk <risk>", "Risk level: low, medium, high", "medium")
    .option("--budget <budget>", "Budget description")
    .action(async (options: { text: string; constraint?: string[]; risk: "low" | "medium" | "high"; budget?: string }) => {
      const created = await createIntent(root, {
        text: options.text,
        constraints: options.constraint ?? [],
        riskLevel: options.risk,
        budget: options.budget
      });
      console.log(created.intent_id);
    });

  program
    .command("orchestrate")
    .requiredOption("--intent <intentId>", "Intent id such as I-001")
    .description("Ask the orchestrator agent to create a contract, task graph, and deployment plan")
    .action(async (options: { intent: string }) => {
      const result = await orchestrateIntent(root, { intentId: options.intent });
      console.log("Created deployment " + (result.deployment_id) + " with tasks " + (result.task_ids.join(", ")) + ".");
    });

  const approval = program.command("approval").description("Record human approval decisions");
  approval
    .command("record")
    .requiredOption("--deployment <deploymentId>", "Deployment id such as DP-001")
    .requiredOption("--approver <name>", "Approver name")
    .requiredOption("--scope <scope>", "Exact approved or rejected scope")
    .option("--decision <decision>", "approved or rejected", "approved")
    .action(
      async (options: {
        deployment: string;
        approver: string;
        scope: string;
        decision: "approved" | "rejected";
      }) => {
        const approvalRecord = await recordApproval(root, {
          deploymentId: options.deployment,
          approver: options.approver,
          decision: options.decision,
          scope: options.scope
        });
        console.log(approvalRecord.approval_id);
      }
    );

  const review = program.command("review").description("Record independent task reviews");
  review
    .command("record")
    .requiredOption("--task <taskId>", "Task id such as T-001")
    .requiredOption("--reviewer <reviewer>", "Reviewer id or name")
    .option("--status <status>", "pass or fail", "pass")
    .option("--issue <issue...>", "Issue text to record for fail reviews")
    .action(
      async (options: {
        task: string;
        reviewer: string;
        status: "pass" | "fail";
        issue?: string[];
      }) => {
        const issues = (options.issue ?? []).map((issue, index) => ({
          issue_id: "I-" + (String(index + 1).padStart(3, "0")),
          severity: "medium" as const,
          category: "manual_review",
          description: issue,
          evidence: issue,
          recommended_fix: "Address the recorded review issue and recheck."
        }));
        const reviewRecord = await recordReview(root, {
          taskId: options.task,
          reviewer: options.reviewer,
          status: options.status,
          issues,
          malformed: true,
          freeFormAssessment: "Manual legacy-style CLI review; not load-bearing without structured criteria."
        });
        console.log(reviewRecord.review_id);
      }
    );

  const consensus = program.command("consensus").description("Compute multi-reviewer consensus");
  consensus
    .command("compute")
    .requiredOption("--task <taskId>", "Task id such as T-001")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { task: string; json?: boolean }) => {
      const record = await computeConsensus(root, { taskId: options.task });
      if (options.json) {
        console.log(JSON.stringify(record, null, 2));
        return;
      }
      console.log("Consensus " + (record.consensus_id) + ": " + (record.overall_verdict));
    });

  program
    .command("migrate")
    .description("Migrate legacy pre-v0.3 review records to structured abstentions")
    .action(async () => {
      const result = await migrateLegacyReviews(root);
      console.log("Migrated " + (result.migratedCount) + " legacy reviews.");
    });

  program
    .command("run")
    .requiredOption("--deployment <deploymentId>", "Deployment id such as DP-001")
    .option("--execute", "Allow approved local-command adapters to execute")
    .option("--rerun", "Explicitly rerun a completed or failed deployment")
    .description("Run an approved deployment plan")
    .action(async (options: { deployment: string; execute?: boolean; rerun?: boolean }) => {
      const result = await runDeployment(root, {
        deploymentId: options.deployment,
        execute: Boolean(options.execute),
        rerun: Boolean(options.rerun)
      });
      console.log("Completed: " + (result.completed.join(", ") || "none"));
      if (result.failed.length > 0) console.log("Failed: " + (result.failed.join(", ")));
      if (result.failed.length > 0) process.exitCode = 1;
    });

  program.command("validate").description("Validate workflow state consistency").action(async () => {
    const result = await validateWorkspace(root);
    if (result.valid) {
      console.log("Workflow state is valid.");
      return;
    }
    for (const issue of result.issues) {
      console.error("" + (issue.code) + ": " + (issue.message));
    }
    process.exitCode = 1;
  });

  program
    .command("score")
    .requiredOption("--deployment <deploymentId>", "Deployment id such as DP-001")
    .option("--json", "Print machine-readable JSON")
    .description("Compute workflow intelligence yield for a deployment")
    .action(async (options: { deployment: string; json?: boolean }) => {
      const score = await writeWorkflowScore(root, { deploymentId: options.deployment });
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
    });

  program
    .command("plan-check")
    .requiredOption("--deployment <deploymentId>", "Deployment id such as DP-001")
    .option("--json", "Print machine-readable JSON")
    .description("Check a deployment plan before approval or execution")
    .action(async (options: { deployment: string; json?: boolean }) => {
      const check = await runPlanCheck(root, { deploymentId: options.deployment });
      if (options.json) {
        console.log(JSON.stringify(check, null, 2));
      } else {
        console.log("Plan Check " + (check.check_id) + ": " + (check.status));
        for (const issue of check.issues) {
          console.log("" + (issue.severity.toUpperCase()) + " " + (issue.code) + " " + (issue.target) + ": " + (issue.message));
          console.log("Fix: " + (issue.recommended_fix));
        }
      }
      if (check.issues.some((issue) => issue.severity === "high")) process.exitCode = 1;
    });

  program
    .command("context-check")
    .requiredOption("--task <taskId>", "Task id such as T-007")
    .option("--json", "Print machine-readable JSON")
    .description("Check whether a task has sufficient scoped context")
    .action(async (options: { task: string; json?: boolean }) => {
      const check = await runContextCheck(root, { taskId: options.task });
      if (options.json) {
        console.log(JSON.stringify(check, null, 2));
      } else {
        console.log("Context Check " + (check.check_id) + ": " + (check.status));
        for (const issue of check.issues) {
          console.log("" + (issue.severity.toUpperCase()) + " " + (issue.code) + " " + (issue.target) + ": " + (issue.message));
          console.log("Fix: " + (issue.recommended_fix));
        }
      }
      if (check.issues.some((issue) => issue.severity === "high")) process.exitCode = 1;
    });

  program
    .command("retrospective")
    .requiredOption("--deployment <deploymentId>", "Deployment id such as DP-001")
    .option("--json", "Print machine-readable JSON")
    .description("Generate a deterministic retrospective and update learning memory")
    .action(async (options: { deployment: string; json?: boolean }) => {
      const retrospective = await runRetrospective(root, { deploymentId: options.deployment });
      if (options.json) {
        console.log(JSON.stringify(retrospective, null, 2));
        return;
      }
      console.log("Retrospective " + (retrospective.retrospective_id));
      console.log("Path: " + (retrospective.path));
      console.log("Learned Rules: " + (retrospective.learned_rule_ids.join(", ") || "none"));
    });

  const performance = program.command("performance").description("Manage agent performance memory");
  performance
    .command("update")
    .requiredOption("--deployment <deploymentId>", "Deployment id such as DP-001")
    .option("--json", "Print machine-readable JSON")
    .description("Update agent/executor performance stats from a deployment")
    .action(async (options: { deployment: string; json?: boolean }) => {
      const agents = await updateAgentPerformance(root, { deploymentId: options.deployment });
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
      }
      process.exitCode = postureExitCode(result.packet.posture);
    });

  return program;
}
