# Grader Architecture And Design Spec

This document is the load-bearing design artifact for the Grader agent class proposed for MAW. It is written before any code lands. Its purpose is to resolve the seven architectural and numerical questions raised against the buildable Grader Specs (draft v1, 2026-05-09) so that implementation can begin against a fixed contract instead of a moving one.

For the conceptual frame and the gap analysis behind these graders, see [project-overview-and-capability-insight.md](project-overview-and-capability-insight.md). For the existing decision points each grader gates, the source of truth is the modules referenced inline below.

Every threshold, weight, and numeric gate in this document is provisional. Provisional values are marked with the suffix (provisional). Provisional values must not be enforced in production code until the enforcement-readiness contract in section 7 is satisfied.

## 1. Scope And Non-Goals

### 1.1 Scope

This document fixes:

- The role boundary between Grader, Reviewer, Consensus, and Scorer.
- The gate, owned signal, output schema, decision flip, and integration points for each of the five graders selected for build (Reviewer-Calibration, Acceptance-Criteria, Intent, Review-Reasoning, Output-Quality).
- The cross-cutting design decisions that the seven open catches forced: provisional-threshold convention, probationary dissent attribution, Output-Quality versus Reviewer reconciliation, shadow-mode semantics, versioning and fallback, cost and sampling, statistical power.
- The new state files, schemas, and existing module touchpoints.
- The enforcement-readiness contract under which a provisional threshold becomes load-bearing.
- The build sequence and the dependency edges between graders.

### 1.2 Non-Goals

This document does not:

- Audit the empirical citations behind threshold defaults. That is Track A and runs in parallel.
- Specify the prompts, judge models, or rubric texts used inside each grader. Those live next to the implementation.
- Resolve Grader 6 (Dependency-Usefulness). It remains deferred per the prior judgment and is reconsidered only after the first four graders run for ninety days.
- Prescribe a UI or operator console surface for graders. That is the next layer once the ledger contract is stable.

## 2. Role Boundaries

MAW already separates verification into three bounded roles. Graders are added as a fourth, narrower role.

- Reviewer. Emits pass, fail, or abstain on a single criterion against a rubric, with cited evidence. Implemented in [../src/reviews.ts](../src/reviews.ts).
- Consensus. Aggregates reviewer verdicts and validates citations structurally. Marks one consensus per task as load-bearing. Implemented in [../src/consensus.ts](../src/consensus.ts).
- Scorer. Numbers the workflow as a whole. Implemented in [../src/scoring.ts](../src/scoring.ts).
- Grader (this document). Emits a graded judgment on exactly one dimension, against an explicit reference or rubric, for exactly one gate. A Grader is not a Reviewer with numbers. A Grader is a single-purpose gate component. The decoration test applies: if the Grader is removed, at least one production decision must change. If no production decision changes, the Grader is commentary and must not be built.

The taxonomy concession is durable and must be repeated when defending the architecture externally. MAW's Grader is closest to a reference-grounded, rubric-conditioned, direct-assessment LLM judge. The published literature does not use the word Grader for this role. We use it intentionally and narrowly.

## 3. The Five Graders

Each grader subsection fixes the gate, the owned signal, the output schema, the decision flip, the integration points in existing MAW modules, the new state required, and the provisional thresholds.

### 3.1 Reviewer-Calibration Grader

Gate: reviewer registry promotion. The promotion site is the reviewer record in state/agent_registry.json, written by [../src/scaffold.ts](../src/scaffold.ts) and consumed load-bearingly by [../src/consensus.ts](../src/consensus.ts).

Owned signal: whether a reviewer has earned load-bearing vote weight. No existing role owns this. Today, [../src/scaffold.ts](../src/scaffold.ts) admits a reviewer directly into load-bearing rotation.

Output schema:

    {
      "grader_output_id": "GO-...",
      "grader": "reviewer_calibration",
      "grader_version": "...",
      "subject": { "reviewer_id": "..." },
      "decision": "promote_to_full | maintain_probation | demote_to_shadow",
      "decision_reason": ["..."],
      "metrics": {
        "gold_cases_seen": 0,
        "shared_cases_seen": 0,
        "dissent_cases_seen": 0,
        "gold_issue_hit_rate": 0.0,
        "gold_high_severity_hit_rate": 0.0,
        "gold_false_positive_rate": 0.0,
        "post_retro_correctness": 0.0,
        "agreement_lower_ci": 0.0,
        "dissent_precision": 0.0,
        "ECE": 0.0,
        "Brier": 0.0
      },
      "expires_at": "...",
      "recheck_triggers": ["..."],
      "provisional_thresholds": true,
      "shadow_only": false,
      "created_at": "..."
    }

Decision flip:

