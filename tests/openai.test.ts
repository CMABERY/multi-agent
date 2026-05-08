import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OpenAIResponsesClient } from "../src/openai.js";
import { runDeployment } from "../src/runner.js";
import type { ModelConfig } from "../src/schemas.js";
import { loadJson, saveJson } from "../src/storage.js";
import { initWorkspace } from "../src/workspace.js";

const envName = "MAW_OPENAI_TEST_KEY";

function config(): ModelConfig {
  return {
    provider: "openai",
    base_url: "https://api.openai.test/v1",
    api_key_env: envName,
    default_models: {
      orchestrator: "test-model",
      high: "test-model",
      mid: "test-model",
      low: "test-model"
    },
    max_output_tokens: 4000,
    learning_rule_threshold: 1.6,
    orchestrator_max_retries: 2,
    learning_rule_cap: 10,
    performance_min_assignments: 3,
    performance_review_pass_floor: 0.5,
    performance_failure_rate_ceiling: 0.5,
    pricing: {}
  };
}

function stubResponse(body: unknown, status = 200): void {
  process.env[envName] = "test-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      typeof body === "string"
        ? new Response(body, { status })
        : new Response(JSON.stringify(body), { status })
    )
  );
}

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "maw-openai-runner-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function modelResponse(text: string) {
  return { text, truncated: false };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[envName];
});

