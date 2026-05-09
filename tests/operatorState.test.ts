import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createIntent } from "../src/orchestrator.js";
import { readOperatorState } from "../src/operatorState.js";
import { saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-operator-state-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const initialTime = "2026-05-08T00:00:00.000Z";
const currentTime = "2026-05-08T00:10:00.000Z";

function intent(overrides: Record<string, unknown> = {}) {
  return {
    intent_id: "I-001",
    text: "Build a verified artifact.",
    constraints: [],
    risk_level: "medium",
    status: "planned",
    created_at: initialTime,
    updated_at: currentTime,
    ...overrides
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "T-001",
    title: "Produce deliverable",
    owner_agent_id: "researcher_1",
    owner_role: "Research Agent",
    executor: "model_agent",
    model_tier: "mid",
    input_context: ["state/prompt_contract.md"],
    output_required: "A complete deliverable",
    acceptance_criteria: ["Specific, measurable criterion"],
    dependencies: [],
    risk_level: "medium",
    review_required: false,
    approval_required: false,
    status: "queued",
    artifacts: [],
    deployment_id: "DP-001",
    created_at: initialTime,
    updated_at: currentTime,
    ...overrides
  };
}

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "T-001",
    agent_id: "researcher_1",
    executor: "model_agent",
    model_tier: "mid",
    reason: "Produce the deliverable.",
    approval_required: false,
    ...overrides
  };
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    deployment_id: "DP-001",
    intent_id: "I-001",
    status: "proposed",
    approval_required: true,
    assignments: [assignment()],
    created_at: initialTime,
    updated_at: currentTime,
    ...overrides
  };
}

async function seedDeployment(
  root: string,
  input: {
    plan?: Record<string, unknown>;
    tasks?: Array<Record<string, unknown>>;
    assignments?: Array<Record<string, unknown>>;
  } = {}
): Promise<void> {
  const assignments = input.assignments?.map((entry) => assignment(entry)) ?? [assignment()];
  await saveJson(root, "state/intent_queue.json", { intents: [intent()] });
  await saveJson(root, "state/task_board.json", {
    tasks: (input.tasks ?? [{}]).map((entry) => task(entry))
  });
  await saveJson(root, "state/deployment_plan.json", {
    deployment_plans: [
      deployment({
        assignments,
        ...input.plan
      })
    ]
  });
}

async function seedPassingPlanCheck(root: string): Promise<void> {
  await saveJson(root, "state/plan_checks.json", {
    plan_checks: [
      {
        check_id: "PC-001",
        deployment_id: "DP-001",
        status: "pass",
        issues: [],
        created_at: currentTime,
        updated_at: currentTime
      }
    ]
  });
}

async function seedApproval(root: string): Promise<void> {
  await saveJson(root, "state/approvals.json", {
    approvals: [
      {
        approval_id: "AP-001",
        deployment_id: "DP-001",
        approver: "operator",
        decision: "approved",
        scope: "Run DP-001 after plan-check review.",
        created_at: currentTime
      }
    ]
  });
}

async function seedPassingConsensus(root: string): Promise<void> {
  await saveJson(root, "state/consensus.json", {
    consensus_records: [
      {
        consensus_id: "C-001",
        task_id: "T-001",
        review_ids: ["R-001"],
        reviewer_count: 1,
        per_criterion: [
          {
            criterion: "Specific, measurable criterion",
            pass_count: 1,
            fail_count: 0,
            unverifiable_count: 0,
            abstain_count: 0,
            verdict: "pass",
            convergent_citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 1 }],
            dissent: []
          }
        ],
        overall_verdict: "pass",
        is_load_bearing: true,
        created_at: currentTime,
        updated_at: currentTime
      }
    ]
  });
}

async function seedReview(root: string): Promise<void> {
  await saveJson(root, "state/review_log.json", {
    reviews: [
      {
        review_id: "R-001",
        task_id: "T-001",
        reviewer_agent_id: "reviewer_skeptical",
        reviewer_persona: "skeptical",
        status: "pass",
        per_criterion: [
          {
            criterion: "Specific, measurable criterion",
            verdict: "pass",
            citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 1 }],
            rationale: "The criterion is satisfied.",
            confidence: 0.9
          }
        ],
        identified_issues: [],
        free_form_assessment: "",
        malformed: false,
        truncated: false,
        created_at: currentTime
      }
    ]
  });
}

async function seedScore(root: string): Promise<void> {
  await saveJson(root, "state/workflow_score.json", {
    workflow_scores: [
      {
        score_id: "WS-001",
        deployment_id: "DP-001",
        verified_useful_outputs: 1,
        consensus_pass_count: 1,
        consensus_split_count: 0,
        consensus_insufficient_count: 0,
        review_pass_rate: 1,
        failed_tasks: 0,
        rerun_count: 0,
        human_interventions: 1,
        context_failures: 0,
        model_calls: 1,
        dry_runs: 0,
        workflow_intelligence_yield: 0.5,
        created_at: currentTime,
        updated_at: currentTime
      }
    ]
  });
}

async function seedRetrospective(root: string): Promise<void> {
  await saveJson(root, "state/retrospective_index.json", {
    retrospectives: [
      {
        retrospective_id: "RET-001",
        deployment_id: "DP-001",
        path: "state/retrospectives/RET-001.md",
        created_at: currentTime,
        updated_at: currentTime
      }
    ]
  });
}

