import type { ModelClient } from "./openai.js";
import { createIntent, orchestrateIntent } from "./orchestrator.js";
import { runPlanCheck } from "./planCheck.js";
import type { IntelligenceIssue } from "./schemas.js";

export type AutoPlanStepName = "intent_create" | "orchestrate" | "plan_check";

export interface AutoPlanStep {
  step: AutoPlanStepName;
  outcome: "success" | "failure";
}

export interface AutoPlanInput {
  text: string;
  constraints?: string[];
  riskLevel?: string;
  budget?: string;
}

export interface AutoPlanResult {
  intent_id: string;
  deployment_id: string;
  task_ids: string[];
  plan_check_id: string;
  plan_check_status: "pass" | "fail";
  plan_check_high_severity: boolean;
  plan_check_issues: IntelligenceIssue[];
  steps: AutoPlanStep[];
}

export async function runAutoPlan(
  root: string,
  input: AutoPlanInput,
  options: { modelClient?: ModelClient } = {}
): Promise<AutoPlanResult> {
  const steps: AutoPlanStep[] = [];

  const intent = await createIntent(root, {
    text: input.text,
    constraints: input.constraints ?? [],
    riskLevel: input.riskLevel ?? "medium",
    budget: input.budget
  });
  steps.push({ step: "intent_create", outcome: "success" });

  const orchestrateResult = await orchestrateIntent(root, {
    intentId: intent.intent_id,
    modelClient: options.modelClient
  });
  steps.push({ step: "orchestrate", outcome: "success" });

  const planCheck = await runPlanCheck(root, { deploymentId: orchestrateResult.deployment_id });
  const highSeverity = planCheck.issues.some((issue) => issue.severity === "high");
  steps.push({ step: "plan_check", outcome: highSeverity ? "failure" : "success" });

  return {
    intent_id: intent.intent_id,
    deployment_id: orchestrateResult.deployment_id,
    task_ids: orchestrateResult.task_ids,
    plan_check_id: planCheck.check_id,
    plan_check_status: planCheck.status,
    plan_check_high_severity: highSeverity,
    plan_check_issues: planCheck.issues,
    steps
  };
}

export function renderAutoPlanResult(result: AutoPlanResult): string {
  const lines: string[] = [
    "Created intent " + result.intent_id + ".",
    "Created deployment " +
      result.deployment_id +
      " with tasks " +
      result.task_ids.join(", ") +
      ".",
    "Plan Check " + result.plan_check_id + ": " + result.plan_check_status
  ];
  for (const issue of result.plan_check_issues) {
    lines.push(
      "" +
        issue.severity.toUpperCase() +
        " " +
        issue.code +
        " " +
        issue.target +
        ": " +
        issue.message
    );
    lines.push("Fix: " + issue.recommended_fix);
  }
  return lines.join("\n");
}
