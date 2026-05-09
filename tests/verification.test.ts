import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { addArtifact } from "../src/artifacts.js";
import { computeConsensus } from "../src/consensus.js";
import { runPlanCheck } from "../src/planCheck.js";
import { buildReviewerInstructions } from "../src/reviewerPrompts.js";
import { migrateLegacyReviews } from "../src/reviews.js";
import { runDeployment } from "../src/runner.js";
import { writeWorkflowScore } from "../src/scoring.js";
import { CitationSchema, TaskSchema, type StructuredReview } from "../src/schemas.js";
import { loadJson, saveJson, saveText } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-verification-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function modelResponse(
  text: string,
  overrides: Partial<{
    truncated: boolean;
    status: string;
    reason: string;
    usage: { input_tokens: number; output_tokens: number };
  }> = {}
) {
  return {
    text,
    truncated: false,
    ...overrides
  };
}

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "T-001",
    title: "Produce evidence brief",
    owner_agent_id: "researcher_1",
    owner_role: "Research Agent",
    executor: "model_agent",
    model_tier: "mid",
    input_context: ["state/prompt_contract.md"],
    output_required: "Evidence-backed brief",
    acceptance_criteria: ["Brief includes the required evidence claim"],
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

async function seedDeployment(
  root: string,
  tasks: Array<Record<string, unknown>>,
  assignments: Array<Record<string, unknown>>
): Promise<void> {
  await saveJson(root, "state/task_board.json", { tasks });
  await saveJson(root, "state/deployment_plan.json", {
    deployment_plans: [
      {
        deployment_id: "DP-001",
        intent_id: "I-001",
        status: "approved",
        approval_required: false,
        assignments,
        created_at: "2026-05-08T00:00:00.000Z",
        updated_at: "2026-05-08T00:00:00.000Z"
      }
    ]
  });
}

function review(overrides: Partial<StructuredReview> = {}): StructuredReview {
  return {
    review_id: "R-001",
    task_id: "T-001",
    reviewer_agent_id: "reviewer_skeptical",
    reviewer_persona: "skeptical",
    status: "pass",
    per_criterion: [
      {
        criterion: "Brief includes the required evidence claim",
        verdict: "pass",
        citations: [{ artifact_id: "ART-001", line_start: 5, line_end: 10 }],
        rationale: "The cited span supports the claim.",
        confidence: 0.9
      }
    ],
    identified_issues: [],
    free_form_assessment: "",
    malformed: false,
    truncated: false,
    created_at: "2026-05-08T00:00:00.000Z",
    ...overrides
  };
}

function reviewerJson(persona: string, artifactId = "ART-001", verdict = "pass"): string {
  return JSON.stringify({
    reviewer_persona: persona,
    status: verdict === "fail" ? "fail" : "pass",
    per_criterion: [
      {
        criterion: "Brief includes the required evidence claim",
        verdict,
        citations:
          verdict === "unverifiable"
            ? []
            : [{ artifact_id: artifactId, line_start: 1, line_end: 2 }],
        rationale: "" + (persona) + " " + (verdict) + " rationale",
        confidence: 0.8
      }
    ],
    identified_issues: [],
    free_form_assessment: "" + (persona) + " assessment"
  });
}