- promote_to_full sets reviewer_state to full in agent_registry.json. Full reviewers' votes are admitted to consensus by [../src/consensus.ts](../src/consensus.ts) without modification.
- maintain_probation keeps reviewer_state at probation. Probationary votes are admitted to consensus but do not contribute to load-bearing aggregation. See section 4.2 for the exact attribution rule.
- demote_to_shadow sets reviewer_state to shadow. Shadow votes are recorded but not surfaced to consensus aggregation at all.

Integration points:

- New field reviewer_state on the reviewer agent record. Allowed values: shadow, probation, full. Default for newly scaffolded reviewers: probation.
- New field reviewer_calibration on the reviewer agent record holding the latest grader_output_id and decision summary.
- [../src/consensus.ts](../src/consensus.ts) reads reviewer_state when computing per-criterion verdicts and overall verdict (see section 4.2).
- [../src/scaffold.ts](../src/scaffold.ts) sets reviewer_state to probation on creation and never to full directly.

Provisional thresholds for promote_to_full:

- gold_cases_seen at least 60 (provisional)
- shared_cases_seen at least 80 (provisional)
- dissent_cases_seen at least 10 (provisional, with the protocol in section 4.2)
- gold_issue_hit_rate at least 0.80 (provisional)
- gold_high_severity_hit_rate at least 0.90 (provisional)
- gold_false_positive_rate at most 0.15 (provisional)
- dissent_precision at least 0.65 (provisional)
- ECE at most 0.10 (provisional)
- agreement_lower_ci at least the value defined in the operative gold-set descriptor (provisional)

Recheck triggers (any one demotes to probation):

- rolling high-severity hit rate below 0.85 over the last forty cases (provisional)
- dissent-precision lower CI below 0.50 after at least ten recent dissents (provisional)
- ECE above 0.15 for two consecutive calibration windows (provisional)
- post-retro false-negative spike above baseline plus two standard errors (provisional)
- conformity collapse: agreement rises while gold correctness falls (see section 4.2 for the operative definition)
- material change to rubric_version or model_version

Calibration data requirement: a two-tier gold set per section 4.5.

Statistical-power note: promotion thresholds are subject to section 4.7 (statistical power for promotion gates). The minimum gold_cases_seen is set by the binomial-CI requirement in 4.7, not by the provisional 60 above.

### 3.2 Acceptance-Criteria Grader

Gate: approval. Decision site is [../src/approvals.ts](../src/approvals.ts), which already requires a current passing plan-check. The grader extends plan-check, not approval directly.

Owned signal: per-criterion verifiability, distinct from grammatical validity, length, or word-list match. Today, [../src/planCheck.ts](../src/planCheck.ts) lines 436 to 452 use a regex against a small word list and a length floor and emit VAGUE_ACCEPTANCE_CRITERIA at medium severity.

Output schema (per criterion in a task):

    {
      "grader_output_id": "GO-...",
      "grader": "acceptance_criteria",
      "grader_version": "...",
      "subject": { "task_id": "...", "criterion_index": 0 },
      "criterion_citation": "<exact quoted text>",
      "grade": "pass | weak | fail",
      "missing_element": "oracle | context | trigger | actor | threshold | reference | decomposition | none",
      "dimension_scores": {
        "observable_oracle": "pass | weak | fail",
        "trigger_action_clarity": "pass | weak | fail",
        "context_precondition_sufficiency": "pass | weak | fail",
        "reference_threshold_grounding": "pass | weak | fail",
        "atomicity": "pass | weak | fail",
        "edge_case_decidability": "pass | weak | fail"
      },
      "suggested_rewrite": "...",
      "provisional_thresholds": true,
      "shadow_only": false,
      "created_at": "..."
    }

Decision flip: emit a high-severity plan-check issue (new code ACCEPTANCE_CRITERIA_NOT_VERIFIABLE) when any of the following are true. The high-severity issue blocks approval through the existing plan-check path.

- observable_oracle is fail
- reference_threshold_grounding is fail and the criterion contains a comparative, quality, performance, security, or compliance claim
- atomicity is fail and any subclaim is itself unverifiable
- the criterion is grammatically valid but cannot be converted to any predicate form
- total dimension score below 8 of 12 (provisional, where pass equals 2, weak equals 1, fail equals 0)

Integration points:

- [../src/planCheck.ts](../src/planCheck.ts) calls the grader for each acceptance criterion. The existing regex check is retained as a fast prefilter for shallow cases.
- The new high-severity code ACCEPTANCE_CRITERIA_NOT_VERIFIABLE replaces the medium VAGUE_ACCEPTANCE_CRITERIA when the grader fires. The medium remains as a fallback for the regex-only path.
- Grader output is persisted in state/grader_outputs/acceptance_criteria/ keyed by deployment and task.

Provisional thresholds: all of the above. The 8 of 12 floor is provisional.