async function seedPerformance(root: string): Promise<void> {
  await saveJson(root, "state/performance_ledger.json", {
    entries: [
      {
        deployment_id: "DP-001",
        agent_id: "researcher_1",
        tasks_assigned: 1,
        tasks_completed: 1,
        tasks_failed: 0,
        review_passes: 1,
        review_failures: 0,
        dry_run_deliverable_mismatches: 0,
        known_failure_modes: [],
        updated_at: currentTime
      }
    ]
  });
}

describe("operator state interpreter", () => {
  test("uninitialized workspace recommends init without creating files", async () => {
    await withWorkspace(async (root) => {
      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("uninitialized");
      expect(state.recommended_next_command).toBe("maw init");
      expect(await readdir(root)).toEqual([]);
    });
  });

  test("idle initialized workspace recommends creating an intent", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("idle");
      expect(state.recommended_next_command).toMatch(/^maw intent create/);
    });
  });

  test("malformed state returns state invalid without repair", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await writeFile(join(root, "state/intent_queue.json"), "{", "utf8");

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("state_invalid");
      expect(state.recommended_next_command).toBe("maw doctor");
      expect(state.blockers.map((blocker) => blocker.code)).toContain("STATE_FILE_INVALID");
    });
  });

  test("new intent requires orchestration", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await createIntent(root, { text: "Build a verified artifact." });

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("planning_needed");
      expect(state.active_intent_id).toBe("I-001");
      expect(state.recommended_next_command).toBe("maw orchestrate --intent I-001");
    });
  });

  test("proposed deployment without plan check requires approval precheck", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("approval_precheck_needed");
      expect(state.active_deployment_id).toBe("DP-001");
      expect(state.recommended_next_command).toBe("maw plan-check --deployment DP-001");
      expect(state.stale_conditions.map((condition) => condition.code)).toContain("PLAN_CHECK_MISSING");
    });
  });

  test("passing current plan check requires approval", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await seedPassingPlanCheck(root);

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("approval_needed");
      expect(state.recommended_next_command).toMatch(/^maw approval record --deployment DP-001/);
    });
  });

  test("approved deployment is execution ready", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, { plan: { status: "approved", approved_at: currentTime } });
      await seedApproval(root);

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("execution_ready");
      expect(state.recommended_next_command).toBe("maw run --deployment DP-001");
    });
  });

  test("approved local-command deployment recommends execute flag", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "approved", approved_at: currentTime },
        assignments: [{ executor: "local_command" }],
        tasks: [{ executor: "local_command" }]
      });
      await seedApproval(root);

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("execution_ready");
      expect(state.recommended_next_command).toBe("maw run --deployment DP-001 --execute");
    });
  });

  test("failed tasks and action-required chat surface blockers", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "failed" },
        tasks: [{ status: "failed", blocker: "quota exhausted" }]
      });
      await saveJson(root, "state/chat.json", {
        messages: [
          {
            message_id: "M-001",
            timestamp: currentTime,
            from_agent: "runner",
            to: "orchestrator",
            type: "blocker",
            task_id: "T-001",
            summary: "quota exhausted",
            details: "quota exhausted",
            requires_action: true,
            recommended_next_step: "Fix quota and rerun."
          }
        ]
      });

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("failed");
      expect(state.active_task_id).toBe("T-001");
      expect(state.blockers.map((blocker) => blocker.code)).toEqual(
        expect.arrayContaining(["TASK_FAILED", "CHAT_REQUIRES_ACTION"])
      );
      expect(state.recommended_next_command).toBe("maw doctor");
    });
  });

  test("completed review-required task with reviews but without passing consensus requires consensus", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed" },
        tasks: [{ status: "completed", review_required: true }]
      });
      await seedReview(root);

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("verification_needed");
      expect(state.active_task_id).toBe("T-001");
      expect(state.recommended_next_command).toBe("maw consensus compute --task T-001");
    });
  });

  test("completed review-required task without reviews requires rerun", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed" },
        tasks: [{ status: "completed", review_required: true }]
      });

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("verification_needed");
      expect(state.active_task_id).toBe("T-001");
      expect(state.recommended_next_command).toBe("maw run --deployment DP-001 --rerun");
    });
  });

  test("completed deployment without score requires scoring", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed" },
        tasks: [{ status: "completed", review_required: false }]
      });

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("scoring_needed");
      expect(state.recommended_next_command).toBe("maw score --deployment DP-001");
    });
  });

  test("score without retrospective requires retrospective", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed" },
        tasks: [{ status: "completed", review_required: true }]
      });
      await seedPassingConsensus(root);
      await seedScore(root);

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("retrospective_needed");
      expect(state.recommended_next_command).toBe("maw retrospective --deployment DP-001");
    });
  });

  test("retrospective without performance ledger requires performance update", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed" },
        tasks: [{ status: "completed", review_required: true }]
      });
      await seedPassingConsensus(root);
      await seedScore(root);
      await seedRetrospective(root);

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("performance_update_needed");
      expect(state.recommended_next_command).toBe("maw performance update --deployment DP-001");
    });
  });

  test("complete workflow recommends report", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root, {
        plan: { status: "completed" },
        tasks: [{ status: "completed", review_required: true }]
      });
      await seedPassingConsensus(root);
      await seedScore(root);
      await seedRetrospective(root);
      await seedPerformance(root);

      const state = await readOperatorState(root);

      expect(state.workflow_state).toBe("complete");
      expect(state.recommended_next_command).toBe("maw report");
    });
  });
});