describe("OpenAIResponsesClient", () => {
  test("returns output_text and token usage on a successful response", async () => {
    stubResponse({
      status: "completed",
      output_text: "hello",
      usage: { input_tokens: 10, output_tokens: 20 }
    });

    const result = await new OpenAIResponsesClient(config()).createResponse({
      model: "test-model",
      instructions: "follow",
      input: "prompt"
    });

    expect(result).toMatchObject({
      text: "hello",
      truncated: false,
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 20 }
    });
  });

  test("marks responses truncated when top-level status is incomplete", async () => {
    stubResponse({ status: "incomplete", output_text: "partial" });

    const result = await new OpenAIResponsesClient(config()).createResponse({
      instructions: "follow",
      input: "prompt"
    });

    expect(result.truncated).toBe(true);
  });

  test("marks responses truncated when incomplete_details reports max_output_tokens", async () => {
    stubResponse({
      status: "completed",
      output_text: "partial",
      incomplete_details: { reason: "max_output_tokens" }
    });

    const result = await new OpenAIResponsesClient(config()).createResponse({
      instructions: "follow",
      input: "prompt"
    });

    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_output_tokens");
  });

  test("ignores missing or malformed usage without throwing", async () => {
    stubResponse({
      status: "completed",
      output_text: "hello",
      usage: { input_tokens: "10", output_tokens: "20" }
    });

    const result = await new OpenAIResponsesClient(config()).createResponse({
      instructions: "follow",
      input: "prompt"
    });

    expect(result.usage).toBeUndefined();
  });

  test("returns undefined usage when the response omits the field", async () => {
    stubResponse({
      status: "completed",
      output_text: "hello"
    });

    const result = await new OpenAIResponsesClient(config()).createResponse({
      instructions: "follow",
      input: "prompt"
    });

    expect(result.text).toBe("hello");
    expect(result.usage).toBeUndefined();
  });

  test("falls back to chunked output content", async () => {
    stubResponse({
      status: "completed",
      output: [{ content: [{ text: "a" }, { output_text: "b" }] }]
    });

    const result = await new OpenAIResponsesClient(config()).createResponse({
      instructions: "follow",
      input: "prompt"
    });

    expect(result.text).toBe("a\nb");
  });

  test("throws with response status on non-2xx responses", async () => {
    stubResponse("nope", 429);

    await expect(
      new OpenAIResponsesClient(config()).createResponse({
        instructions: "follow",
        input: "prompt"
      })
    ).rejects.toThrow(/\(429\)/);
  });

  test("throws with the configured env name when the API key is missing", async () => {
    await expect(
      new OpenAIResponsesClient(config()).createResponse({
        instructions: "follow",
        input: "prompt"
      })
    ).rejects.toThrow(envName);
  });

  test("persona instruction differentiation reaches reviewer model calls", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          {
            task_id: "T-001",
            title: "Produce checked output",
            owner_agent_id: "researcher_1",
            owner_role: "Research Agent",
            executor: "model_agent",
            model_tier: "mid",
            input_context: ["state/prompt_contract.md"],
            output_required: "Evidence-backed brief",
            acceptance_criteria: ["Brief includes the required evidence claim"],
            dependencies: [],
            risk_level: "high",
            review_required: true,
            approval_required: false,
            status: "queued",
            artifacts: [],
            deployment_id: "DP-001",
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [
          {
            deployment_id: "DP-001",
            intent_id: "I-001",
            status: "approved",
            approval_required: false,
            assignments: [
              {
                task_id: "T-001",
                agent_id: "researcher_1",
                executor: "model_agent",
                model_tier: "mid",
                reason: "Produce the checked output.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      const reviewJson = (persona: string, rationale: string) =>
        JSON.stringify({
          reviewer_persona: persona,
          status: "pass",
          per_criterion: [
            {
              criterion: "Brief includes the required evidence claim",
              verdict: "pass",
              citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 2 }],
              rationale,
              confidence: 0.9
            }
          ],
          identified_issues: [],
          free_form_assessment: rationale
        });
      const modelClient = {
        createResponse: vi.fn(async (request: { instructions: string }) => {
          if (request.instructions.includes("skeptical reviewer")) {
            return modelResponse(reviewJson("skeptical", "skeptical lens reached the model"));
          }
          if (request.instructions.includes("completeness reviewer")) {
            return modelResponse(reviewJson("completeness", "completeness lens reached the model"));
          }
          if (request.instructions.includes("rigor reviewer")) {
            return modelResponse(reviewJson("rigor", "rigor lens reached the model"));
          }
          return modelResponse("Required evidence claim\nsupporting line");
        })
      };

      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const log = await loadJson(root, "state/review_log.json");
      expect(log.reviews.map((entry: { reviewer_persona: string }) => entry.reviewer_persona)).toEqual([
        "skeptical",
        "completeness",
        "rigor"
      ]);
      expect(log.reviews.map((entry: { per_criterion: Array<{ rationale: string }> }) => entry.per_criterion[0]!.rationale)).toEqual([
        "skeptical lens reached the model",
        "completeness lens reached the model",
        "rigor lens reached the model"
      ]);
    });
  });

  test("reviewer output with duplicate criteria is marked malformed and abstains", async () => {
    await withWorkspace(async (root) => {
      await initWorkspace(root);
      await saveJson(root, "state/task_board.json", {
        tasks: [
          {
            task_id: "T-001",
            title: "Produce checked output",
            owner_agent_id: "researcher_1",
            owner_role: "Research Agent",
            executor: "model_agent",
            model_tier: "mid",
            input_context: ["state/prompt_contract.md"],
            output_required: "Evidence-backed brief",
            acceptance_criteria: [
              "Brief includes the required evidence claim",
              "Brief states the operational risk"
            ],
            dependencies: [],
            risk_level: "low",
            review_required: true,
            approval_required: false,
            status: "queued",
            artifacts: [],
            deployment_id: "DP-001",
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      await saveJson(root, "state/deployment_plan.json", {
        deployment_plans: [
          {
            deployment_id: "DP-001",
            intent_id: "I-001",
            status: "approved",
            approval_required: false,
            assignments: [
              {
                task_id: "T-001",
                agent_id: "researcher_1",
                executor: "model_agent",
                model_tier: "mid",
                reason: "Produce the checked output.",
                approval_required: false
              }
            ],
            created_at: "2026-05-08T00:00:00.000Z",
            updated_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      });
      const duplicateCriterionReview = JSON.stringify({
        reviewer_persona: "skeptical",
        status: "pass",
        per_criterion: [
          {
            criterion: "Brief includes the required evidence claim",
            verdict: "pass",
            citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 1 }],
            rationale: "First duplicate pass.",
            confidence: 0.9
          },
          {
            criterion: "Brief includes the required evidence claim",
            verdict: "pass",
            citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 1 }],
            rationale: "Second duplicate pass.",
            confidence: 0.9
          }
        ],
        identified_issues: [],
        free_form_assessment: "Missing the second criterion."
      });
      const modelClient = {
        createResponse: vi.fn(async (request: { instructions: string }) => {
          if (request.instructions.includes("skeptical reviewer")) return modelResponse(duplicateCriterionReview);
          return modelResponse("Required evidence claim\nOperational risk");
        })
      };

      await runDeployment(root, { deploymentId: "DP-001", modelClient });

      const log = await loadJson(root, "state/review_log.json");
      expect(log.reviews[0]).toMatchObject({
        status: "abstain",
        malformed: true,
        per_criterion: []
      });
      expect(log.reviews[0].free_form_assessment).toContain("criteria");
    });
  });
});