Calibration data requirement: at least 150 expert-labeled criteria stratified by failure mode (missing-oracle, weak-evaluative, comparative-without-baseline, quantifier-ambiguity, scope-ambiguity).

Empirical-claim dependency: this grader's design treats missing-oracle as automatic high-severity and refuses to fail on passive voice alone. Both decisions cite Frattini 2024 and Gentili in the source brief. Both citations are unverified at the time of writing. See section 7 for the gating that prevents enforcement until citations are audited.

### 3.3 Intent Grader

Gate: orchestration. Decision site is intent-to-plan transition in the orchestrate command. Today, createIntent only validates the risk-level enum and non-empty text.

Owned signal: whether an intent has the operational substrate for downstream planning. No existing role owns this.

Output schema:

    {
      "grader_output_id": "GO-...",
      "grader": "intent",
      "grader_version": "...",
      "subject": { "intent_id": "..." },
      "grade": "ready | nudge | refuse_to_plan",
      "scope_clarity": "pass | weak | fail",
      "success_condition_present": "pass | weak | fail",
      "ambient_context_sufficiency": "pass | weak | fail",
      "decomposition_readiness": "pass | weak | fail",
      "risk_or_policy_sensitivity": "low | medium | high",
      "suggested_decomposition": ["..."],
      "refinement_questions": ["..."],
      "provisional_thresholds": true,
      "shadow_only": false,
      "created_at": "..."
    }

Decision flip:

- refuse_to_plan blocks orchestration. Orchestration emits a structured operator recovery packet (Error, Why, State Safety, Corrective Command, Then) routing the operator to intent refinement.
- nudge allows orchestration to proceed, attaches the refinement questions to the resulting plan as advisory notes, and surfaces them in the plan-check output.
- ready allows orchestration to proceed with no advisory.

Refuse-to-plan triggers:

- success_condition_present is fail
- scope_clarity is fail and the domain is broad enough that multiple incompatible plans are plausible
- ambient_context_sufficiency is fail for at least one critical input (target system, user group, compliance constraint, approval authority)
- risk_or_policy_sensitivity is high and the intent text touches security, privacy, legal, safety, money, or destructive operations

Integration points:

- The orchestrate command calls the grader before generating the prompt contract.
- A new state file state/grader_outputs/intent/ keyed by intent_id holds outputs.
- intent records gain a grader_output_id field.

Provisional thresholds: the refuse-to-plan triggers above are themselves provisional. Calibration data is sparse for intent-quality predictors; see section 4.7 and 7.

Calibration data requirement: at least 60 expert-labeled intents stratified by failure mode (vague-goal, scope-explosion, missing-success-criterion, hidden-policy-trap, undecomposable-as-stated).

### 3.4 Review-Reasoning Grader

Gate: consensus inclusion of an individual review. Decision site is [../src/consensus.ts](../src/consensus.ts), specifically the same path taken today by validateReviewCitations at lines 86 to 110.

Owned signal: whether reviewer reasoning is grounded in its citations versus only adjacent to them. Today, citations are validated for existence, ownership, and line range, but rationale text is uninspected. Two reviewers citing the same lines for different reasons register as agreement under the line-range overlap definition of convergent_citations.

Output schema (one per reviewed criterion in a review):

    {
      "grader_output_id": "GO-...",
      "grader": "review_reasoning",
      "grader_version": "...",
      "subject": { "review_id": "...", "criterion_index": 0 },
      "verdict_under_review": "pass | fail | warn | abstain",
      "rationale_grade": "strong | adequate | weak | invalid",
      "citation_alignment": {
        "score": 0.0,
        "label": "fully_supported | partially_supported | relevant_but_insufficient | unsupported | contradicted",
        "unsupported_claims": ["..."]
      },
      "specificity": {
        "score": 0.0,
        "label": "specific | somewhat_specific | generic | vacuous",
        "generic_phrases": ["..."]
      },
      "abstain_reason": "...",
      "provisional_thresholds": true,
      "shadow_only": false,
      "created_at": "..."
    }

Decision flip: rewrite the per-criterion entry of the underlying review to status abstain through the same path malformed citations already take in [../src/consensus.ts](../src/consensus.ts). Triggers:

- citation_alignment.label is unsupported or contradicted
- citation_alignment.score below 0.60 (provisional)
- specificity.label is vacuous
- rationale_grade is invalid
- the rationale contains no extractable claim

Do not abstain solely for partial support. If the issue is minor and the core verdict is supported, emit rationale_grade adequate or weak and require a rewrite on next pass.

Integration points:

- [../src/consensus.ts](../src/consensus.ts) calls the grader on each per_criterion entry of each non-abstaining review during validateReviewCitations or a parallel function with the same write semantics.
- Grader output is persisted in state/grader_outputs/review_reasoning/ keyed by review_id.
- The convergent_citations computation in [../src/consensus.ts](../src/consensus.ts) is augmented to also require the underlying rationales to share at least one decomposed claim. See section 4.3 for the reconciliation rule against existing line-overlap convergence.

