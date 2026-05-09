import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultOperatorExperience } from "./operatorExperience.js";
import { ensureDir, nowIso, saveJson, saveText } from "./storage.js";

async function writeIfMissing(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  try {
    await access(path);
  } catch {
    await saveText(root, relativePath, content);
  }
}

async function saveJsonIfMissing(root: string, relativePath: string, value: unknown): Promise<void> {
  const fullPath = join(root, relativePath);
  try {
    await access(fullPath);
  } catch {
    await saveJson(root, relativePath, value);
  }
}

export async function initWorkspace(root: string): Promise<void> {
  for (const dir of [
    "state",
    "artifacts",
    "artifacts/runs",
    "artifacts/final_outputs",
    "artifacts/research_briefs",
    "artifacts/screenshots",
    "state/retrospectives",
    "state/grader_descriptors",
    "state/grader_outputs/reviewer_calibration",
    "state/grader_outputs/acceptance_criteria",
    "state/grader_outputs/intent",
    "state/grader_outputs/review_reasoning",
    "state/grader_outputs/output_quality",
    "state/calibration",
    "state/probation",
    "protocols",
    "instructions"
  ]) {
    await mkdir(join(root, dir), { recursive: true });
  }

  await saveJsonIfMissing(root, "state/intent_queue.json", { intents: [] });
  await saveJsonIfMissing(root, "state/task_board.json", { tasks: [] });
  await saveJsonIfMissing(root, "state/deployment_plan.json", { deployment_plans: [] });
  await saveJsonIfMissing(root, "state/agent_registry.json", defaultAgentRegistry());
  await saveJsonIfMissing(root, "state/model_config.json", defaultModelConfig());
  await saveJsonIfMissing(root, "state/chat.json", { messages: [] });
  await saveJsonIfMissing(root, "state/review_log.json", { reviews: [] });
  await saveJsonIfMissing(root, "state/consensus.json", { consensus_records: [] });
  await saveJsonIfMissing(root, "state/approvals.json", { approvals: [] });
  await saveJsonIfMissing(root, "state/metrics.json", {
    model_calls: 0,
    local_commands: 0,
    dry_runs: 0,
    tasks_completed: 0,
    tasks_failed: 0,
    estimated_cost_usd: 0
  });
  await saveJsonIfMissing(root, "state/workflow_score.json", { workflow_scores: [] });
  await saveJsonIfMissing(root, "state/plan_checks.json", { plan_checks: [] });
  await saveJsonIfMissing(root, "state/context_checks.json", { context_checks: [] });
  await saveJsonIfMissing(root, "state/learning_memory.json", { learning_rules: [] });
  await saveJsonIfMissing(root, "state/retrospective_index.json", { retrospectives: [] });
  await saveJsonIfMissing(root, "state/performance_ledger.json", { entries: [] });
  await saveJsonIfMissing(root, "state/operator_experience.json", defaultOperatorExperience(nowIso()));
  await saveJsonIfMissing(root, "state/permission_audit.json", { events: [] });
  await saveJsonIfMissing(root, "state/transactions.json", { transactions: [] });
  await saveJsonIfMissing(root, "state/grader_registry.json", { entries: [] });
  await saveJsonIfMissing(root, "state/probation/probation_log.json", { records: [] });
  await saveJsonIfMissing(root, "artifacts/artifact_index.json", { artifacts: [] });

  await writeIfMissing(
    root,
    "state/prompt_contract.md",
    "# Prompt Contract\n\nNo intent has been orchestrated yet.\n"
  );
  await writeIfMissing(
    root,
    "state/decision_log.md",
    "# Decision Log\n\nNo decisions recorded yet.\n"
  );

  for (const [relativePath, content] of Object.entries(protocolTemplates())) {
    await ensureDir(join(root, relativePath, ".."));
    await writeIfMissing(root, relativePath, content);
  }
  for (const [relativePath, content] of Object.entries(instructionTemplates())) {
    await ensureDir(join(root, relativePath, ".."));
    await writeIfMissing(root, relativePath, content);
  }
}

function defaultAgentRegistry() {
  const safePermissions = {
    external_actions: false,
    destructive_actions: false,
    credential_access: false,
    paid_actions: false,
    public_actions: false
  };
  return {
    agents: [
      {
        agent_id: "orchestrator_1",
        role: "Orchestrator Agent",
        executor_type: "model_agent",
        model_tier: "high",
        allowed_tools: [],
        command_allowlist: [],
        permissions: safePermissions,
        max_cost_usd: 1
      },
      {
        agent_id: "researcher_1",
        role: "Research Agent",
        executor_type: "model_agent",
        model_tier: "mid",
        allowed_tools: [],
        command_allowlist: [],
        permissions: safePermissions,
        max_cost_usd: 1
      },
      {
        agent_id: "builder_1",
        role: "Builder Agent",
        executor_type: "dry_run",
        model_tier: "mid",
        allowed_tools: [],
        command_allowlist: [],
        permissions: safePermissions,
        max_cost_usd: 0
      },
      {
        agent_id: "reviewer_skeptical",
        role: "Reviewer Agent",
        executor_type: "model_agent",
        model_tier: "high",
        reviewer_persona: "skeptical",
        allowed_tools: [],
        command_allowlist: [],
        permissions: safePermissions,
        max_cost_usd: 1
      },
      {
        agent_id: "reviewer_completeness",
        role: "Reviewer Agent",
        executor_type: "model_agent",
        model_tier: "high",
        reviewer_persona: "completeness",
        allowed_tools: [],
        command_allowlist: [],
        permissions: safePermissions,
        max_cost_usd: 1
      },
      {
        agent_id: "reviewer_rigor",
        role: "Reviewer Agent",
        executor_type: "model_agent",
        model_tier: "high",
        reviewer_persona: "rigor",
        allowed_tools: [],
        command_allowlist: [],
        permissions: safePermissions,
        max_cost_usd: 1
      }
    ]
  };
}

