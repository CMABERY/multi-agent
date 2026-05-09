import { z } from "zod";

export const ExecutorTypeSchema = z.enum(["model_agent", "local_command", "dry_run"]);
export const ModelTierSchema = z.enum(["low", "mid", "high"]);
export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export const ReviewerPersonaSchema = z.enum([
  "default",
  "skeptical",
  "completeness",
  "rigor",
  "adversarial"
]);
export const TaskStatusSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "blocked",
  "completed",
  "failed",
  "approved"
]);

export const AgentSchema = z
  .object({
    agent_id: z.string().min(1),
    role: z.string().min(1),
    executor_type: ExecutorTypeSchema,
    model_tier: ModelTierSchema.optional(),
    model: z.string().min(1).optional(),
    reviewer_persona: ReviewerPersonaSchema.optional(),
    allowed_tools: z.array(z.string()).default([]),
    command_allowlist: z.array(z.string()).default([]),
    permissions: z.object({
      external_actions: z.boolean(),
      destructive_actions: z.boolean(),
      credential_access: z.boolean(),
      paid_actions: z.boolean(),
      public_actions: z.boolean()
    }),
    max_cost_usd: z.number().nonnegative().optional(),
    performance: z
      .object({
        tasks_assigned: z.number().int().nonnegative(),
        tasks_completed: z.number().int().nonnegative(),
        tasks_failed: z.number().int().nonnegative(),
        review_passes: z.number().int().nonnegative(),
        review_failures: z.number().int().nonnegative(),
        dry_run_deliverable_mismatches: z.number().int().nonnegative(),
        average_score_contribution: z.number().nonnegative(),
        known_failure_modes: z.array(z.string())
      })
      .optional()
  })
  .superRefine((agent, context) => {
    if (agent.role.includes("Reviewer") && !agent.reviewer_persona) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewer_persona"],
        message: "reviewer_persona is required for Reviewer agents"
      });
    }
  });

export const AgentRegistrySchema = z.object({
  agents: z.array(AgentSchema)
});

export const IntentSchema = z.object({
  intent_id: z.string().regex(/^I-\d{3,}$/),
  text: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  risk_level: RiskLevelSchema.default("medium"),
  budget: z.string().optional(),
  status: z.enum(["new", "planned", "approved", "running", "completed", "blocked"]).default("new"),
  created_at: z.string(),
  updated_at: z.string()
});

export const IntentQueueSchema = z.object({
  intents: z.array(IntentSchema)
});

export const CommandSpecSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([])
});

export const TaskSchema = z.object({
  task_id: z.string().regex(/^T-\d{3,}$/),
  title: z.string().min(1),
  owner_agent_id: z.string().min(1),
  owner_role: z.string().min(1),
  executor: ExecutorTypeSchema,
  model_tier: ModelTierSchema,
  input_context: z.array(z.string()).default([]),
  output_required: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  dependencies: z.array(z.string()).default([]),
  risk_level: RiskLevelSchema,
  review_required: z.boolean(),
  approval_required: z.boolean(),
  status: TaskStatusSchema.default("queued"),
  artifacts: z.array(z.string()).default([]),
  command: CommandSpecSchema.optional(),
  deployment_id: z.string().optional(),
  blocker: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string()
});

export const TaskBoardSchema = z.object({
  tasks: z.array(TaskSchema)
});

export const DeploymentAssignmentSchema = z.object({
  task_id: z.string().regex(/^T-\d{3,}$/),
  agent_id: z.string().min(1),
  executor: ExecutorTypeSchema,
  model_tier: ModelTierSchema,
  reason: z.string().min(1),
  approval_required: z.boolean()
});

export const DeploymentPlanSchema = z.object({
  deployment_id: z.string().regex(/^DP-\d{3,}$/),
  intent_id: z.string().regex(/^I-\d{3,}$/),
  status: z.enum(["proposed", "approved", "running", "completed", "blocked", "failed"]),
  approval_required: z.boolean(),
  approved_at: z.string().optional(),
  assignments: z.array(DeploymentAssignmentSchema).min(1),
  created_at: z.string(),
  updated_at: z.string()
});

