import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { addArtifact } from "../src/artifacts.js";
import { runContextCheck } from "../src/contextCheck.js";
import { updateAgentPerformance } from "../src/performance.js";
import { collectPlanIssues, runPlanCheck } from "../src/planCheck.js";
import { runRetrospective } from "../src/retrospective.js";
import { writeWorkflowScore } from "../src/scoring.js";
import { AgentRegistrySchema, TaskSchema } from "../src/schemas.js";
import { loadJson, saveJson, saveText } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-intel-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function baseTask(overrides: Record<string, unknown>) {
  return {
    task_id: "T-001",
    title: "Produce deliverable",
    owner_agent_id: "builder_1",
    owner_role: "Builder Agent",
    executor: "model_agent",
    model_tier: "mid",
    input_context: ["state/prompt_contract.md"],
    output_required: "A complete deliverable",
    acceptance_criteria: ["Specific, measurable criterion"],
    dependencies: [],
    risk_level: "medium",
    review_required: true,
    approval_required: false,
    status: "completed",
    artifacts: [],
    deployment_id: "DP-001",
    created_at: "2026-05-08T00:00:00.000Z",
    updated_at: "2026-05-08T00:00:00.000Z",
    ...overrides
  };
}

function performanceAgent(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: "builder_1",
    role: "Builder Agent",
    executor_type: "model_agent",
    model_tier: "mid",
    allowed_tools: [],
    command_allowlist: [],
    permissions: {
      external_actions: false,
      destructive_actions: false,
      credential_access: false,
      paid_actions: false,
      public_actions: false
    },
    max_cost_usd: 1,
    ...overrides
  };
}

function performanceRegistry(agentOverrides: Record<string, unknown> = {}) {
  const reviewerBase = {
    role: "Reviewer Agent",
    executor_type: "model_agent",
    model_tier: "high",
    allowed_tools: [],
    command_allowlist: [],
    permissions: {
      external_actions: false,
      destructive_actions: false,
      credential_access: false,
      paid_actions: false,
      public_actions: false
    },
    max_cost_usd: 1
  };
  return {
    agents: [
      performanceAgent(agentOverrides),
      { ...reviewerBase, agent_id: "reviewer_skeptical", reviewer_persona: "skeptical" },
      { ...reviewerBase, agent_id: "reviewer_completeness", reviewer_persona: "completeness" },
      { ...reviewerBase, agent_id: "reviewer_rigor", reviewer_persona: "rigor" }
    ]
  };
}

function performancePlanIssueCodes(
  taskOverrides: Record<string, unknown>,
  agentOverrides: Record<string, unknown>,
  config?: Parameters<typeof collectPlanIssues>[0]["config"]
) {
  const issues = collectPlanIssues({
    plan: {
      deployment_id: "DP-001",
      intent_id: "I-001",
      status: "proposed",
      approval_required: true,
      assignments: [
        {
          task_id: "T-001",
          agent_id: "builder_1",
          executor: "model_agent",
          model_tier: "mid",
          reason: "Route based on performance.",
          approval_required: false
        }
      ],
      created_at: "2026-05-08T00:00:00.000Z",
      updated_at: "2026-05-08T00:00:00.000Z"
    },
    tasks: [TaskSchema.parse(baseTask({ task_id: "T-001", status: "queued", ...taskOverrides }))],
    registry: AgentRegistrySchema.parse(performanceRegistry(agentOverrides)),
    artifactIndex: { artifacts: [] },
    config
  });
  return issues.map((issue) => issue.code);
}

async function seedConsensus(root: string, records: Array<Record<string, unknown>>): Promise<void> {
  await saveJson(root, "state/consensus.json", {
    consensus_records: records.map((record, index) => ({
      consensus_id: `C-${String(index + 1).padStart(3, "0")}`,
      task_id: `T-${String(index + 1).padStart(3, "0")}`,
      review_ids: [`R-${String(index + 1).padStart(3, "0")}`],
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
      created_at: "2026-05-08T00:00:00.000Z",
      ...record
    }))
  });
}

async function seedDeployment(root: string): Promise<void> {
  await saveJson(root, "state/deployment_plan.json", {
    deployment_plans: [
      {
        deployment_id: "DP-001",
        intent_id: "I-001",
        status: "completed",
        approval_required: true,
        approved_at: "2026-05-08T00:00:00.000Z",
        assignments: [
          {
            task_id: "T-001",
            agent_id: "builder_1",
            executor: "model_agent",
            model_tier: "mid",
            reason: "Produce deliverable.",
            approval_required: false
          },
          {
            task_id: "T-002",
            agent_id: "builder_1",
            executor: "dry_run",
            model_tier: "mid",
            reason: "Incorrectly routed deliverable to dry run.",
            approval_required: false
          },
          {
            task_id: "T-003",
            agent_id: "reviewer_skeptical",
            executor: "model_agent",
            model_tier: "high",
            reason: "Review all outputs.",
            approval_required: false
          }
        ],
        created_at: "2026-05-08T00:00:00.000Z",
        updated_at: "2026-05-08T00:00:00.000Z"
      }
    ]
  });
}