Provisional thresholds: 0.60 alignment floor; vacuous-specificity flip; the claim-decomposition method itself.

Calibration data requirement: the eight slices named in the source brief (valid-citation-unsupported-rationale, valid-citation-vague-rationale, same-citation-different-rationale, relevant-but-insufficient, contradicted, hallucinated-specificity, code-semantic-support, plan-or-spec-artifacts).

### 3.5 Output-Quality Grader

Gate: performance memory updates and workflow score weighting. Decision sites are [../src/performance.ts](../src/performance.ts) lines 88 to 103 and [../src/scoring.ts](../src/scoring.ts) lines 64 to 95.

Owned signal: a multi-dimensional quality vector per artifact, distinguishing barely-passing from exemplary. Today, performance memory only counts review_passes; scoring counts pass-or-fail.

This grader's authority is bounded explicitly to avoid collision with Reviewer. See section 4.3 for the reconciliation rule. In summary: Reviewer owns the binary spec-faithfulness verdict. Output-Quality owns the quality vector and the agent-routing demotion. Output-Quality may not block a deliverable that Reviewer passed, except in the narrow case named in 4.3.

Output schema:

    {
      "grader_output_id": "GO-...",
      "grader": "output_quality",
      "grader_version": "...",
      "subject": { "artifact_id": "...", "task_id": "...", "agent_id": "..." },
      "artifact_type": "plan | code | report",
      "quality_vector": {
        "completeness": 0.0,
        "faithfulness_to_spec": 0.0,
        "evidence_density": 0.0,
        "sequencing_validity": 0.0,
        "risk_validation_coverage": 0.0,
        "functional_correctness": 0.0,
        "defensive_coverage": 0.0,
        "integration_fit": 0.0,
        "maintainability": 0.0,
        "coverage_critical": 0.0,
        "evidence_to_claim": 0.0,
        "synthesis": 0.0,
        "uncertainty_handling": 0.0
      },
      "aggregate": {
        "method": "gated_geometric_mean",
        "score": 0.0,
        "hard_gate_failures": ["..."]
      },
      "advisory_only_block": false,
      "provisional_thresholds": true,
      "shadow_only": false,
      "created_at": "..."
    }

Per-artifact-type aggregation (provisional):

- Plan. Hard gate: faithfulness_to_spec at least 0.75 and no critical obligation omitted. Otherwise, weighted geometric mean over completeness, faithfulness_to_spec, evidence_density, sequencing_validity, risk_validation_coverage.
- Code. Aggregate is the minimum of three components: hard gate on faithfulness_to_spec, hard gate on functional_correctness, weighted score over defensive_coverage, integration_fit, and maintainability. Maintainability or style never compensates for failing correctness.
- Report. Hard gate: faithfulness at least 0.80 and coverage_critical equal to 1.0. Otherwise, 0.35 times faithfulness plus 0.30 times coverage plus 0.20 times evidence_to_claim plus 0.10 times synthesis plus 0.05 times uncertainty_handling.

Geometric mean is used over arithmetic mean to prevent one strong dimension compensating for one weak one. Provisional.

Decision flip:

- Update the agent's quality vector in performance memory. This is always live; it is not gated by Reviewer.
- Demote the agent's vote weight or routing eligibility for the matching artifact type when the rolling quality vector falls below the routing floor (provisional).
- Re-weight workflow_intelligence_yield to honor quality, not just pass count, using the quality_weighted_yield formula in section 4.3.
- Block a deliverable only under the narrow Reviewer-reconciliation condition in section 4.3. Otherwise the block is advisory and is recorded with advisory_only_block set true.

Integration points:

- [../src/performance.ts](../src/performance.ts) reads grader output to populate a new quality_vector field on the agent performance record.
- [../src/scoring.ts](../src/scoring.ts) consumes quality_vector to compute quality_weighted_yield alongside the existing workflow_intelligence_yield.
- [../src/planCheck.ts](../src/planCheck.ts) uses agent quality_vector when evaluating routing fit, in addition to the existing review-pass-rate and failure-rate floors.

Goodhart-resistance rules (mandatory, not provisional):

- evidence_density scores sufficiency and relevance of citations, never count.
- completeness is scored against extracted obligations only, never against generic checklist items.
- faithfulness requires claim-to-artifact-behavior mapping, not lexical overlap with spec.
- defensive_coverage requires mutation tests or adversarial cases, never shallow exception handling.
- routing scores are accompanied by hidden canaries and post-hoc outcome checks to detect agents learning grader preferences.

Calibration data requirement: at least 40 expert-graded artifacts per type, including adversarial gaming examples.

## 4. Cross-Cutting Design Decisions

These resolve the seven catches.