export const DeploymentPlanStoreSchema = z.object({
  deployment_plans: z.array(DeploymentPlanSchema)
});

export const ApprovalSchema = z.object({
  approval_id: z.string().regex(/^AP-\d{3,}$/),
  deployment_id: z.string().regex(/^DP-\d{3,}$/),
  approver: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  scope: z.string().min(1),
  created_at: z.string()
});

export const ApprovalStoreSchema = z.object({
  approvals: z.array(ApprovalSchema)
});

export const ReviewIssueSchema = z.object({
  issue_id: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]),
  category: z.string().min(1),
  description: z.string().min(1),
  evidence: z.string().min(1),
  recommended_fix: z.string().min(1)
});

export const CitationSchema = z
  .object({
    artifact_id: z.string().regex(/^ART-\d{3,}$/),
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive()
  })
  .refine((citation) => citation.line_end >= citation.line_start, "line_end must be >= line_start");

export const PerCriterionVerdictSchema = z.object({
  criterion: z.string().min(1),
  verdict: z.enum(["pass", "fail", "unverifiable"]),
  citations: z.array(CitationSchema).default([]),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

export const StructuredReviewSchema = z.object({
  review_id: z.string().regex(/^R-\d{3,}$/),
  task_id: z.string().regex(/^T-\d{3,}$/),
  reviewer_agent_id: z.string().min(1),
  reviewer_persona: ReviewerPersonaSchema,
  status: z.enum(["pass", "fail", "abstain"]),
  per_criterion: z.array(PerCriterionVerdictSchema).default([]),
  identified_issues: z.array(ReviewIssueSchema).default([]),
  free_form_assessment: z.string().default(""),
  malformed: z.boolean().default(false),
  truncated: z.boolean().default(false),
  created_at: z.string()
});

export const ReviewSchema = StructuredReviewSchema;

export const ReviewLogSchema = z.object({
  reviews: z.array(ReviewSchema)
});

export const ConsensusVerdictSchema = z.object({
  criterion: z.string(),
  pass_count: z.number().int().nonnegative(),
  fail_count: z.number().int().nonnegative(),
  unverifiable_count: z.number().int().nonnegative(),
  abstain_count: z.number().int().nonnegative(),
  verdict: z.enum(["pass", "fail", "split", "unverifiable"]),
  convergent_citations: z.array(CitationSchema).default([]),
  dissent: z
    .array(
      z.object({
        review_id: z.string(),
        verdict: z.enum(["pass", "fail", "unverifiable"]),
        rationale: z.string()
      })
    )
    .default([])
});

export const ConsensusSchema = z.object({
  consensus_id: z.string().regex(/^C-\d{3,}$/),
  task_id: z.string().regex(/^T-\d{3,}$/),
  review_ids: z.array(z.string()).min(1),
  reviewer_count: z.number().int().positive(),
  per_criterion: z.array(ConsensusVerdictSchema),
  overall_verdict: z.enum(["pass", "fail", "split", "insufficient"]),
  is_load_bearing: z.boolean(),
  created_at: z.string(),
  updated_at: z.string().optional()
});

export const ConsensusStoreSchema = z.object({
  consensus_records: z.array(ConsensusSchema)
});

export const ArtifactSchema = z.object({
  artifact_id: z.string().regex(/^ART-\d{3,}$/),
  task_id: z.string().regex(/^T-\d{3,}$/),
  path: z.string().min(1),
  type: z.string().min(1),
  description: z.string().min(1),
  created_at: z.string()
});

export const ArtifactIndexSchema = z.object({
  artifacts: z.array(ArtifactSchema)
});

export const ChatStoreSchema = z.object({
  messages: z.array(
    z.object({
      message_id: z.string().regex(/^M-\d{3,}$/),
      timestamp: z.string(),
      from_agent: z.string().min(1),
      to: z.string().min(1),
      type: z.enum([
        "status",
        "blocker",
        "handoff",
        "review_request",
        "defect",
        "decision_request",
        "consensus_result",
        "final_report"
      ]),
      task_id: z.string().optional(),
      summary: z.string().min(1),
      details: z.string().default(""),
      requires_action: z.boolean().default(false),
      recommended_next_step: z.string().default("")
    })
  )
});

export const MetricsSchema = z.object({
  model_calls: z.number().int().nonnegative(),
  local_commands: z.number().int().nonnegative(),
  dry_runs: z.number().int().nonnegative(),
  tasks_completed: z.number().int().nonnegative(),
  tasks_failed: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nonnegative()
});

export const ModelConfigSchema = z.object({
  provider: z.literal("openai"),
  base_url: z.string().url(),
  api_key_env: z.string().min(1),
  default_models: z.object({
    orchestrator: z.string().min(1),
    high: z.string().min(1),
    mid: z.string().min(1),
    low: z.string().min(1)
  }),
  max_output_tokens: z.number().int().positive().default(4000),
  learning_rule_threshold: z.number().nonnegative().default(1.6),
  orchestrator_max_retries: z.number().int().nonnegative().default(2),
  learning_rule_cap: z.number().int().positive().default(10),
  performance_min_assignments: z.number().int().nonnegative().default(3),
  performance_review_pass_floor: z.number().min(0).max(1).default(0.5),
  performance_failure_rate_ceiling: z.number().min(0).max(1).default(0.5),
  pricing: z
    .record(
      z.object({
        input_per_1m_usd: z.number().nonnegative(),
        output_per_1m_usd: z.number().nonnegative()
      })
    )
    .default({})
});

export const OrchestratorTaskSchema = z.object({
  title: z.string().min(1),
  owner_agent_id: z.string().min(1),
  owner_role: z.string().min(1),
  executor: ExecutorTypeSchema,
  model_tier: ModelTierSchema,
  input_context: z.array(z.string()).default([]),
  output_required: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  dependencies: z.array(z.string()).default([]),
  risk_level: RiskLevelSchema,
  review_required: z.boolean(),
  approval_required: z.boolean(),
  command: CommandSpecSchema.optional()
});

export const OrchestratorOutputSchema = z.object({
  prompt_contract_markdown: z.string().min(1),
  tasks: z.array(OrchestratorTaskSchema).min(1),
  deployment_plan: z.object({
    approval_required: z.boolean(),
    assignments: z.array(
      z.object({
        task_id: z.string().regex(/^T-\d{3,}$/),
        agent_id: z.string().min(1),
        executor: ExecutorTypeSchema,
        model_tier: ModelTierSchema,
        reason: z.string().min(1),
        approval_required: z.boolean()
      })
    )
  }),
  decisions: z
    .array(
      z.object({
        decision: z.string().min(1),
        rationale: z.string().min(1),
        owner: z.string().min(1),
        dissent: z.string().optional()
      })
    )
    .default([])
});

export const IntelligenceIssueSchema = z.object({
  issue_id: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]),
  code: z.string().min(1),
  target: z.string().min(1),
  message: z.string().min(1),
  recommended_fix: z.string().min(1),
  created_at: z.string()
});