async function seedConsensusTask(root: string): Promise<void> {
  await initWorkspace(root);
  await seedDeployment(root, [baseTask()], [assignment()]);
  await saveText(root, "artifacts/runs/T-001/response_output.md", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n");
  await addArtifact(root, {
    taskId: "T-001",
    path: "artifacts/runs/T-001/response_output.md",
    type: "model_output",
    description: "Task output"
  });
}

describe("honest verification", () => {
  test("malformed reviewer JSON abstains without failing the runner", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(
        root,
        [baseTask({ status: "queued", risk_level: "low" })],
        [assignment()]
      );

      expect(CitationSchema.safeParse({ artifact_id: "ART-001", line_start: 9, line_end: 4 }).success).toBe(false);

      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValueOnce(modelResponse("deliverable\nwith evidence"))
          .mockResolvedValueOnce(modelResponse(JSON.stringify({ status: "pass" })))
      };

      const result = await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const log = await loadJson(root, "state/review_log.json");
      const chat = await loadJson(root, "state/chat.json");
      expect(result.failed).toEqual([]);
      expect(log.reviews).toHaveLength(1);
      expect(log.reviews[0]).toMatchObject({
        status: "abstain",
        malformed: true,
        reviewer_persona: "skeptical"
      });
      expect(chat.messages.some((message: { type: string }) => message.type === "defect")).toBe(true);
    });
  });

  test("citation overlap produces a convergent citation span", async () => {
    await withWorkspace(async (root) => {
      await seedConsensusTask(root);
      await saveJson(root, "state/review_log.json", {
        reviews: [
          review({ review_id: "R-001" }),
          review({
            review_id: "R-002",
            reviewer_agent_id: "reviewer_completeness",
            reviewer_persona: "completeness",
            per_criterion: [
              {
                criterion: "Brief includes the required evidence claim",
                verdict: "pass",
                citations: [{ artifact_id: "ART-001", line_start: 8, line_end: 15 }],
                rationale: "The second reviewer cites an overlapping span.",
                confidence: 0.85
              }
            ]
          })
        ]
      });

      const consensus = await computeConsensus(root, { taskId: "T-001" });

      expect(consensus.per_criterion[0]!.convergent_citations).toEqual([
        { artifact_id: "ART-001", line_start: 8, line_end: 10 }
      ]);
    });
  });

  test("convergent passing consensus counts toward verified useful outputs", async () => {
    await withWorkspace(async (root) => {
      await seedConsensusTask(root);
      await saveJson(root, "state/review_log.json", {
        reviews: [
          review({ review_id: "R-001" }),
          review({
            review_id: "R-002",
            reviewer_agent_id: "reviewer_completeness",
            reviewer_persona: "completeness",
            per_criterion: [
              {
                criterion: "Brief includes the required evidence claim",
                verdict: "pass",
                citations: [{ artifact_id: "ART-001", line_start: 8, line_end: 12 }],
                rationale: "Overlaps with the other reviewers.",
                confidence: 0.86
              }
            ]
          }),
          review({
            review_id: "R-003",
            reviewer_agent_id: "reviewer_rigor",
            reviewer_persona: "rigor",
            per_criterion: [
              {
                criterion: "Brief includes the required evidence claim",
                verdict: "pass",
                citations: [{ artifact_id: "ART-001", line_start: 9, line_end: 13 }],
                rationale: "The evidence is internally consistent.",
                confidence: 0.88
              }
            ]
          })
        ]
      });

      const consensus = await computeConsensus(root, { taskId: "T-001" });
      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(consensus.overall_verdict).toBe("pass");
      expect(score.verified_useful_outputs).toBe(1);
      expect(score.consensus_pass_count).toBe(1);
    });
  });

  test("rubber-stamp pass reviews without citations do not verify useful output", async () => {
    await withWorkspace(async (root) => {
      await seedConsensusTask(root);
      const emptyCitationReview = (reviewId: string, agentId: string, persona: StructuredReview["reviewer_persona"]) =>
        review({
          review_id: reviewId,
          reviewer_agent_id: agentId,
          reviewer_persona: persona,
          per_criterion: [
            {
              criterion: "Brief includes the required evidence claim",
              verdict: "pass",
              citations: [],
              rationale: "Pass without evidence.",
              confidence: 0.6
            }
          ]
        });
      await saveJson(root, "state/review_log.json", {
        reviews: [
          emptyCitationReview("R-001", "reviewer_skeptical", "skeptical"),
          emptyCitationReview("R-002", "reviewer_completeness", "completeness"),
          emptyCitationReview("R-003", "reviewer_rigor", "rigor")
        ]
      });

      const consensus = await computeConsensus(root, { taskId: "T-001" });
      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(consensus.per_criterion[0]!.verdict).toBe("fail");
      expect(consensus.overall_verdict).toBe("fail");
      expect(score.verified_useful_outputs).toBe(0);
    });
  });

  test("failing reviewer with citations forces consensus failure and records dissent", async () => {
    await withWorkspace(async (root) => {
      await seedConsensusTask(root);
      await saveJson(root, "state/review_log.json", {
        reviews: [
          review({ review_id: "R-001" }),
          review({
            review_id: "R-002",
            reviewer_agent_id: "reviewer_completeness",
            reviewer_persona: "completeness"
          }),
          review({
            review_id: "R-003",
            reviewer_agent_id: "reviewer_rigor",
            reviewer_persona: "rigor",
            status: "fail",
            per_criterion: [
              {
                criterion: "Brief includes the required evidence claim",
                verdict: "fail",
                citations: [{ artifact_id: "ART-001", line_start: 7, line_end: 9 }],
                rationale: "The cited lines contradict the criterion.",
                confidence: 0.92
              }
            ]
          })
        ]
      });

      const consensus = await computeConsensus(root, { taskId: "T-001" });
      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(consensus.per_criterion[0]!.verdict).toBe("fail");
      expect(consensus.per_criterion[0]!.dissent.length).toBeGreaterThan(0);
      expect(score.verified_useful_outputs).toBe(0);
    });
  });

  test("split consensus increments the scoring split penalty", async () => {
    await withWorkspace(async (root) => {
      await seedConsensusTask(root);
      await saveJson(root, "state/review_log.json", {
        reviews: [
          review({ review_id: "R-001" }),
          review({
            review_id: "R-002",
            reviewer_agent_id: "reviewer_completeness",
            reviewer_persona: "completeness",
            status: "fail",
            per_criterion: [
              {
                criterion: "Brief includes the required evidence claim",
                verdict: "fail",
                citations: [],
                rationale: "Failure without citable evidence.",
                confidence: 0.5
              }
            ]
          }),
          review({
            review_id: "R-003",
            reviewer_agent_id: "reviewer_rigor",
            reviewer_persona: "rigor",
            status: "abstain",
            per_criterion: [
              {
                criterion: "Brief includes the required evidence claim",
                verdict: "unverifiable",
                citations: [],
                rationale: "Cannot verify the claim.",
                confidence: 0.7
              }
            ]
          })
        ]
      });

      const consensus = await computeConsensus(root, { taskId: "T-001" });
      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(consensus.per_criterion[0]!.verdict).toBe("split");
      expect(consensus.overall_verdict).toBe("split");
      expect(score.consensus_split_count).toBe(1);
    });
  });

  test("all-abstain criterion resolves to unverifiable, not split", async () => {
    await withWorkspace(async (root) => {
      await seedConsensusTask(root);
      await saveJson(root, "state/review_log.json", {
        reviews: [
          review({
            review_id: "R-001",
            status: "abstain",
            per_criterion: []
          }),
          review({
            review_id: "R-002",
            reviewer_agent_id: "reviewer_completeness",
            reviewer_persona: "completeness",
            status: "abstain",
            per_criterion: []
          }),
          review({
            review_id: "R-003",
            reviewer_agent_id: "reviewer_rigor",
            reviewer_persona: "rigor",
            status: "abstain",
            per_criterion: []
          })
        ]
      });

      const consensus = await computeConsensus(root, { taskId: "T-001" });
      const score = await writeWorkflowScore(root, { deploymentId: "DP-001" });

      expect(consensus.per_criterion.every((entry) => entry.verdict === "unverifiable")).toBe(true);
      expect(consensus.per_criterion[0]).toMatchObject({
        pass_count: 0,
        fail_count: 0,
        unverifiable_count: 0,
        abstain_count: 3
      });
      expect(score.consensus_split_count).toBe(0);
    });
  });

  test("risk-tiered fanout spawns one, two, or three persona reviews", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const tasks = [
        baseTask({ task_id: "T-001", status: "queued", risk_level: "low" }),
        baseTask({ task_id: "T-002", status: "queued", risk_level: "medium" }),
        baseTask({ task_id: "T-003", status: "queued", risk_level: "high" })
      ];
      await seedDeployment(root, tasks, [
        assignment({ task_id: "T-001" }),
        assignment({ task_id: "T-002" }),
        assignment({ task_id: "T-003" })
      ]);
      const modelClient = {
        createResponse: vi.fn(async (request: { instructions: string; input: string }) => {
          if (!request.instructions.includes("structured verification reviewer")) {
            return modelResponse("line one\nline two");
          }
          const artifactId = /Artifact (ART-\d+)/.exec(request.input)?.[1] ?? "ART-001";
          if (request.instructions.includes("completeness reviewer")) {
            return modelResponse(reviewerJson("completeness", artifactId));
          }
          if (request.instructions.includes("rigor reviewer")) {
            return modelResponse(reviewerJson("rigor", artifactId));
          }
          return modelResponse(reviewerJson("skeptical", artifactId));
        })
      };

      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const log = await loadJson(root, "state/review_log.json");
      expect(log.reviews.filter((entry: { task_id: string }) => entry.task_id === "T-001")).toHaveLength(1);
      expect(log.reviews.filter((entry: { task_id: string }) => entry.task_id === "T-002")).toHaveLength(2);
      expect(log.reviews.filter((entry: { task_id: string }) => entry.task_id === "T-003")).toHaveLength(3);
      expect(new Set(log.reviews.map((entry: { reviewer_persona: string }) => entry.reviewer_persona))).toEqual(
        new Set(["skeptical", "completeness", "rigor"])
      );
    });
  });

  test("truncated reviewer response abstains while consensus still computes", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(
        root,
        [baseTask({ status: "queued", risk_level: "medium" })],
        [assignment()]
      );
      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValueOnce(modelResponse("deliverable\nwith evidence"))
          .mockResolvedValueOnce(
            modelResponse("partial", {
              truncated: true,
              status: "incomplete",
              reason: "max_output_tokens"
            })
          )
          .mockResolvedValueOnce(modelResponse(reviewerJson("completeness")))
      };

      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const log = await loadJson(root, "state/review_log.json");
      const consensus = await loadJson(root, "state/consensus.json");
      expect(log.reviews[0]).toMatchObject({
        status: "abstain",
        truncated: true
      });
      expect(consensus.consensus_records[0]).toMatchObject({
        task_id: "T-001",
        overall_verdict: "insufficient"
      });
    });
  });

  test("reviewer shorthand issue output records a structured fail review", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await seedDeployment(
        root,
        [baseTask({ status: "queued", risk_level: "low" })],
        [assignment()]
      );
      const shorthandFailReview = JSON.stringify({
        reviewer_persona: "skeptical",
        status: "fail",
        per_criterion: [
          {
            criterion: "Brief includes the required evidence claim",
            verdict: "fail",
            citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 2 }],
            rationale: "The cited span does not include the required evidence claim.",
            confidence: 0.8
          }
        ],
        identified_issues: [
          {
            issue: "The deliverable omits the required evidence claim.",
            severity: "major",
            citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 2 }]
          }
        ],
        free_form_assessment: "The deliverable is incomplete."
      });
      const modelClient = {
        createResponse: vi
          .fn()
          .mockResolvedValueOnce(modelResponse("line one\nline two"))
          .mockResolvedValueOnce(modelResponse(shorthandFailReview))
      };

      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const log = await loadJson(root, "state/review_log.json");
      const consensus = await loadJson(root, "state/consensus.json");
      expect(log.reviews[0]).toMatchObject({
        status: "fail",
        malformed: false,
        identified_issues: [
          expect.objectContaining({
            severity: "high",
            category: "review_issue",
            description: "The deliverable omits the required evidence claim."
          })
        ]
      });
      expect(consensus.consensus_records[0]).toMatchObject({
        overall_verdict: "fail"
      });
    });
  });

  test("reviewer instructions avoid formatting-only tradeoff failures", async () => {
    const instructions = buildReviewerInstructions(
      "completeness",
      TaskSchema.parse(baseTask({
        acceptance_criteria: ["Lists tradeoffs (latency/cost/reliability) for each option"]
      }))
    );

    expect(instructions).toContain("Do not fail solely for tradeoff label formatting");
    expect(instructions).toContain("Qualitative ranges are acceptable when paired with a concrete impact or rationale");
    expect(instructions).toContain("Do not treat summary recommendation lists as new options when they only reference options already covered");
  });

  test("consensus recomputation is idempotent for a task", async () => {
    await withWorkspace(async (root) => {
      await seedConsensusTask(root);
      await saveJson(root, "state/review_log.json", { reviews: [review({ review_id: "R-001" })] });

      const first = await computeConsensus(root, { taskId: "T-001" });
      const second = await computeConsensus(root, { taskId: "T-001" });
      const store = await loadJson(root, "state/consensus.json");

      expect(first.consensus_id).toBe("C-001");
      expect(second.consensus_id).toBe("C-001");
      expect(store.consensus_records).toHaveLength(1);
    });
  });

  test("latest persona reviews supersede stale rerun reviews for consensus", async () => {
    await withWorkspace(async (root) => {
      await seedConsensusTask(root);
      await saveJson(root, "state/review_log.json", {
        reviews: [
          review({
            review_id: "R-001",
            reviewer_agent_id: "reviewer_skeptical",
            reviewer_persona: "skeptical",
            status: "fail",
            per_criterion: [
              {
                criterion: "Brief includes the required evidence claim",
                verdict: "fail",
                citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 2 }],
                rationale: "Earlier run was missing the evidence claim.",
                confidence: 0.9
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z"
          }),
          review({
            review_id: "R-002",
            reviewer_agent_id: "reviewer_completeness",
            reviewer_persona: "completeness",
            status: "pass",
            per_criterion: [
              {
                criterion: "Brief includes the required evidence claim",
                verdict: "pass",
                citations: [{ artifact_id: "ART-001", line_start: 5, line_end: 10 }],
                rationale: "Independent reviewer confirms the corrected evidence claim.",
                confidence: 0.86
              }
            ],
            created_at: "2026-05-08T00:00:01.000Z"
          }),
          review({
            review_id: "R-003",
            reviewer_agent_id: "reviewer_skeptical",
            reviewer_persona: "skeptical",
            status: "pass",
            per_criterion: [
              {
                criterion: "Brief includes the required evidence claim",
                verdict: "pass",
                citations: [{ artifact_id: "ART-001", line_start: 8, line_end: 12 }],
                rationale: "Latest skeptical review verifies the corrected evidence claim.",
                confidence: 0.88
              }
            ],
            created_at: "2026-05-08T00:00:02.000Z"
          })
        ]
      });

      const consensus = await computeConsensus(root, { taskId: "T-001" });

      expect(consensus.review_ids).toEqual(["R-002", "R-003"]);
      expect(consensus.reviewer_count).toBe(2);
      expect(consensus.per_criterion[0]).toMatchObject({
        pass_count: 2,
        fail_count: 0,
        verdict: "pass"
      });
      expect(consensus.overall_verdict).toBe("pass");
    });
  });

  test("plan-check flags insufficient reviewer diversity for high-risk reviewable tasks", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      const registry = await loadJson(root, "state/agent_registry.json");
      registry.agents = registry.agents.filter((agent: { reviewer_persona?: string }) => agent.reviewer_persona !== "completeness" && agent.reviewer_persona !== "rigor");
      await saveJson(root, "state/agent_registry.json", registry);
      await seedDeployment(
        root,
        [baseTask({ risk_level: "high", review_required: true })],
        [assignment()]
      );

      const check = await runPlanCheck(root, { deploymentId: "DP-001" });

      expect(check.issues.map((issue) => issue.code)).toContain("INSUFFICIENT_REVIEWERS");
      expect(check.issues.find((issue) => issue.code === "INSUFFICIENT_REVIEWERS")?.severity).toBe("high");
    });
  });

  test("legacy enum reviews migrate to malformed abstentions and insufficient consensus", async () => {
    await withWorkspace(async (root) => {
      await seedConsensusTask(root);
      await saveJson(root, "state/review_log.json", {
        reviews: [
          {
            review_id: "R-001",
            task_id: "T-001",
            reviewer: "reviewer_1",
            status: "pass",
            issues: [],
            created_at: "2026-05-08T00:00:00.000Z"
          },
          {
            review_id: "R-002",
            task_id: "T-001",
            reviewer: "reviewer_1",
            status: "pass",
            issues: [],
            created_at: "2026-05-08T00:00:01.000Z"
          },
          {
            review_id: "R-003",
            task_id: "T-001",
            reviewer: "reviewer_1",
            status: "fail",
            issues: [],
            created_at: "2026-05-08T00:00:02.000Z"
          }
        ]
      });

      const result = await migrateLegacyReviews(root);

      const log = await loadJson(root, "state/review_log.json");
      const consensus = await loadJson(root, "state/consensus.json");
      expect(result.migratedCount).toBe(3);
      expect(log.reviews).toHaveLength(3);
      expect(log.reviews.every((entry: { status: string; malformed: boolean }) => entry.status === "abstain" && entry.malformed)).toBe(true);
      expect(consensus.consensus_records[0].overall_verdict).toBe("insufficient");
      expect(
        consensus.consensus_records.every((record: { per_criterion: Array<{ verdict: string }> }) =>
          record.per_criterion.every((entry) => entry.verdict === "unverifiable")
        )
      ).toBe(true);
    });
  });
});