### 4.1 Provisional-Threshold Convention

Every numeric threshold, weight, and aggregation parameter named in section 3 is provisional unless this document states otherwise.

A provisional threshold:

- Must appear in the grader's output JSON as part of a provisional_thresholds true flag, alongside a thresholds_version string keying into a frozen descriptor in state/grader_descriptors/.
- Must not be enforced in any decision flip until the enforcement-readiness contract in section 7 is satisfied.
- Must be clearly distinguished in the grader registry from non-provisional values.

Non-provisional values in this document:

- The role boundary between Grader, Reviewer, Consensus, Scorer.
- The four allowed decision-flip primitives: block, demote, abstain, route_away.
- The Goodhart-resistance rules in 3.5.
- The reviewer state machine values shadow, probation, full.
- The shadow-mode operational semantics in 4.4.
- The reconciliation rule between Output-Quality and Reviewer in 4.3.
- The probationary dissent attribution protocol in 4.2.
- The versioning fallback hierarchy in 4.5.

Provisional values include all the named percentages, ratios, sample sizes, and weights.

### 4.2 Probationary Dissent Attribution Protocol

This resolves the dissent-counting paradox: a probationer cannot be promoted without dissent_cases_seen reaching its threshold, but dissent has no meaning if probationer votes are excluded from consensus.

The protocol:

- Probationary reviewers' votes are admitted into consensus aggregation in a parallel ghost computation. This ghost computation includes the probationer's vote; the load-bearing computation excludes it.
- A dissent is recorded for a probationer when the probationer's per-criterion verdict differs from the load-bearing consensus verdict on the same criterion. The probationer's verdict is the dissenting one by definition; the load-bearing consensus is the reference.
- Dissent precision is computed against the post-retrospective ground truth, not against the load-bearing consensus. When the probationer dissented and the post-retro adjudication agrees with the probationer, the dissent is correct.
- Until post-retro adjudication is available, dissent precision is unestimated, not assumed wrong. The promotion gate dissent_cases_seen at least 10 is interpreted as ten adjudicated dissents, not ten raw dissents.
- A reviewer cannot exit probation without at least one full retrospective cycle producing adjudicated dissent labels. This is a structural requirement, not a numeric one.

Conformity collapse is operationalized as follows. Compute, over a rolling forty-case window for full reviewers and the same probationer, two quantities: agreement rate against the load-bearing consensus, and correctness rate against post-retro ground truth. Conformity collapse fires when the smoothed agreement rate increases by at least 0.05 while the smoothed correctness rate decreases by at least 0.05 within the same window. The agreement and correctness windows must overlap by at least twenty cases.

Shadow reviewers are graded but their votes are not included in either the load-bearing or ghost computation. Shadow exists for cold start, after demote, and as a sandbox for new rubric or model versions.

### 4.3 Output-Quality Versus Reviewer Reconciliation Rule

Reviewer is canonical for the binary spec-faithfulness verdict. Output-Quality is canonical for the quality vector and for routing demotion. Their authorities overlap on the question of whether a deliverable meets spec; this rule resolves that overlap.

Default. Output-Quality may not block a deliverable that Reviewer passed. When the Output-Quality hard gate would fire on faithfulness_to_spec, completeness, or functional_correctness, but Reviewer has already produced a load-bearing pass on the corresponding criterion, Output-Quality records advisory_only_block true and emits a high-severity grader_output but does not block downstream execution. The advisory is surfaced in the operator console and in the retrospective.

Narrow override. Output-Quality may block a Reviewer-passed deliverable only when both of the following hold:

- The Output-Quality grader cites at least one piece of evidence (file path, span, or behavior trace) that is not present in any cited reviewer rationale on the corresponding criterion.
- A meta-grader pass (a second Output-Quality call with a different model and a different judge prompt) reproduces the hard-gate failure on the same evidence.

Under the narrow override, the deliverable is held with status quality_held and an explicit consensus reopen is required. The operator console emits a recovery packet routing to either reviewer rerun or quality dispute resolution.

Performance memory and routing demotion are not subject to the reconciliation rule. Output-Quality always updates the quality vector and may demote routing eligibility regardless of Reviewer.

Score reweighting formula. quality_weighted_yield equals the sum over deliverables of artifact_quality_credit, divided by the existing scoring penalty denominator. artifact_quality_credit is zero on hard-gate fail (under the narrow override or under Output-Quality acting alone on artifacts Reviewer did not see), and otherwise base_pass_credit times q, where q is the gated geometric mean of the quality vector for that deliverable. The legacy workflow_intelligence_yield is retained alongside quality_weighted_yield, not replaced, until at least one full ninety-day shadow has run.

### 4.4 Shadow-Mode Operational Semantics

Shadow has three distinct meanings in this design and the wrong meaning at the wrong gate destroys the calibration data. The three meanings are now disambiguated.