export const WorkflowScoreSchema = z.object({
  score_id: z.string().regex(/^WS-\d{3,}$/),
  deployment_id: z.string().regex(/^DP-\d{3,}$/),
  verified_useful_outputs: z.number().int().nonnegative(),
  consensus_pass_count: z.number().int().nonnegative().default(0),
  consensus_split_count: z.number().int().nonnegative().default(0),
  consensus_insufficient_count: z.number().int().nonnegative().default(0),
  review_pass_rate: z.number().nonnegative(),
  failed_tasks: z.number().int().nonnegative(),
  rerun_count: z.number().int().nonnegative(),
  human_interventions: z.number().int().nonnegative(),
  context_failures: z.number().int().nonnegative(),
  model_calls: z.number().int().nonnegative(),
  dry_runs: z.number().int().nonnegative(),
  workflow_intelligence_yield: z.number().nonnegative(),
  created_at: z.string(),
  updated_at: z.string().optional()
});

export const WorkflowScoreStoreSchema = z.object({
  workflow_scores: z.array(WorkflowScoreSchema)
});

export const PlanCheckSchema = z.object({
  check_id: z.string().regex(/^PC-\d{3,}$/),
  deployment_id: z.string().regex(/^DP-\d{3,}$/),
  status: z.enum(["pass", "fail"]),
  issues: z.array(IntelligenceIssueSchema),
  created_at: z.string(),
  updated_at: z.string().optional()
});

