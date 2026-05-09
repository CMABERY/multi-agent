import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runAutoPlan, renderAutoPlanResult } from "../src/autoPlan.js";
import { loadJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-autoplan-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function modelResponse(text: string) {
  return { text, truncated: false };
}

function validOrchestratorPayload(overrides: Record<string, unknown> = {}) {
  return {
    prompt_contract_markdown:
      "# Prompt Contract\n\nGoal: Build a working demo.\n\nAcceptance Criteria:\n- Produce a verified output.\n",
    tasks: [
      {
        title: "Draft implementation artifact",
        owner_agent_id: "researcher_1",
        owner_role: "Research Agent",
        executor: "model_agent",
        model_tier: "mid",
        input_context: ["state/prompt_contract.md"],
        output_required: "Implementation draft",
        acceptance_criteria: ["Draft addresses the prompt contract"],
        dependencies: [],
        risk_level: "medium",
        review_required: false,
        approval_required: false
      }
    ],
    deployment_plan: {
      approval_required: true,
      assignments: [
        {
          task_id: "T-001",
          agent_id: "researcher_1",
          executor: "model_agent",
          model_tier: "mid",
          reason: "Use local registered agents to draft the deliverable.",
          approval_required: true
        }
      ]
    },
    decisions: [
      {
        decision: "Use local registered agents",
        rationale: "Keeps work auditable.",
        owner: "orchestrator"
      }
    ],
    ...overrides
  };
}

describe("runAutoPlan", () => {
  test("chains intent create, orchestrate, and plan-check on the happy path", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      const result = await runAutoPlan(
        root,
        { text: "Build a verified demo artifact." },
        { modelClient }
      );

      expect(result.intent_id).toBe("I-001");
      expect(result.deployment_id).toBe("DP-001");
      expect(result.task_ids).toEqual(["T-001"]);
      expect(result.plan_check_id).toBe("PC-001");
      expect(result.plan_check_status).toBe("pass");
      expect(result.plan_check_high_severity).toBe(false);
      expect(result.steps.map((s) => s.step)).toEqual([
        "intent_create",
        "orchestrate",
        "plan_check"
      ]);
      expect(result.steps.every((s) => s.outcome === "success")).toBe(true);

      const intents = await loadJson(root, "state/intent_queue.json");
      expect(intents.intents[0].status).toBe("planned");
      const plans = await loadJson(root, "state/deployment_plan.json");
      expect(plans.deployment_plans[0].status).toBe("proposed");
      const planChecks = await loadJson(root, "state/plan_checks.json");
      expect(planChecks.plan_checks).toHaveLength(1);
      expect(planChecks.plan_checks[0].status).toBe("pass");
    });
  });

  test("stops before approval and execution", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      await runAutoPlan(root, { text: "Build a verified demo artifact." }, { modelClient });

      const approvals = await loadJson(root, "state/approvals.json");
      expect(approvals.approvals).toEqual([]);
      const tasks = await loadJson(root, "state/task_board.json");
      expect(tasks.tasks.every((t: { status: string }) => t.status === "queued")).toBe(true);
      const scores = await loadJson(root, "state/workflow_score.json");
      expect(scores.workflow_scores).toEqual([]);
    });
  });

  test("propagates orchestrate failure with intent already created", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const modelClient = {
        createResponse: vi.fn().mockRejectedValue(new Error("simulated quota error"))
      };

      await expect(
        runAutoPlan(root, { text: "Build a verified demo artifact." }, { modelClient })
      ).rejects.toThrow(/simulated quota error/);

      const intents = await loadJson(root, "state/intent_queue.json");
      expect(intents.intents).toHaveLength(1);
      expect(intents.intents[0].intent_id).toBe("I-001");
      expect(intents.intents[0].status).toBe("new");
      const plans = await loadJson(root, "state/deployment_plan.json");
      expect(plans.deployment_plans).toEqual([]);
    });
  });

  test("passes risk, constraints, and budget through to intent create", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValue(modelResponse(JSON.stringify(validOrchestratorPayload())))
      };

      await runAutoPlan(
        root,
        {
          text: "High-risk research item.",
          riskLevel: "high",
          constraints: ["Cite all sources.", "No external actions."],
          budget: "Keep cost under 1 USD."
        },
        { modelClient }
      );

      const intents = await loadJson(root, "state/intent_queue.json");
      expect(intents.intents[0].risk_level).toBe("high");
      expect(intents.intents[0].constraints).toEqual([
        "Cite all sources.",
        "No external actions."
      ]);
      expect(intents.intents[0].budget).toBe("Keep cost under 1 USD.");
    });
  });

  test("renderAutoPlanResult prints intent, deployment, task, and plan-check lines", async () => {
    const rendered = renderAutoPlanResult({
      intent_id: "I-001",
      deployment_id: "DP-001",
      task_ids: ["T-001", "T-002"],
      plan_check_id: "PC-001",
      plan_check_status: "pass",
      plan_check_high_severity: false,
      plan_check_issues: [],
      steps: [
        { step: "intent_create", outcome: "success" },
        { step: "orchestrate", outcome: "success" },
        { step: "plan_check", outcome: "success" }
      ]
    });

    expect(rendered).toContain("Created intent I-001.");
    expect(rendered).toContain("Created deployment DP-001 with tasks T-001, T-002.");
    expect(rendered).toContain("Plan Check PC-001: pass");
  });

  test("renderAutoPlanResult includes plan-check issues when present", async () => {
    const rendered = renderAutoPlanResult({
      intent_id: "I-001",
      deployment_id: "DP-001",
      task_ids: ["T-001"],
      plan_check_id: "PC-001",
      plan_check_status: "fail",
      plan_check_high_severity: true,
      plan_check_issues: [
        {
          issue_id: "ISSUE-001",
          severity: "high",
          code: "DRY_RUN_DELIVERABLE",
          target: "T-001",
          message: "Task is routed to dry_run but expects a deliverable.",
          recommended_fix: "Route the task to model_agent.",
          created_at: "2026-05-09T00:00:00.000Z"
        }
      ],
      steps: [
        { step: "intent_create", outcome: "success" },
        { step: "orchestrate", outcome: "success" },
        { step: "plan_check", outcome: "failure" }
      ]
    });

    expect(rendered).toContain("Plan Check PC-001: fail");
    expect(rendered).toContain("HIGH DRY_RUN_DELIVERABLE T-001:");
    expect(rendered).toContain("Fix: Route the task to model_agent.");
  });
});
