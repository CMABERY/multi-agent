import { describe, expect, test } from "vitest";
import {
  AcceptanceCriteriaOutputSchema,
  AgentSchema,
  CalibrationRecordSchema,
  EnforcementStateSchema,
  GraderDescriptorSchema,
  GraderIdSchema,
  GraderOutputSchema,
  GraderRegistryEntrySchema,
  GraderRegistrySchema,
  IntentOutputSchema,
  OutputQualityOutputSchema,
  ProbationLogSchema,
  ProbationRecordSchema,
  ReviewReasoningOutputSchema,
  ReviewerCalibrationOutputSchema,
  ReviewerStateSchema
} from "../src/schemas.js";

describe("grader subsystem schemas", () => {
  test("GraderIdSchema accepts allowed grader ids and rejects others", () => {
    expect(GraderIdSchema.parse("reviewer_calibration")).toBe("reviewer_calibration");
    expect(GraderIdSchema.parse("acceptance_criteria")).toBe("acceptance_criteria");
    expect(GraderIdSchema.parse("intent")).toBe("intent");
    expect(GraderIdSchema.parse("review_reasoning")).toBe("review_reasoning");
    expect(GraderIdSchema.parse("output_quality")).toBe("output_quality");
    expect(() => GraderIdSchema.parse("dependency_usefulness")).toThrow();
  });

  test("EnforcementStateSchema enumerates the five enforcement states", () => {
    expect(EnforcementStateSchema.parse("calibrating")).toBe("calibrating");
    expect(EnforcementStateSchema.parse("enforced")).toBe("enforced");
    expect(() => EnforcementStateSchema.parse("not_a_state")).toThrow();
  });

  test("ReviewerStateSchema enumerates shadow, probation, full", () => {
    expect(ReviewerStateSchema.parse("shadow")).toBe("shadow");
    expect(ReviewerStateSchema.parse("probation")).toBe("probation");
    expect(ReviewerStateSchema.parse("full")).toBe("full");
    expect(() => ReviewerStateSchema.parse("retired")).toThrow();
  });

  test("GraderOutputSchema validates the common envelope and rejects bad ids", () => {
    const valid = {
      grader_output_id: "GO-1",
      grader: "intent",
      grader_version: "0.1.0",
      subject: { intent_id: "I-001" },
      provisional_thresholds: true,
      shadow_only: false,
      created_at: "2026-05-09T00:00:00Z"
    };
    const parsed = GraderOutputSchema.parse(valid);
    expect(parsed.decision_reason).toEqual([]);
    expect(parsed.recheck_triggers).toEqual([]);

    const invalid = { ...valid, grader_output_id: "GOO-1" };
    expect(() => GraderOutputSchema.parse(invalid)).toThrow();
  });

  test("ReviewerCalibrationOutputSchema round-trips a valid payload", () => {
    const payload = {
      grader_output_id: "GO-12",
      grader: "reviewer_calibration",
      grader_version: "0.1.0",
      subject: { reviewer_id: "reviewer_alpha" },
      provisional_thresholds: true,
      shadow_only: false,
      created_at: "2026-05-09T00:00:00Z",
      decision: "promote_to_full",
      metrics: {
        gold_cases_seen: 60,
        shared_cases_seen: 80,
        dissent_cases_seen: 10,
        gold_issue_hit_rate: 0.81,
        gold_high_severity_hit_rate: 0.92,
        gold_false_positive_rate: 0.1,
        post_retro_correctness: 0.88,
        agreement_lower_ci: 0.7,
        dissent_precision: 0.66,
        ECE: 0.08,
        Brier: 0.12
      }
    };
    const parsed = ReviewerCalibrationOutputSchema.parse(payload);
    expect(parsed.decision).toBe("promote_to_full");

    const invalid = { ...payload, decision: "ascend" };
    expect(() => ReviewerCalibrationOutputSchema.parse(invalid)).toThrow();
  });

  test("AcceptanceCriteriaOutputSchema validates the per-criterion envelope", () => {
    const payload = {
      grader_output_id: "GO-2",
      grader: "acceptance_criteria",
      grader_version: "0.1.0",
      subject: { task_id: "T-001", criterion_index: 0 },
      provisional_thresholds: true,
      shadow_only: false,
      created_at: "2026-05-09T00:00:00Z",
      criterion_citation: "The system must respond within 200ms under nominal load.",
      grade: "weak",
      missing_element: "threshold",
      dimension_scores: {
        observable_oracle: "pass",
        trigger_action_clarity: "weak",
        context_precondition_sufficiency: "pass",
        reference_threshold_grounding: "weak",
        atomicity: "pass",
        edge_case_decidability: "weak"
      },
      suggested_rewrite: "Specify the load profile and percentile target."
    };
    const parsed = AcceptanceCriteriaOutputSchema.parse(payload);
    expect(parsed.dimension_scores.observable_oracle).toBe("pass");

    const invalid = { ...payload, grade: "okay" };
    expect(() => AcceptanceCriteriaOutputSchema.parse(invalid)).toThrow();
  });

  test("IntentOutputSchema validates ready/nudge/refuse and rejects bad grades", () => {
    const payload = {
      grader_output_id: "GO-3",
      grader: "intent",
      grader_version: "0.1.0",
      subject: { intent_id: "I-001" },
      provisional_thresholds: true,
      shadow_only: false,
      created_at: "2026-05-09T00:00:00Z",
      grade: "ready",
      scope_clarity: "pass",
      success_condition_present: "pass",
      ambient_context_sufficiency: "pass",
      decomposition_readiness: "pass",
      risk_or_policy_sensitivity: "low"
    };
    const parsed = IntentOutputSchema.parse(payload);
    expect(parsed.suggested_decomposition).toEqual([]);
    expect(parsed.refinement_questions).toEqual([]);

    const invalid = { ...payload, grade: "absolutely_ready" };
    expect(() => IntentOutputSchema.parse(invalid)).toThrow();
  });

  test("ReviewReasoningOutputSchema accepts a strong rationale", () => {
    const payload = {
      grader_output_id: "GO-4",
      grader: "review_reasoning",
      grader_version: "0.1.0",
      subject: { review_id: "R-001", criterion_index: 1 },
      provisional_thresholds: true,
      shadow_only: false,
      created_at: "2026-05-09T00:00:00Z",
      verdict_under_review: "fail",
      rationale_grade: "strong",
      citation_alignment: {
        score: 0.92,
        label: "fully_supported",
        unsupported_claims: []
      },
      specificity: {
        score: 0.8,
        label: "specific",
        generic_phrases: []
      }
    };
    const parsed = ReviewReasoningOutputSchema.parse(payload);
    expect(parsed.citation_alignment.label).toBe("fully_supported");

    const invalid = { ...payload, rationale_grade: "shrug" };
    expect(() => ReviewReasoningOutputSchema.parse(invalid)).toThrow();
  });

  test("OutputQualityOutputSchema validates the quality vector envelope", () => {
    const payload = {
      grader_output_id: "GO-5",
      grader: "output_quality",
      grader_version: "0.1.0",
      subject: { artifact_id: "ART-001", task_id: "T-001", agent_id: "builder_1" },
      provisional_thresholds: true,
      shadow_only: false,
      created_at: "2026-05-09T00:00:00Z",
      artifact_type: "plan",
      quality_vector: {
        completeness: 0.8,
        faithfulness_to_spec: 0.9,
        evidence_density: 0.6,
        sequencing_validity: 0.85,
        risk_validation_coverage: 0.7,
        functional_correctness: 0.0,
        defensive_coverage: 0.0,
        integration_fit: 0.0,
        maintainability: 0.0,
        coverage_critical: 0.0,
        evidence_to_claim: 0.0,
        synthesis: 0.0,
        uncertainty_handling: 0.0
      },
      aggregate: {
        method: "gated_geometric_mean",
        score: 0.78,
        hard_gate_failures: []
      },
      advisory_only_block: false
    };
    const parsed = OutputQualityOutputSchema.parse(payload);
    expect(parsed.aggregate.method).toBe("gated_geometric_mean");

    const invalid = { ...payload, artifact_type: "diagram" };
    expect(() => OutputQualityOutputSchema.parse(invalid)).toThrow();
  });

  test("GraderDescriptorSchema requires the version six-tuple fields", () => {
    const valid = {
      rubric_version: "v1",
      model_version: "gpt-x",
      prompt_version: "p1",
      gold_set_version: "g1",
      task_family: "review",
      provisional_thresholds: { gold_cases_seen: 60 }
    };
    const parsed = GraderDescriptorSchema.parse(valid);
    expect(parsed.compatibility_tags).toEqual([]);

    const invalid = { ...valid, rubric_version: undefined };
    expect(() => GraderDescriptorSchema.parse(invalid)).toThrow();
  });

  test("GraderRegistryEntrySchema and GraderRegistrySchema validate registry shape", () => {
    const entry = {
      grader_id: "intent",
      current_descriptor_id: "desc-1",
      enforcement_state: "observation_shadow"
    };
    const parsedEntry = GraderRegistryEntrySchema.parse(entry);
    expect(parsedEntry.enforcement_state).toBe("observation_shadow");

    const registry = { entries: [entry] };
    expect(GraderRegistrySchema.parse(registry).entries).toHaveLength(1);

    const invalid = { ...entry, enforcement_state: "live" };
    expect(() => GraderRegistryEntrySchema.parse(invalid)).toThrow();
  });

  test("ProbationRecordSchema and ProbationLogSchema validate probation records", () => {
    const record = {
      reviewer_id: "reviewer_alpha",
      started_at: "2026-05-09T00:00:00Z",
      adjudicated_dissent_count: 2,
      conformity_window: {
        agreement_rate: 0.7,
        correctness_rate: 0.65,
        case_count: 40
      }
    };
    expect(ProbationRecordSchema.parse(record).adjudicated_dissent_count).toBe(2);
    expect(ProbationLogSchema.parse({ records: [record] }).records).toHaveLength(1);

    const invalid = { ...record, adjudicated_dissent_count: -1 };
    expect(() => ProbationRecordSchema.parse(invalid)).toThrow();
  });

  test("CalibrationRecordSchema validates a per-grader calibration record", () => {
    const valid = {
      grader_id: "review_reasoning",
      running_statistics: { agreement_rate: 0.7 }
    };
    const parsed = CalibrationRecordSchema.parse(valid);
    expect(parsed.locked_gold_set).toEqual([]);
    expect(parsed.rolling_shadow_set).toEqual([]);

    const invalid = { ...valid, grader_id: "fictional_grader" };
    expect(() => CalibrationRecordSchema.parse(invalid)).toThrow();
  });

  test("AgentSchema accepts an existing agent without grader fields", () => {
    const agent = {
      agent_id: "builder_1",
      role: "Builder",
      executor_type: "model_agent",
      allowed_tools: [],
      command_allowlist: [],
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: []
      }
    };
    const parsed = AgentSchema.parse(agent);
    expect(parsed.reviewer_state).toBeUndefined();
    expect(parsed.reviewer_calibration).toBeUndefined();
  });

  test("AgentSchema accepts reviewer_state and reviewer_calibration when supplied", () => {
    const reviewer = {
      agent_id: "reviewer_alpha",
      role: "Reviewer",
      executor_type: "model_agent",
      reviewer_persona: "default",
      reviewer_state: "probation",
      reviewer_calibration: {
        grader_output_id: "GO-12",
        decision: "maintain_probation"
      },
      allowed_tools: [],
      command_allowlist: [],
      permissions: {
        external_actions: false,
        destructive_actions: false,
        credential_access: false,
        paid_actions: false,
        public_actions: false,
        policy_grants: []
      }
    };
    const parsed = AgentSchema.parse(reviewer);
    expect(parsed.reviewer_state).toBe("probation");
    expect(parsed.reviewer_calibration?.decision).toBe("maintain_probation");

    const invalidState = { ...reviewer, reviewer_state: "expert" };
    expect(() => AgentSchema.parse(invalidState)).toThrow();
  });
});