export const PlanCheckStoreSchema = z.object({
  plan_checks: z.array(PlanCheckSchema)
});

export const ContextCheckSchema = z.object({
  check_id: z.string().regex(/^CC-\d{3,}$/),
  task_id: z.string().regex(/^T-\d{3,}$/),
  status: z.enum(["pass", "fail"]),
  issues: z.array(IntelligenceIssueSchema),
  created_at: z.string(),
  updated_at: z.string().optional()
});

export const ContextCheckStoreSchema = z.object({
  context_checks: z.array(ContextCheckSchema)
});

export const LearningRuleSchema = z.object({
  rule_id: z.string().regex(/^LR-\d{3,}$/),
  trigger: z.string().min(1),
  rule: z.string().min(1),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1),
  created_at: z.string(),
  last_seen_at: z.string(),
  times_seen: z.number().int().positive(),
  sources_seen: z.array(z.string()).default([])
});

export const LearningMemorySchema = z.object({
  learning_rules: z.array(LearningRuleSchema)
});

export const RetrospectiveSchema = z.object({
  retrospective_id: z.string().regex(/^RET-\d{3,}$/),
  deployment_id: z.string().regex(/^DP-\d{3,}$/),
  path: z.string().min(1),
  learned_rule_ids: z.array(z.string()),
  created_at: z.string()
});

export const RetrospectiveIndexEntrySchema = z.object({
  retrospective_id: z.string().regex(/^RET-\d{3,}$/),
  deployment_id: z.string().regex(/^DP-\d{3,}$/),
  path: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string()
});

export const RetrospectiveIndexSchema = z.object({
  retrospectives: z.array(RetrospectiveIndexEntrySchema)
});

export const PerformanceLedgerEntrySchema = z.object({
  deployment_id: z.string().regex(/^DP-\d{3,}$/),
  agent_id: z.string().min(1),
  tasks_assigned: z.number().int().nonnegative(),
  tasks_completed: z.number().int().nonnegative(),
  tasks_failed: z.number().int().nonnegative(),
  review_passes: z.number().int().nonnegative(),
  review_failures: z.number().int().nonnegative(),
  dry_run_deliverable_mismatches: z.number().int().nonnegative(),
  known_failure_modes: z.array(z.string()),
  updated_at: z.string()
});

export const PerformanceLedgerSchema = z.object({
  entries: z.array(PerformanceLedgerEntrySchema)
});

export const BootstrapWorkTypeSchema = z.enum(["ordinary", "stateful", "architecture", "risky"]);
export const BootstrapPostureSchema = z.enum(["normal", "wide_scan", "ask_human", "governed"]);
export const BootstrapConfidenceSchema = z.enum([
  "documented",
  "code_inferred",
  "state_observed",
  "uncertain"
]);
export const BootstrapStalenessSchema = z.enum(["low", "medium", "high"]);

export const BootstrapClaimSchema = z.object({
  claim: z.string().min(1),
  source_paths: z.array(z.string()).default([]),
  command: z.string().optional(),
  confidence: BootstrapConfidenceSchema,
  staleness_risk: BootstrapStalenessSchema
});

