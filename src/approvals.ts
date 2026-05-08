import {
  ApprovalStoreSchema,
  DeploymentPlanStoreSchema,
  type Approval,
  type DeploymentPlan
} from "./schemas.js";
import { nextId } from "./ids.js";
import { loadJson, nowIso, saveJson } from "./storage.js";

export async function recordApproval(
  root: string,
  input: {
    deploymentId: string;
    approver: string;
    decision: "approved" | "rejected";
    scope: string;
  }
): Promise<Approval> {
  const approvals = ApprovalStoreSchema.parse(await loadJson(root, "state/approvals.json"));
  const plans = DeploymentPlanStoreSchema.parse(await loadJson(root, "state/deployment_plan.json"));
  const plan = plans.deployment_plans.find((entry) => entry.deployment_id === input.deploymentId);
  if (!plan) throw new Error(`Deployment not found: ${input.deploymentId}`);

  const now = nowIso();
  const approval: Approval = {
    approval_id: nextId(
      "AP",
      approvals.approvals.map((entry) => entry.approval_id)
    ),
    deployment_id: input.deploymentId,
    approver: input.approver,
    decision: input.decision,
    scope: input.scope,
    created_at: now
  };
  approvals.approvals.push(approval);

  plan.status = input.decision === "approved" ? "approved" : "blocked";
  plan.approved_at = input.decision === "approved" ? now : undefined;
  plan.updated_at = now;

  await saveJson(root, "state/approvals.json", approvals);
  await saveJson(root, "state/deployment_plan.json", plans);
  return approval;
}

export async function hasApprovedDeployment(root: string, plan: DeploymentPlan): Promise<boolean> {
  if (!plan.approval_required && plan.status === "approved") return true;
  const approvals = ApprovalStoreSchema.parse(await loadJson(root, "state/approvals.json"));
  return approvals.approvals.some(
    (approval) => approval.deployment_id === plan.deployment_id && approval.decision === "approved"
  );
}