function defaultModelConfig() {
  return {
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
    performance_review_pass_floor: 0.5,
    performance_failure_rate_ceiling: 0.5
  };
}

function protocolTemplates(): Record<string, string> {
  return {
    "protocols/delegation_packet.md":
      "# Delegation Packet Protocol\n\nEvery task packet must include TASK, ROLE, GOAL, INPUTS, DO NOT USE, OUTPUT FORMAT, ACCEPTANCE CRITERIA, KNOWN RISKS, DEPENDENCIES, and REPORTING CHANNEL.\n",
    "protocols/review_schema.json": JSON.stringify(
      {
        review_id: "R-001",
        task_id: "T-001",
        reviewer_agent_id: "reviewer_skeptical",
        reviewer_persona: "skeptical",
        status: "pass",
        per_criterion: [
          {
            criterion: "Verbatim acceptance criterion",
            verdict: "pass",
            citations: [{ artifact_id: "ART-001", line_start: 1, line_end: 3 }],
            rationale: "Cited lines satisfy the criterion.",
            confidence: 0.9
          }
        ],
        identified_issues: [],
        free_form_assessment: "",
        malformed: false,
        truncated: false,
        created_at: "2026-05-08T00:00:00.000Z"
      },
      null,
      2
    ),
    "protocols/consensus_schema.json": JSON.stringify(
      {
        consensus_records: [
          {
            consensus_id: "C-001",
            task_id: "T-001",
            review_ids: ["R-001", "R-002"],
            reviewer_count: 2,
            per_criterion: [
              {
                criterion: "Verbatim acceptance criterion",
                pass_count: 2,
                fail_count: 0,
                unverifiable_count: 0,
                abstain_count: 0,
                verdict: "pass",
                convergent_citations: [{ artifact_id: "ART-001", line_start: 2, line_end: 3 }],
                dissent: []
              }
            ],
            overall_verdict: "pass",
            is_load_bearing: true,
            created_at: "2026-05-08T00:00:00.000Z"
          }
        ]
      },
      null,
      2
    ),
    "protocols/debate_protocol.md":
      "# Debate Protocol\n\nUse controlled rooms with a fixed number of rounds. Each debate must end with a decision record, captured dissent, and unresolved risks.\n",
    "protocols/human_approval_packet.md":
      "# Human Approval Packet\n\nInclude the decision needed, recommended option, alternatives, evidence, risks, cost/time impact, what approval does, what rejection does, and the exact action requiring approval.\n",
    "protocols/escalation_protocol.md":
      "# Escalation Protocol\n\nEscalate when lower-tier attempts fail, ambiguity remains, severe defects appear, or the cost of being wrong exceeds the cost of stronger review.\n",
    "protocols/metrics_protocol.md":
      "# Metrics Protocol\n\nTrack model calls, local commands, dry runs, task outcomes, approvals, cost estimates, and rework.\n"
  };
}

function instructionTemplates(): Record<string, string> {
  return {
    "instructions/orchestrator.md":
      "# Orchestrator Agent\n\nConvert user intent into a Prompt Contract, task graph, deployment plan, decision log, and approval gates. Assign work only to registered agents.\n",
    "instructions/planner.md":
      "# Planner Agent\n\nBreak objectives into bounded workstreams, tasks, dependencies, and acceptance criteria.\n",
    "instructions/researcher.md":
      "# Research Agent\n\nGather scoped facts and cite inputs. Do not perform external actions beyond the granted permissions.\n",
    "instructions/builder.md":
      "# Builder Agent\n\nProduce the requested artifact from the scoped context packet and acceptance criteria.\n",
    "instructions/reviewer.md":
      "# Reviewer Agent\n\nReview artifacts independently using the artifact, acceptance criteria, relevant constraints, and test output only.\n",
    "instructions/red_team.md":
      "# Red-Team Agent\n\nFind failure modes, abuse cases, brittle assumptions, and security gaps.\n",
    "instructions/browser_agent.md":
      "# Browser Agent\n\nBrowser automation is future work in this MVP. Hosted web search is available only to model agents with web_search in allowed_tools. External actions require explicit approval.\n",
    "instructions/synthesizer.md":
      "# Synthesizer Agent\n\nIntegrate verified outputs, review records, decisions, approvals, and metrics into a final deliverable.\n"
  };
}