const BootstrapArchitectureEntrySchema = z.object({
  path: z.string().min(1),
  role: z.string().min(1),
  evidence: z.string().min(1)
});

const BootstrapArchitectureSchema = z
  .object({
    entry_points: z.array(BootstrapArchitectureEntrySchema).default([]),
    key_modules: z.array(BootstrapArchitectureEntrySchema).default([])
  })
  .default({ entry_points: [], key_modules: [] });

export const BootstrapContinuitySchema = z.object({
  project: z.object({
    name: z.string(),
    description: z.string(),
    version: z.string()
  }),
  stack: z.object({
    runtime: z.string(),
    language: z.string(),
    key_deps: z.array(z.string())
  }),
  active_deployments: z.array(
    z.object({
      deployment_id: z.string(),
      status: z.string(),
      intent_id: z.string()
    })
  ),
  active_tasks: z.array(
    z.object({
      task_id: z.string(),
      status: z.string(),
      title: z.string(),
      blocker: z.string().optional()
    })
  ),
  recent_artifacts: z.array(
    z.object({
      artifact_id: z.string(),
      task_id: z.string(),
      type: z.string(),
      path: z.string()
    })
  ),
  conventions: z.object({
    has_protocols_dir: z.boolean(),
    has_instructions_dir: z.boolean(),
    has_model_config: z.boolean()
  }),
  architecture: BootstrapArchitectureSchema
});

export const BootstrapCounterContextSchema = z.object({
  git: z.object({
    present: z.boolean(),
    has_commits: z.boolean(),
    has_remote: z.boolean(),
    branch: z.string().optional(),
    dirty: z.boolean(),
    status_capped: z.boolean().default(false),
    untracked_count: z.number().int().nonnegative(),
    untracked_capped: z.boolean(),
    probe_error: z.string().optional()
  }),
  hygiene: z.object({
    has_gitignore: z.boolean(),
    dist_present: z.boolean(),
    node_modules_present: z.boolean()
  }),
  runtime_warnings: z.array(z.string()),
  drift_warnings: z.array(z.string()),
  parse_failures: z.array(
    z.object({
      path: z.string(),
      error: z.string()
    })
  ),
  not_inspected: z.array(z.string())
});

export const BootstrapPacketSchema = z.object({
  bootstrap_id: z.string().regex(/^BS-\d{3,}$/),
  created_at: z.string(),
  work_type: BootstrapWorkTypeSchema.default("ordinary"),
  posture: BootstrapPostureSchema,
  posture_reasons: z.array(z.string()),
  required_extra_review: z.array(z.string()).default([]),
  continuity: BootstrapContinuitySchema,
  counter_context: BootstrapCounterContextSchema,
  claims: z.array(BootstrapClaimSchema)
});

export const BootstrapIndexEntrySchema = z.object({
  bootstrap_id: z.string().regex(/^BS-\d{3,}$/),
  created_at: z.string(),
  posture: BootstrapPostureSchema,
  md_path: z.string(),
  json_path: z.string()
});

export const BootstrapIndexSchema = z.object({
  bootstraps: z.array(BootstrapIndexEntrySchema)
});

export const OperatorEventOutcomeSchema = z.enum(["success", "failure", "invalid", "help"]);

export const OperatorEventSchema = z.object({
  event_id: z.string().regex(/^OX-\d{3,}$/),
  created_at: z.string(),
  command: z.string().min(1),
  outcome: OperatorEventOutcomeSchema,
  next_step_applicable: z.boolean(),
  next_step_present: z.boolean(),
  recoverable_error: z.boolean(),
  recovery_success: z.boolean().default(false),
  extension_command: z.boolean(),
  workflow_state_after: z.string().optional()
});

export const OperatorPendingRecoverySchema = z.object({
  corrective_family: z.string().optional(),
  next_family: z.string().optional(),
  recorded_at: z.string()
});