Observation-only shadow. The grader runs and writes outputs, but no decision flip is applied. Used for the first thirty days of a grader's life after initial calibration. Allows measurement of false-block and false-pass rates against post-hoc adjudication without affecting production. Operator console surfaces the shadow grader's outputs as advisory.

Action-reversal shadow. The grader runs, writes outputs, applies its decision flip, and the system records both the decision and the counterfactual that would have applied without the grader. Used for days thirty-one through ninety. Generates the data needed to measure downstream effect on reviewer pass rate, false-block rate, and operator friction. The flip is reversed only if a configured operator-set abort condition is met (e.g., false-block rate above ten percent against gold for two consecutive weeks).

Reviewer-state shadow. The reviewer-state value shadow in agent_registry.json. Distinct from the two above. A shadow reviewer is graded; their votes are excluded from both load-bearing and ghost consensus.

The default shadow trajectory for a new grader is: observation-only for thirty days, action-reversal for sixty days, full enforcement on day ninety-one if and only if the enforcement-readiness contract in section 7 is satisfied.

A grader cannot bypass observation-only. A grader may bypass action-reversal only if its decision flip is route_away or demote and there is a designated rollback path that does not affect approval, consensus, or score persistence.

### 4.5 Versioning And Fallback Hierarchy

Calibration is addressed as the six-tuple grader_id by rubric_version by model_version by task_family by gold_set_version by prompt_version. The Cartesian product is large; most cells will be empty.

Fallback order (most specific to least). When a calibration is requested for a six-tuple that has no data, the system searches in this order and uses the first non-empty match:

1. Exact match on all six.
2. Match on the first five; prompt_version may be merged.
3. Match on grader_id, rubric_version, model_version, task_family; gold_set_version and prompt_version may be merged.
4. Match on grader_id, rubric_version, model_version; task_family may be merged when explicitly tagged compatible in the rubric descriptor.
5. Match on grader_id, rubric_version; model_version may be merged when explicitly tagged compatible.
6. No fallback. The grader emits an output with provisional_thresholds true and a warning calibration_unavailable, and the decision flip is downgraded to advisory regardless of section 4.4.

Compatibility tags between task_family values and between model_version values are explicit, narrow, and recorded in the rubric descriptor under state/grader_descriptors/. There is no implicit compatibility.

A grader's calibration may not span more than one rubric_version silently. A rubric edit resets the calibration version and re-enters observation-only shadow.

### 4.6 Cost And Sampling Policy

Each grader is one or more LLM calls per gate event. On a busy MAW deployment the multiplicative cost is real. Each grader specifies a sampling rule.

- Reviewer-Calibration. 100 percent on every reviewer admission and on every quarterly recheck. Probationary reviewers are graded on every adjudicated case during their probation window; full reviewers are graded on a deterministic-sample-by-hash 10 percent of cases plus 100 percent of recheck triggers.
- Acceptance-Criteria. 100 percent on every plan-check pass that touches a high-risk task. Deterministic-sample-by-hash 25 percent on medium-risk; 10 percent on low-risk.
- Intent. 100 percent on every intent of risk medium or high. Deterministic-sample-by-hash 25 percent on low-risk intents.
- Review-Reasoning. 100 percent on reviews of high-risk tasks. Deterministic-sample-by-hash 50 percent on medium-risk; 20 percent on low-risk.
- Output-Quality. 100 percent on review-required deliverables. Deterministic-sample-by-hash 25 percent on non-review-required deliverables.

Sampling is deterministic by hash of (artifact_id or review_id or intent_id, grader_id, rubric_version) so that reruns reproduce the same sampled set.

A skipped sample emits a grader_output with status sampled_skip and no decision flip. Its presence in the output stream is required so that downstream auditing can distinguish an unsampled case from a missing grader call.

### 4.7 Statistical Power For Promotion Gates

Promotion thresholds in section 3.1 are point estimates. They must be paired with confidence requirements to be enforceable.

- For every threshold of the form rate at least p, the corresponding requirement is that the lower bound of the 95 percent Wilson confidence interval over the observed sample must meet or exceed p.
- For thresholds of the form rate at most p, the upper bound of the 95 percent Wilson interval must be at or below p.
- Sample-size minima per threshold are computed from the desired confidence width, not asserted as round numbers. The provisional 60 gold cases is a starting point; the operative minimum for any one threshold is whatever yields a confidence width consistent with the threshold's spread to the next decision boundary (e.g., a 0.90 target with a 0.05 width to 0.85 requires more cases than a 0.80 target with a 0.10 width to 0.70).
- A threshold whose required sample size cannot be reached within a reasonable window is automatically downgraded to advisory until sufficient data accumulates. The grader emits a calibration_underpowered flag rather than failing closed.