describe("workflow intelligence layer", () => {
  test("score counts unique verified outputs and penalizes rework, failures, context issues, and interventions", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({ task_id: "T-001", artifacts: ["ART-001"] }),
          baseTask({
            task_id: "T-002",
            executor: "dry_run",
            artifacts: ["ART-002"],
            status: "completed"
          }),
          baseTask({
            task_id: "T-003",
            owner_agent_id: "reviewer_skeptical",
            owner_role: "Reviewer Agent",
            status: "failed",
            blocker: "quota exhausted"
          })
        ]
      });
      await saveJson(root, "state/review_log.json", {
        reviews: [
          {
            review_id: "R-001",
            task_id: "T-001",
            reviewer_agent_id: "reviewer_skeptical",
            reviewer_persona: "default",
            status: "pass",
            issues: [],
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            review_id: "R-002",
            task_id: "T-001",
            reviewer_agent_id: "reviewer_skeptical",
            reviewer_persona: "default",
            status: "pass",
            issues: [],
            created_at: "2026-05-08T00:00:01.000Z"
          },
          {
            review_id: "R-003",
            task_id: "T-002",
            reviewer_agent_id: "reviewer_skeptical",
            reviewer_persona: "default",
            status: "fail",
            issues: [
              {
                issue_id: "I-001",
                severity: "high",
                category: "completeness",
                description: "Dry run produced only a delegation packet.",
                evidence: "No response output artifact.",
                recommended_fix: "Use model_agent for deliverable tasks."
              }
            ],
            created_at: "2026-05-08T00:00:02.000Z"
          }
        ]
      });
      await saveJson(root, "state/consensus.json", {
        consensus_records: [
          {
            consensus_id: "C-001",
            task_id: "T-001",
            review_ids: ["R-001", "R-002"],
            reviewer_count: 2,
            per_criterion: [
              {
                criterion: "Specific, measurable criterion",
                pass_count: 2,
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
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await saveJson(root, "state/metrics.json", {
        model_calls: 4,
        local_commands: 0,
        dry_runs: 2,
        tasks_completed: 5,
        tasks_failed: 1,
        estimated_cost_usd: 0
      });
      await saveJson(root, "state/approvals.json", {
        approvals: [
          {
            approval_id: "AP-001",
            deployment_id: "DP-001",
            approver: "human",
            decision: "approved",
            scope: "Run deployment.",
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await saveJson(root, "state/context_checks.json", {
        context_checks: [
          {
            check_id: "CC-001",
            task_id: "T-003",
            status: "fail",
            issues: [
              {
                issue_id: "CCI-001",
                severity: "high",
                code: "DEPENDENCY_ARTIFACT_MISSING",
                target: "T-002",
                message: "Dependency has no usable output.",
                recommended_fix: "Produce a model output artifact.",
                created_at: "2026-05-08T00:00:00.000Z"
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await saveJson(root, "artifacts/artifact_index.json", {
        artifacts: [
          {
            artifact_id: "ART-001",
            task_id: "T-001",
            path: "artifacts/runs/T-001/response_output.md",
            type: "model_output",
            description: "Initial model output",
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            artifact_id: "ART-002",
            task_id: "T-001",
            path: "artifacts/runs/T-001/response_output_rerun.md",
            type: "model_output",
            description: "Rerun model output",
            created_at: "2026-05-08T00:00:01.000Z"
          },
          {
            artifact_id: "ART-003",
            task_id: "T-002",
            path: "artifacts/runs/T-002/delegation_packet.md",
            type: "delegation_packet",
            description: "Dry-run delegation packet",
            created_at: "2026-05-08T00:00:02.000Z"
          }
        ]
      });

      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(score.score_id).toBe("WS-001");
      expect(score.verified_useful_outputs).toBe(1);
      expect(score.consensus_pass_count).toBe(1);
      expect(score.consensus_split_count).toBe(0);
      expect(score.consensus_insufficient_count).toBe(0);
      expect(score.review_pass_rate).toBeCloseTo(1 / 3);
      expect(score.failed_tasks).toBe(1);
      expect(score.rerun_count).toBe(1);
      expect(score.human_interventions).toBe(1);
      expect(score.context_failures).toBe(1);
      expect(score.workflow_intelligence_yield).toBeCloseTo(1 / 15);
      const store = await loadJson(root, "state/workflow_score.json");
      expect(store.workflow_scores).toHaveLength(1);
    });
  });

  test("score derives rerun count from artifacts rather than global completed metrics", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({ task_id: "T-001", status: "completed" }),
          baseTask({
            task_id: "T-002",
            executor: "dry_run",
            status: "completed"
          }),
          baseTask({
            task_id: "T-003",
            owner_agent_id: "reviewer_skeptical",
            owner_role: "Reviewer Agent",
            status: "completed"
          })
        ]
      });
      await saveJson(root, "state/metrics.json", {
        model_calls: 1,
        local_commands: 0,
        dry_runs: 0,
        tasks_completed: 99,
        tasks_failed: 0,
        estimated_cost_usd: 0
      });
      await saveJson(root, "artifacts/artifact_index.json", {
        artifacts: [
          {
            artifact_id: "ART-001",
            task_id: "T-001",
            path: "artifacts/runs/T-001/response_output.md",
            type: "model_output",
            description: "Single model output",
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            artifact_id: "ART-002",
            task_id: "T-002",
            path: "artifacts/runs/T-002/delegation_packet.md",
            type: "delegation_packet",
            description: "Single dry-run packet",
            created_at: "2026-05-08T00:00:01.000Z"
          },
          {
            artifact_id: "ART-003",
            task_id: "T-003",
            path: "artifacts/runs/T-003/response_output.md",
            type: "model_output",
            description: "Single review output",
            created_at: "2026-05-08T00:00:02.000Z"
          }
        ]
      });

      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(score.rerun_count).toBe(0);
    });
  });

  test("truncated partial does not inflate rerun count when followed by a successful artifact", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({ task_id: "T-001", status: "completed" }),
          baseTask({
            task_id: "T-002",
            executor: "dry_run",
            status: "completed"
          }),
          baseTask({
            task_id: "T-003",
            owner_agent_id: "reviewer_skeptical",
            owner_role: "Reviewer Agent",
            status: "completed"
          })
        ]
      });
      await saveJson(root, "artifacts/artifact_index.json", {
        artifacts: [
          {
            artifact_id: "ART-001",
            task_id: "T-001",
            path: "artifacts/runs/T-001/response_output.md",
            type: "model_output",
            description: "Successful post-truncation rerun",
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });

      const firstScore = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(firstScore.rerun_count).toBe(0);

      await saveJson(root, "artifacts/artifact_index.json", {
        artifacts: [
          {
            artifact_id: "ART-001",
            task_id: "T-001",
            path: "artifacts/runs/T-001/response_output.md",
            type: "model_output",
            description: "Successful post-truncation rerun",
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            artifact_id: "ART-002",
            task_id: "T-001",
            path: "artifacts/runs/T-001/response_output_second.md",
            type: "model_output",
            description: "Second successful run",
            created_at: "2026-05-08T00:00:01.000Z"
          }
        ]
      });

      const secondScore = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(secondScore.rerun_count).toBe(1);
    });
  });

  test("score counts local_command reruns from command_output artifacts", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [
          {
            deployment_id: "DP-001",
            intent_id: "I-001",
            status: "completed",
            approval_required: false,
            assignments: [
              {
                task_id: "T-001",
                agent_id: "builder_1",
                executor: "local_command",
                model_tier: "low",
                reason: "Run a local command.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({
            executor: "local_command",
            model_tier: "low",
            input_context: [],
            output_required: "Command output",
            acceptance_criteria: ["Command exits successfully"],
            review_required: false,
            status: "completed"
          })
        ]
      });
      await saveJson(root, "artifacts/artifact_index.json", {
        artifacts: [
          {
            artifact_id: "ART-001",
            task_id: "T-001",
            path: "artifacts/runs/T-001/command_output.txt",
            type: "command_output",
            description: "Initial command output",
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            artifact_id: "ART-002",
            task_id: "T-001",
            path: "artifacts/runs/T-001/command_output_rerun.txt",
            type: "command_output",
            description: "Rerun command output",
            created_at: "2026-05-08T00:00:01.000Z"
          }
        ]
      });

      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(score.rerun_count).toBe(1);
    });
  });

  test("score counts dry_run reruns from delegation_packet artifacts", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [
          {
            deployment_id: "DP-001",
            intent_id: "I-001",
            status: "completed",
            approval_required: false,
            assignments: [
              {
                task_id: "T-001",
                agent_id: "builder_1",
                executor: "dry_run",
                model_tier: "mid",
                reason: "Emit a delegation packet.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({
            executor: "dry_run",
            model_tier: "mid",
            input_context: [],
            output_required: "Delegation packet",
            acceptance_criteria: ["Packet exists"],
            review_required: false,
            status: "completed"
          })
        ]
      });
      await saveJson(root, "artifacts/artifact_index.json", {
        artifacts: [
          {
            artifact_id: "ART-001",
            task_id: "T-001",
            path: "artifacts/runs/T-001/delegation_packet.md",
            type: "delegation_packet",
            description: "Initial dry-run packet",
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            artifact_id: "ART-002",
            task_id: "T-001",
            path: "artifacts/runs/T-001/delegation_packet_rerun.md",
            type: "delegation_packet",
            description: "Rerun dry-run packet",
            created_at: "2026-05-08T00:00:01.000Z"
          }
        ]
      });

      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(score.rerun_count).toBe(1);
    });
  });

  test("reviewer-derived artifacts do not inflate rerun count", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [
          {
            deployment_id: "DP-001",
            intent_id: "I-001",
            status: "completed",
            approval_required: false,
            assignments: [
              {
                task_id: "T-001",
                agent_id: "researcher_1",
                executor: "model_agent",
                model_tier: "mid",
                reason: "Produce a reviewed model output.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({
            owner_agent_id: "researcher_1",
            executor: "model_agent",
            model_tier: "mid",
            review_required: true,
            status: "completed"
          })
        ]
      });
      await saveJson(root, "artifacts/artifact_index.json", {
        artifacts: [
          {
            artifact_id: "ART-001",
            task_id: "T-001",
            path: "artifacts/runs/T-001/response_output.md",
            type: "model_output",
            description: "Primary model output",
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            artifact_id: "ART-002",
            task_id: "T-001",
            path: "artifacts/runs/T-001/review_skeptical.md",
            type: "review_evidence",
            description: "Skeptical review evidence",
            created_at: "2026-05-08T00:00:01.000Z"
          },
          {
            artifact_id: "ART-003",
            task_id: "T-001",
            path: "artifacts/runs/T-001/review_skeptical.json",
            type: "structured_review",
            description: "Skeptical structured review",
            created_at: "2026-05-08T00:00:02.000Z"
          },
          {
            artifact_id: "ART-004",
            task_id: "T-001",
            path: "artifacts/runs/T-001/review_rigor.md",
            type: "review_evidence",
            description: "Rigor review evidence",
            created_at: "2026-05-08T00:00:03.000Z"
          },
          {
            artifact_id: "ART-005",
            task_id: "T-001",
            path: "artifacts/runs/T-001/review_rigor.json",
            type: "structured_review",
            description: "Rigor structured review",
            created_at: "2026-05-08T00:00:04.000Z"
          }
        ]
      });

      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(score.rerun_count).toBe(0);
    });
  });

  test("plan-check flags high leverage deployment plan defects", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({
            task_id: "T-001",
            risk_level: "high",
            review_required: false,
            acceptance_criteria: ["good"]
          }),
          baseTask({
            task_id: "T-002",
            executor: "dry_run",
            output_required: "A complete implementation playbook",
            artifacts: ["ART-002"]
          }),
          baseTask({
            task_id: "T-003",
            owner_agent_id: "reviewer_skeptical",
            owner_role: "Reviewer Agent",
            dependencies: ["T-002"],
            output_required: "Review report"
          })
        ]
      });

      const result = await runPlanCheck(root, { deploymentId: "DP-001" });

      expect(result.status).toBe("fail");
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "HIGH_RISK_REVIEW_MISSING",
          "DRY_RUN_DELIVERABLE",
          "EXECUTOR_REGISTRY_MISMATCH",
          "REVIEW_DEPENDENCY_ARTIFACT_MISSING"
        ])
      );
      expect(result.issues.some((issue) => issue.severity === "high")).toBe(true);
    });
  });

  test("plan-check is idempotent per deployment and preserves the check id", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({
            task_id: "T-001",
            risk_level: "high",
            review_required: false
          }),
          baseTask({
            task_id: "T-002",
            executor: "dry_run",
            output_required: "A complete implementation playbook"
          })
        ]
      });

      const first = await runPlanCheck(root, { deploymentId: "DP-001" });
      const second = await runPlanCheck(root, { deploymentId: "DP-001" });
      const store = await loadJson(root, "state/plan_checks.json");

      expect(first.check_id).toBe("PC-001");
      expect(second.check_id).toBe("PC-001");
      expect(store.plan_checks).toHaveLength(1);
      expect(store.plan_checks[0].updated_at).toBeDefined();
    });
  });

  test("plan-check flags LOW_REVIEW_PASS_RATE_FOR_RISK for high-risk routing to a low-pass-rate agent", async () => {
    const codes = performancePlanIssueCodes(
      { risk_level: "high", review_required: true },
      {
        performance: {
          tasks_assigned: 10,
          tasks_completed: 10,
          tasks_failed: 0,
          review_passes: 2,
          review_failures: 8,
          dry_run_deliverable_mismatches: 0,
          average_score_contribution: 0.2,
          known_failure_modes: []
        }
      }
    );

    expect(codes).toContain("LOW_REVIEW_PASS_RATE_FOR_RISK");
  });

  test("plan-check does not gate low-review-pass-rate agents without enough assignments", async () => {
    const codes = performancePlanIssueCodes(
      { risk_level: "high", review_required: true },
      {
        performance: {
          tasks_assigned: 2,
          tasks_completed: 2,
          tasks_failed: 0,
          review_passes: 0,
          review_failures: 2,
          dry_run_deliverable_mismatches: 0,
          average_score_contribution: 0,
          known_failure_modes: []
        }
      }
    );

    expect(codes).not.toContain("LOW_REVIEW_PASS_RATE_FOR_RISK");
  });

  test("plan-check flags HIGH_FAILURE_RATE_AGENT for medium-risk routing", async () => {
    const codes = performancePlanIssueCodes(
      { risk_level: "medium", review_required: false },
      {
        performance: {
          tasks_assigned: 4,
          tasks_completed: 1,
          tasks_failed: 3,
          review_passes: 0,
          review_failures: 0,
          dry_run_deliverable_mismatches: 0,
          average_score_contribution: 0,
          known_failure_modes: ["repeated blocker"]
        }
      }
    );

    expect(codes).toContain("HIGH_FAILURE_RATE_AGENT");
  });

  test("plan-check does not flag HIGH_FAILURE_RATE_AGENT for low-risk routing", async () => {
    const codes = performancePlanIssueCodes(
      { risk_level: "low", review_required: false },
      {
        performance: {
          tasks_assigned: 4,
          tasks_completed: 1,
          tasks_failed: 3,
          review_passes: 0,
          review_failures: 0,
          dry_run_deliverable_mismatches: 0,
          average_score_contribution: 0,
          known_failure_modes: ["repeated blocker"]
        }
      }
    );

    expect(codes).not.toContain("HIGH_FAILURE_RATE_AGENT");
  });

  test("plan-check performance gates respect configured thresholds", async () => {
    const codes = performancePlanIssueCodes(
      { risk_level: "high", review_required: true },
      {
        performance: {
          tasks_assigned: 10,
          tasks_completed: 10,
          tasks_failed: 0,
          review_passes: 2,
          review_failures: 8,
          dry_run_deliverable_mismatches: 0,
          average_score_contribution: 0.2,
          known_failure_modes: []
        }
      },
      {
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "OPENAI_API_KEY",
        default_models: {
          orchestrator: "gpt-5.2",
          high: "gpt-5.2",
          mid: "gpt-5-mini",
          low: "gpt-5-nano"
        },
        max_output_tokens: 4000,
        learning_rule_threshold: 1.6,
        orchestrator_max_retries: 2,
        learning_rule_cap: 10,
        performance_min_assignments: 3,
        performance_review_pass_floor: 0.1,
        performance_failure_rate_ceiling: 0.5,
        pricing: {}
      }
    );

    expect(codes).not.toContain("LOW_REVIEW_PASS_RATE_FOR_RISK");
  });

  test("plan-check does not gate cold-start agents without performance data", async () => {
    const codes = performancePlanIssueCodes(
      { risk_level: "high", review_required: true },
      {}
    );

    expect(codes).not.toContain("LOW_REVIEW_PASS_RATE_FOR_RISK");
    expect(codes).not.toContain("HIGH_FAILURE_RATE_AGENT");
  });

  test("plan-check reports dry-run deliverable before derived performance routing defects", async () => {
    const permissions = {
      external_actions: false,
      destructive_actions: false,
      credential_access: false,
      paid_actions: false,
      public_actions: false
    };
    const issues = collectPlanIssues({
      plan: {
        deployment_id: "DP-001",
        intent_id: "I-001",
        status: "proposed",
        approval_required: true,
        assignments: [
          {
            task_id: "T-001",
            agent_id: "builder_1",
            executor: "dry_run",
            model_tier: "mid",
            reason: "Exercise ordering.",
            approval_required: false
          }
        ],
        created_at: "2026-05-08T00:00:00.000Z",
        updated_at: "2026-05-08T00:00:00.000Z"
      },
      tasks: [
        TaskSchema.parse(
          baseTask({
            task_id: "T-001",
            owner_agent_id: "builder_1",
            owner_role: "Builder Agent",
            executor: "dry_run",
            model_tier: "mid",
            output_required: "Implementation draft",
            risk_level: "high",
            review_required: true,
            status: "queued"
          })
        )
      ],
      registry: AgentRegistrySchema.parse({
        agents: [
          {
            agent_id: "builder_1",
            role: "Builder Agent",
            executor_type: "dry_run",
            model_tier: "mid",
            allowed_tools: [],
            command_allowlist: [],
            permissions,
            max_cost_usd: 0,
            performance: {
              tasks_assigned: 10,
              tasks_completed: 10,
              tasks_failed: 0,
              review_passes: 2,
              review_failures: 8,
              dry_run_deliverable_mismatches: 2,
              average_score_contribution: 0,
              known_failure_modes: []
            }
          },
          { ...performanceRegistry().agents[1] },
          { ...performanceRegistry().agents[2] },
          { ...performanceRegistry().agents[3] }
        ]
      }),
      artifactIndex: { artifacts: [] }
    });
    const codes = issues.map((issue) => issue.code);

    expect(codes.indexOf("DRY_RUN_DELIVERABLE")).toBeLessThan(
      codes.indexOf("LOW_REVIEW_PASS_RATE_FOR_RISK")
    );
  });

  test("context-check rejects missing dependency artifacts and context paths that escape the workspace", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({ task_id: "T-001", artifacts: [], status: "completed" }),
          baseTask({
            task_id: "T-002",
            owner_agent_id: "reviewer_skeptical",
            owner_role: "Reviewer Agent",
            input_context: ["../outside.md"],
            dependencies: ["T-001"],
            output_required: "Review report"
          })
        ]
      });

      const result = await runContextCheck(root, { taskId: "T-002" });

      expect(result.status).toBe("fail");
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["CONTEXT_PATH_ESCAPES_WORKSPACE", "DEPENDENCY_ARTIFACT_MISSING"])
      );
    });
  });

  test("context-check passes when transitive dependency artifacts are indexed and readable", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveText(root, "artifacts/upstream.md", "usable output");
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({ task_id: "T-001", artifacts: [], status: "completed" }),
          baseTask({
            task_id: "T-002",
            dependencies: ["T-001"],
            owner_agent_id: "reviewer_skeptical",
            owner_role: "Reviewer Agent",
            output_required: "Review report"
          })
        ]
      });
      await addArtifact(root, {
        taskId: "T-001",
        path: "artifacts/upstream.md",
        type: "model_output",
        description: "Upstream output"
      });

      const result = await runContextCheck(root, { taskId: "T-002" });

      expect(result.status).toBe("pass");
      expect(result.issues).toEqual([]);
    });
  });

  test("context-check is idempotent per task and preserves the check id", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({ task_id: "T-001", artifacts: [], status: "completed" }),
          baseTask({
            task_id: "T-002",
            owner_agent_id: "reviewer_skeptical",
            owner_role: "Reviewer Agent",
            dependencies: ["T-001"],
            output_required: "Review report"
          })
        ]
      });

      const first = await runContextCheck(root, { taskId: "T-002" });
      const second = await runContextCheck(root, { taskId: "T-002" });
      const store = await loadJson(root, "state/context_checks.json");

      expect(first.check_id).toBe("CC-001");
      expect(second.check_id).toBe("CC-001");
      expect(store.context_checks).toHaveLength(1);
      expect(store.context_checks[0].updated_at).toBeDefined();
    });
  });

  test("retrospective writes deterministic learning rules from score and checks", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({
            task_id: "T-001",
            executor: "dry_run",
            status: "completed",
            artifacts: ["ART-001"]
          })
        ]
      });
      await saveJson(root, "state/plan_checks.json", {
        plan_checks: [
          {
            check_id: "PC-001",
            deployment_id: "DP-001",
            status: "fail",
            issues: [
              {
                issue_id: "PCI-001",
                severity: "high",
                code: "DRY_RUN_DELIVERABLE",
                target: "T-001",
                message: "Deliverable routed to dry_run.",
                recommended_fix: "Use model_agent.",
                created_at: "2026-05-08T00:00:00.000Z"
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await writeWorkflowScore(root, { deploymentId: "DP-001" });

      const retrospective = await runRetrospective(root, { deploymentId: "DP-001" });

      expect(retrospective.retrospective_id).toBe("RET-001");
      const markdown = await readFile(join(root, "state/retrospectives/RET-001.md"), "utf8");
      expect(markdown).toContain("DRY_RUN_DELIVERABLE");
      const memory = await loadJson(root, "state/learning_memory.json");
      expect(memory.learning_rules[0]).toMatchObject({
        rule_id: "LR-001",
        trigger: "DRY_RUN_DELIVERABLE",
        times_seen: 1
      });
    });
  });

  test("retrospective writes generalized learning rules for performance routing defects", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [baseTask({ task_id: "T-001", status: "completed" })]
      });
      await saveJson(root, "state/plan_checks.json", {
        plan_checks: [
          {
            check_id: "PC-001",
            deployment_id: "DP-001",
            status: "fail",
            issues: [
              {
                issue_id: "PCI-001",
                severity: "high",
                code: "LOW_REVIEW_PASS_RATE_FOR_RISK",
                target: "T-001/builder_1",
                message: "Agent builder_1 has review pass rate 0.20 (below floor 0.5).",
                recommended_fix: "Route elsewhere.",
                created_at: "2026-05-08T00:00:00.000Z"
              },
              {
                issue_id: "PCI-002",
                severity: "high",
                code: "HIGH_FAILURE_RATE_AGENT",
                target: "T-001/builder_1",
                message: "Agent builder_1 has failure rate 0.75 (above ceiling 0.5).",
                recommended_fix: "Route elsewhere.",
                created_at: "2026-05-08T00:00:00.000Z"
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });

      await runRetrospective(root, { deploymentId: "DP-001" });

      const memory = await loadJson(root, "state/learning_memory.json");
      const lowPassRule = memory.learning_rules.find(
        (rule: { trigger: string }) => rule.trigger === "LOW_REVIEW_PASS_RATE_FOR_RISK"
      );
      const highFailureRule = memory.learning_rules.find(
        (rule: { trigger: string }) => rule.trigger === "HIGH_FAILURE_RATE_AGENT"
      );
      expect(lowPassRule?.rule).toBe(
        "Do not route high-risk reviewable tasks to agents whose review pass rate is below the configured floor."
      );
      expect(highFailureRule?.rule).toBe(
        "Do not route non-low-risk tasks to agents whose failure rate exceeds the configured ceiling."
      );
      expect(lowPassRule?.rule).not.toContain("builder_1");
      expect(highFailureRule?.rule).not.toContain("builder_1");
    });
  });

  test("retrospective is idempotent per deployment and does not duplicate learning counts", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({
            task_id: "T-001",
            executor: "dry_run",
            status: "completed",
            artifacts: ["ART-001"]
          })
        ]
      });
      await saveJson(root, "state/plan_checks.json", {
        plan_checks: [
          {
            check_id: "PC-001",
            deployment_id: "DP-001",
            status: "fail",
            issues: [
              {
                issue_id: "PCI-001",
                severity: "high",
                code: "DRY_RUN_DELIVERABLE",
                target: "T-001",
                message: "Deliverable routed to dry_run.",
                recommended_fix: "Use model_agent.",
                created_at: "2026-05-08T00:00:00.000Z"
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });

      const first = await runRetrospective(root, { deploymentId: "DP-001" });
      const second = await runRetrospective(root, { deploymentId: "DP-001" });
      const memory = await loadJson(root, "state/learning_memory.json");
      const index = await loadJson(root, "state/retrospective_index.json");

      expect(first.retrospective_id).toBe("RET-001");
      expect(second.retrospective_id).toBe("RET-001");
      expect(index.retrospectives).toHaveLength(1);
      expect(memory.learning_rules).toHaveLength(1);
      expect(memory.learning_rules[0].times_seen).toBe(1);
    });
  });

  test("performance update records agent outcomes and dry-run deliverable mismatch", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({ task_id: "T-001", status: "completed", blocker: "stale quota failure" }),
          baseTask({
            task_id: "T-002",
            executor: "dry_run",
            output_required: "Implementation playbook",
            status: "completed"
          }),
          baseTask({
            task_id: "T-003",
            owner_agent_id: "reviewer_skeptical",
            status: "failed",
            blocker: "quota exhausted"
          })
        ]
      });
      await saveJson(root, "state/review_log.json", {
        reviews: [
          {
            review_id: "R-001",
            task_id: "T-001",
            reviewer_agent_id: "reviewer_skeptical",
            reviewer_persona: "default",
            status: "pass",
            issues: [],
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            review_id: "R-002",
            task_id: "T-002",
            reviewer_agent_id: "reviewer_skeptical",
            reviewer_persona: "default",
            status: "fail",
            issues: [],
            created_at: "2026-05-08T00:00:01.000Z"
          }
        ]
      });
      await seedConsensus(root, [
        { consensus_id: "C-001", task_id: "T-001", overall_verdict: "pass" },
        { consensus_id: "C-002", task_id: "T-002", overall_verdict: "fail" }
      ]);

      await updateAgentPerformance(root, { deploymentId: "DP-001" });

      const registry = await loadJson(root, "state/agent_registry.json");
      const builder = registry.agents.find((agent: { agent_id: string }) => agent.agent_id === "builder_1");
      const reviewer = registry.agents.find((agent: { agent_id: string }) => agent.agent_id === "reviewer_skeptical");
      expect(builder.performance).toMatchObject({
        tasks_assigned: 2,
        tasks_completed: 2,
        review_passes: 1,
        review_failures: 1,
        dry_run_deliverable_mismatches: 1
      });
      expect(builder.performance.known_failure_modes).toEqual([]);
      expect(reviewer.performance).toMatchObject({
        tasks_assigned: 1,
        tasks_failed: 1
      });
      expect(reviewer.performance.known_failure_modes).toContain("quota exhausted");
    });
  });

  test("performance update derives review outcomes from consensus instead of raw review status", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({
            task_id: "T-001",
            status: "completed",
            review_required: true
          })
        ]
      });
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
                citations: [],
                rationale: "Rubber stamp without evidence.",
                confidence: 0.5
              }
            ],
            identified_issues: [],
            free_form_assessment: "Raw pass should not drive performance.",
            malformed: false,
            truncated: false,
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await seedConsensus(root, [
        {
          consensus_id: "C-001",
          task_id: "T-001",
          overall_verdict: "insufficient",
          per_criterion: [
            {
              criterion: "Specific, measurable criterion",
              pass_count: 1,
              fail_count: 0,
              unverifiable_count: 0,
              abstain_count: 0,
              verdict: "fail",
              convergent_citations: [],
              dissent: []
            }
          ]
        }
      ]);

      await updateAgentPerformance(root, { deploymentId: "DP-001" });

      const registry = await loadJson(root, "state/agent_registry.json");
      const builder = registry.agents.find((agent: { agent_id: string }) => agent.agent_id === "builder_1");
      expect(builder.performance).toMatchObject({
        tasks_assigned: 1,
        review_passes: 0,
        review_failures: 1
      });
    });
  });

  test("performance update is idempotent per deployment", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({ task_id: "T-001", status: "completed" }),
          baseTask({
            task_id: "T-002",
            executor: "dry_run",
            output_required: "Implementation playbook",
            status: "completed"
          }),
          baseTask({
            task_id: "T-003",
            owner_agent_id: "reviewer_skeptical",
            status: "failed",
            blocker: "quota exhausted"
          })
        ]
      });
      await saveJson(root, "state/review_log.json", {
        reviews: [
          {
            review_id: "R-001",
            task_id: "T-001",
            reviewer_agent_id: "reviewer_skeptical",
            reviewer_persona: "default",
            status: "pass",
            issues: [],
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            review_id: "R-002",
            task_id: "T-002",
            reviewer_agent_id: "reviewer_skeptical",
            reviewer_persona: "default",
            status: "fail",
            issues: [],
            created_at: "2026-05-08T00:00:01.000Z"
          }
        ]
      });
      await seedConsensus(root, [
        { consensus_id: "C-001", task_id: "T-001", overall_verdict: "pass" },
        { consensus_id: "C-002", task_id: "T-002", overall_verdict: "fail" }
      ]);

      await updateAgentPerformance(root, { deploymentId: "DP-001" });
      await updateAgentPerformance(root, { deploymentId: "DP-001" });

      const registry = await loadJson(root, "state/agent_registry.json");
      const ledger = await loadJson(root, "state/performance_ledger.json");
      const builder = registry.agents.find((agent: { agent_id: string }) => agent.agent_id === "builder_1");
      expect(ledger.entries.filter((entry: { deployment_id: string }) => entry.deployment_id === "DP-001")).toHaveLength(2);
      expect(builder.performance).toMatchObject({
        tasks_assigned: 2,
        tasks_completed: 2,
        review_passes: 1,
        review_failures: 1,
        dry_run_deliverable_mismatches: 1
      });
    });
  });

  test("performance update repairs inflated registry stats from the ledger projection", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(root);
      const registry = await loadJson(root, "state/agent_registry.json");
      const builder = registry.agents.find((agent: { agent_id: string }) => agent.agent_id === "builder_1");
      builder.performance = {
        tasks_assigned: 99,
        tasks_completed: 99,
        tasks_failed: 99,
        review_passes: 99,
        review_failures: 99,
        dry_run_deliverable_mismatches: 99,
        average_score_contribution: 99,
        known_failure_modes: ["stale inflated value"]
      };
      await saveJson(root, "state/agent_registry.json", registry);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          baseTask({ task_id: "T-001", status: "completed" }),
          baseTask({
            task_id: "T-002",
            executor: "dry_run",
            output_required: "Implementation playbook",
            status: "completed"
          })
        ]
      });

      await updateAgentPerformance(root, { deploymentId: "DP-001" });

      const repaired = await loadJson(root, "state/agent_registry.json");
      const repairedBuilder = repaired.agents.find((agent: { agent_id: string }) => agent.agent_id === "builder_1");
      expect(repairedBuilder.performance).toMatchObject({
        tasks_assigned: 2,
        tasks_completed: 2,
        tasks_failed: 0,
        dry_run_deliverable_mismatches: 1,
        known_failure_modes: []
      });
    });
  });
});