export const OperatorExperienceSchema = z.object({
  started_at: z.string(),
  updated_at: z.string(),
  events: z.array(OperatorEventSchema).default([]),
  pending_recovery: OperatorPendingRecoverySchema.nullable().default(null),
  first_successful_deployment_at: z.string().nullable().default(null),
  first_complete_workflow_at: z.string().nullable().default(null)
});

export type Agent = z.infer<typeof AgentSchema>;
export type AgentRegistry = z.infer<typeof AgentRegistrySchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type IntentQueue = z.infer<typeof IntentQueueSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskBoard = z.infer<typeof TaskBoardSchema>;
export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;
export type DeploymentAssignment = z.infer<typeof DeploymentAssignmentSchema>;
export type DeploymentPlanStore = z.infer<typeof DeploymentPlanStoreSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalStore = z.infer<typeof ApprovalStoreSchema>;
export type ReviewerPersona = z.infer<typeof ReviewerPersonaSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type PerCriterionVerdict = z.infer<typeof PerCriterionVerdictSchema>;
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type StructuredReview = z.infer<typeof StructuredReviewSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type ConsensusVerdict = z.infer<typeof ConsensusVerdictSchema>;
export type Consensus = z.infer<typeof ConsensusSchema>;
export type ConsensusStore = z.infer<typeof ConsensusStoreSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactIndex = z.infer<typeof ArtifactIndexSchema>;
export type Metrics = z.infer<typeof MetricsSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type OrchestratorOutput = z.infer<typeof OrchestratorOutputSchema>;
export type ModelTier = z.infer<typeof ModelTierSchema>;
export type IntelligenceIssue = z.infer<typeof IntelligenceIssueSchema>;
export type WorkflowScore = z.infer<typeof WorkflowScoreSchema>;
export type WorkflowScoreStore = z.infer<typeof WorkflowScoreStoreSchema>;
export type PlanCheck = z.infer<typeof PlanCheckSchema>;
export type PlanCheckStore = z.infer<typeof PlanCheckStoreSchema>;
export type ContextCheck = z.infer<typeof ContextCheckSchema>;
export type ContextCheckStore = z.infer<typeof ContextCheckStoreSchema>;
export type LearningRule = z.infer<typeof LearningRuleSchema>;
export type LearningMemory = z.infer<typeof LearningMemorySchema>;
export type Retrospective = z.infer<typeof RetrospectiveSchema>;
export type RetrospectiveIndexEntry = z.infer<typeof RetrospectiveIndexEntrySchema>;
export type RetrospectiveIndex = z.infer<typeof RetrospectiveIndexSchema>;
export type PerformanceLedgerEntry = z.infer<typeof PerformanceLedgerEntrySchema>;
export type PerformanceLedger = z.infer<typeof PerformanceLedgerSchema>;
export type BootstrapWorkType = z.infer<typeof BootstrapWorkTypeSchema>;
export type BootstrapPosture = z.infer<typeof BootstrapPostureSchema>;
export type BootstrapConfidence = z.infer<typeof BootstrapConfidenceSchema>;
export type BootstrapStaleness = z.infer<typeof BootstrapStalenessSchema>;
export type BootstrapClaim = z.infer<typeof BootstrapClaimSchema>;
export type BootstrapContinuity = z.infer<typeof BootstrapContinuitySchema>;
export type BootstrapCounterContext = z.infer<typeof BootstrapCounterContextSchema>;
export type BootstrapPacket = z.infer<typeof BootstrapPacketSchema>;
export type BootstrapIndexEntry = z.infer<typeof BootstrapIndexEntrySchema>;
export type BootstrapIndex = z.infer<typeof BootstrapIndexSchema>;
export type OperatorEventOutcome = z.infer<typeof OperatorEventOutcomeSchema>;
export type OperatorEvent = z.infer<typeof OperatorEventSchema>;
export type OperatorPendingRecovery = z.infer<typeof OperatorPendingRecoverySchema>;
export type OperatorExperience = z.infer<typeof OperatorExperienceSchema>;