For ECE and Brier, the equivalent requirement is reliability-diagram width. ECE under 0.10 is enforceable only when the per-bin sample size is at least the minimum named in the gold-set descriptor.

## 5. New State Files And Schemas

The following directories and files are added to the runtime layout. All are under existing ignored runtime folders.

- state/grader_descriptors/. One descriptor per grader_id by rubric_version. Holds the rubric text reference, the provisional thresholds, the compatibility tags for fallback, the gold-set pointers, and the prompt_version registry.
- state/grader_outputs/. Subdirectories per grader: acceptance_criteria, intent, review_reasoning, output_quality, reviewer_calibration. Each holds JSON outputs keyed by the relevant subject id.
- state/grader_registry.json. Active rubric_version, model_version, prompt_version per grader. Source of truth for which descriptor is current.
- state/calibration/. Per grader, the locked gold set, the rolling shadow set, and the running statistics for power and calibration drift.
- state/probation/. Per reviewer, the probation timeline, the adjudicated dissent counts, and the conformity-collapse running window.

Existing files modified:

- state/agent_registry.json. New reviewer fields reviewer_state and reviewer_calibration on reviewer agent records.
- state/consensus.json. New per-criterion-verdict optional field grader_output_id linking the Review-Reasoning grader output that flipped a review to abstain.
- state/plan_checks.json. New issue code ACCEPTANCE_CRITERIA_NOT_VERIFIABLE and a back-reference to the Acceptance-Criteria grader output.
- state/workflow_score.json. New field quality_weighted_yield alongside the existing workflow_intelligence_yield.
- state/performance_ledger.json. New field quality_vector on the per-deployment-per-agent entry.

No existing schema is removed. All additions are additive and backward-compatible at the ledger level.

## 6. Existing Module Touchpoints

The graders integrate at these specific points. Each touchpoint is named so that implementation can proceed without rediscovery.

- [../src/scaffold.ts](../src/scaffold.ts) at scaffoldReviewer. Sets reviewer_state to probation on creation. Never sets reviewer_state to full directly.
- [../src/consensus.ts](../src/consensus.ts) at validateReviewCitations and at computeConsensus. Calls Review-Reasoning grader on each per-criterion entry. Honors reviewer_state when assembling the load-bearing reviewer set, with the ghost computation per 4.2.
- [../src/planCheck.ts](../src/planCheck.ts) at hasVagueAcceptanceCriteria and collectPlanIssues. Calls Acceptance-Criteria grader for each criterion. Calls Intent grader's last output (linked from the intent record) when assessing routing fit. Reads agent quality_vector when applying routing thresholds.
- [../src/approvals.ts](../src/approvals.ts) at recordApproval. No direct grader call. Approval respects the high-severity ACCEPTANCE_CRITERIA_NOT_VERIFIABLE issue through the existing requireCurrentPassingPlanCheck path.
- [../src/performance.ts](../src/performance.ts) at updateAgentPerformance. Reads Output-Quality grader outputs and updates quality_vector.
- [../src/scoring.ts](../src/scoring.ts) at writeWorkflowScore. Computes quality_weighted_yield alongside workflow_intelligence_yield.
- The orchestrate command (entry in [../src/cli.ts](../src/cli.ts)) calls Intent grader before generating the prompt contract.

No grader writes to existing ledger files outside its own grader_output and the named additive fields. The ledger remains the source of truth; grader output is one more cited evidence stream feeding it.

## 7. Enforcement-Readiness Contract

A provisional threshold becomes load-bearing only when all of the following are satisfied for the grader containing it.

1. Empirical-citation audit. Every empirical claim used to justify a provisional threshold has been verified against its primary source. Claims attached to fabricated or unverified citations are removed; the corresponding threshold is either re-justified from a verified source or downgraded to internal observation only.
2. Calibration data lock. The locked gold set for the grader meets the size and stratification requirements named in section 3 for that grader. The gold-set descriptor is committed to state/grader_descriptors/ with a version string.
3. Statistical-power check. Per section 4.7, the operative sample size for every enforced threshold meets the Wilson-interval requirement.
4. Observation-only shadow complete. Thirty days minimum, with no outstanding calibration_underpowered flags on enforced thresholds.
5. Action-reversal shadow complete. Sixty additional days, with the false-block rate, false-pass rate, and operator-friction signal each within the descriptor's enforcement-ready band.
6. Reconciliation tested. For Output-Quality only, the narrow-override path in 4.3 has been exercised at least once on synthetic disagreement and at least once on observed disagreement, and the recovery packet flow has been operator-verified.
7. Goodhart audit. The adversarial examples named in section 3.5 (citation padding, spec-language mimicking, polished-prose-empty-content) are run against the grader; no example crosses the enforcement threshold. For graders other than Output-Quality, the grader-specific gaming patterns named in their sections are exercised similarly.

A grader that satisfies all seven exits provisional state. A grader that fails any of them remains in the previous shadow tier. There is no manual override.

The enforcement-readiness state per grader is recorded in state/grader_registry.json under enforcement_state with values calibrating, observation_shadow, action_reversal_shadow, enforcement_pending, enforced.

## 8. Build Sequence

The build order from the buildable specs draft is preserved with one parallelization note.

1. Reviewer-Calibration. Build first. Without it, the votes the other graders ride on are not load-bearing in a defended sense. Includes the reviewer_state field, the shadow-probation-full state machine, the gold and shadow set scaffolding, and the conformity-collapse computation. Calibration data accrues in parallel with the work below.
2. Acceptance-Criteria and Intent together. Both grade specifications, share the predicate-convertibility insight, and reuse the same calibration infrastructure. Build them in parallel with each other and after the gold-set scaffolding for Reviewer-Calibration is in place but does not have to be filled.
3. Review-Reasoning. Depends on a stable population of probationary-vetted reviewers from step 1 producing rationales worth grading. The grader can be coded earlier; it cannot meaningfully run until step 1 has produced the first probation cohort.
4. Output-Quality. Most operationally complex; touches the most surface area in the codebase. Depends on the reconciliation rule in 4.3 having a Reviewer pool whose verdicts are themselves trustworthy, which requires step 1 plus step 3.

Grader 6 (Dependency-Usefulness) is reconsidered after the four above complete a ninety-day shadow trajectory and post-shadow review.

## 9. Provisional Thresholds Inventory

Every threshold below is provisional and subject to section 4.1 and section 7. Implementation must not bake any of these into code without referencing the grader descriptor and respecting the provisional flag.

Reviewer-Calibration:

- gold_cases_seen at least 60
- shared_cases_seen at least 80
- dissent_cases_seen at least 10 (adjudicated, per 4.2)
- gold_issue_hit_rate at least 0.80
- gold_high_severity_hit_rate at least 0.90
- gold_false_positive_rate at most 0.15
- dissent_precision at least 0.65
- ECE at most 0.10
- agreement weight cap 15 percent of the composite score
- weight split 30 / 20 / 15 / 15 / 15 / 5
- conformity-collapse trigger plus or minus 0.05 over forty cases with twenty overlap
- demotion thresholds in 3.1

Acceptance-Criteria:

- 8 of 12 dimension floor
- pass equals 2, weak equals 1, fail equals 0 dimension scoring
- gold size at least 150

Intent:

- gold size at least 60
- the four refuse-to-plan triggers and their adjacency conditions

Review-Reasoning:

- citation_alignment.score floor 0.60
- the eight calibration slices

Output-Quality:

- plan faithfulness_to_spec hard gate 0.75
- report faithfulness hard gate 0.80, coverage_critical 1.0
- report aggregate weights 0.35 / 0.30 / 0.20 / 0.10 / 0.05
- agent quality routing floor (operative value lives in the descriptor)
- gold size at least 40 per artifact type
- geometric mean as aggregation method

Cross-cutting:

- 30-day observation-only shadow
- 60-day action-reversal shadow
- 95 percent Wilson confidence intervals
- sampling rates 100 / 25 / 10 percent by risk tier
- 45-day rolling-window half-life for shadow gold

## 10. Open Questions Deferred To Implementation

These are intentionally not resolved here. They block implementation only if revisited in the same phase.

- The exact prompt and judge model for each grader. Lives next to the implementation. Subject to prompt_version under section 4.5.
- The rubric text and weighting prose. Lives in state/grader_descriptors/ under rubric_version.
- Operator console surface for grader outputs. The console reads grader outputs already; the surface is a separate workstream.
- Whether graders should themselves be subject to consensus or single-vote. The current design treats Acceptance-Criteria, Review-Reasoning, and Output-Quality as candidates for multi-judge consensus and treats Reviewer-Calibration and Intent as single-vote. This split is provisional and revisited after the action-reversal shadow.
- Latent-truth modeling (Dawid-Skene, Raykar) as a replacement for gold-set hit rate in Reviewer-Calibration. Worth a research spike before locking the calibration design but not before the gold set itself is built.

## 11. Caveats Carried Forward

Three constraints from the buildable specs draft remain attached to this design.

- The seven prompts behind the buildable specs ran in a single rolling session, not seven independent ones. Convergence-checking across independent sessions is not available. The architectural decisions here are robust to that constraint; the empirical thresholds are not.
- The empirical-citation audit identified at least one fabrication in the source brief. Treat every empirical claim as unverified until audited, per section 7 step 1.
- The published literature on agentic memory of evaluation outcomes, reviewer probation, and multi-dimensional output evaluation is genuinely thinner than the source brief implies. Where this design assumes a literature anchor that does not exist, build internal evidence first and treat the threshold as untested until a ninety-day shadow has produced its own data.
