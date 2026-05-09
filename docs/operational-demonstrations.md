# MAW Operational Demonstration Suite

This is the scenario guide for operating MAW. Use it to practice complete workflows, common failure paths, and handoff routines.

For exact command inputs, reads, writes, and exit behavior, use [operator-manual.md](operator-manual.md). This document shows how those commands fit together during real operation.

All examples assume PowerShell and a repository checkout at C:\Multi-Agent.

Do not run MAW subcommand labels by themselves. intent create is not a PowerShell executable. Invoke it through MAW:

    node .\dist\src\index.js intent create --text "Build a verified demo artifact."

## Demonstration Setup

Run demonstrations in an isolated workspace when possible. MAW reads and writes state in the current working directory, so a scratch workspace prevents accidental changes to live state/.

Prepare the CLI:

    cd C:\Multi-Agent
    npm install
    npm run build

Prepare a scratch workspace:

    $MawCli = "C:\Multi-Agent\dist\src\index.js"
    $DemoRoot = "$env:TEMP\maw-operational-demo"
    New-Item -ItemType Directory -Force $DemoRoot | Out-Null
    Set-Location $DemoRoot

Run MAW from the scratch workspace:

    node $MawCli <command>

Model-backed demonstrations require the environment variable named in state/model_config.json. The default is OPENAI_API_KEY.

    $env:OPENAI_API_KEY = "sk-..."

State-only demonstrations do not need an API key:

- init
- intent create
- approval record
- plan-check
- context-check
- review record
- consensus compute
- migrate
- score
- retrospective
- performance update
- validate
- report
- bootstrap

## Demo Index

| Situation | Demo |
| --- | --- |
| Normal operator path | Demo 1 |
| Fresh workspace setup | Demo 2 |
| Intent capture variants | Demo 3 |
| Approval required before execution | Demo 4 |
| Dry-run packet only | Demo 5 |
| Dry-run incorrectly used for a deliverable | Demo 6 |
| Local command execution | Demo 7 |
| Local command blocked by missing --execute or allowlist | Demo 8 |
| Context is missing or unreadable | Demo 9 |
| Review or synthesis dependencies lack artifacts | Demo 10 |
| Structured review and consensus verification | Demo 11 |
| Rubber-stamp reviews do not verify output | Demo 12 |
| Legacy review migration | Demo 13 |
| Score and rerun interpretation | Demo 14 |
| Retrospective and learning memory | Demo 15 |
| Performance-aware routing | Demo 16 |
| Orchestrator pre-flight retries | Demo 17 |
| Failed deployment recovery | Demo 18 |
| Validation and expected legacy failures | Demo 19 |
| Operator handoff package | Demo 20 |
| Bootstrap session readiness | Demo 21 |

## Demo 1: Complete Typical Workflow

Purpose: run the normal path from intent to report.

Run:

    Set-Location $DemoRoot
    node $MawCli init
    node $MawCli intent create --text "Create a concise operator-facing summary of the MAW verification workflow." --risk medium --constraint "Use only workspace-local evidence." --constraint "The output must be reviewable by cited acceptance criteria."
    node $MawCli orchestrate --intent I-001
    node $MawCli plan-check --deployment DP-001
    node $MawCli report
    node $MawCli approval record --deployment DP-001 --approver "operator" --scope "Run DP-001 exactly as proposed by the orchestrator."
    node $MawCli run --deployment DP-001
    node $MawCli score --deployment DP-001
    node $MawCli retrospective --deployment DP-001
    node $MawCli performance update --deployment DP-001
    node $MawCli validate
    node $MawCli report

Expected result:

- init prints Initialized multi-agent workflow workspace.
- intent create prints I-001.
- orchestrate prints a created deployment such as DP-001 with task IDs.
- plan-check has no high-severity issues before approval.
- approval record prints AP-001.
- run prints completed task IDs or records blockers for failures.
- score, retrospective, performance update, validate, and report complete the run evidence.

Operator decision:

- If orchestrate fails with pre-flight violations, use Demo 17.
- If plan-check reports high severity, do not approve yet.
- If run fails, use Demo 18.
- If score remains zero for a review-required deliverable, use Demo 11 or Demo 12.

## Demo 2: Fresh Workspace Setup

Purpose: start a new workspace or repair missing default files.

Run:

    Set-Location $DemoRoot
    node $MawCli init
    node $MawCli validate

Inspect:

    Get-ChildItem state
    Get-ChildItem artifacts
    Get-Content state\agent_registry.json
    Get-Content state\model_config.json

Expected result:

- init prints Initialized multi-agent workflow workspace.
- validate prints Workflow state is valid.
- state/ and artifacts/ exist.
- agent_registry.json includes orchestrator_1, researcher_1, builder_1, reviewer_skeptical, reviewer_completeness, and reviewer_rigor.

Operator decision:

- If validation fails immediately, inspect pre-existing state files. init does not overwrite existing files.

## Demo 3: Intent Capture Variants

Purpose: record objectives with the right risk, constraints, and budget before planning.

Run low-risk packet-only intent:

    node $MawCli intent create --text "Create a delegation packet for a future implementation only." --risk low --constraint "Do not produce the implementation."

Run medium-risk normal deliverable intent:

    node $MawCli intent create --text "Draft a verified operating checklist for reviewers." --risk medium --budget "Keep estimated model cost below 1 USD."

Run high-risk reviewable intent:

    node $MawCli intent create --text "Analyze a high-risk deployment decision and produce a reviewable recommendation." --risk high --constraint "Require independent review." --constraint "Every acceptance criterion must be evidence-checkable."

Inspect:

    Get-Content state\intent_queue.json | ConvertFrom-Json | Select-Object -ExpandProperty intents

Operator decision:

- Use low only when mistakes have low consequence.
- Use medium for normal deliverables.
- Use high when the output needs stronger independent verification.

## Demo 4: Approval Required Before Execution

Purpose: verify that MAW blocks execution until a deployment is approved.

Run before approval:

    node $MawCli run --deployment DP-001

Expected failure:

    Deployment DP-001 requires explicit approval before execution.

Approve:

    node $MawCli approval record --deployment DP-001 --approver "operator" --scope "Run DP-001 after plan-check review."

Run after approval:

    node $MawCli run --deployment DP-001

Reject instead:

    node $MawCli approval record --deployment DP-001 --approver "operator" --scope "Reject until routing is corrected." --decision rejected

Operator decision:

- Approval scope should be exact enough for later audit.
- A rejected deployment is set to blocked. Re-orchestrate or repair state before approval.

## Demo 5: Dry-Run Packet Only

Purpose: use dry_run only for packet generation, not real deliverables.

Run:

    node $MawCli intent create --text "Create a delegation packet only for a future documentation implementation." --risk low --constraint "The output is only a packet, not the final documentation."
    node $MawCli orchestrate --intent I-001
    node $MawCli plan-check --deployment DP-001
    node $MawCli approval record --deployment DP-001 --approver "operator" --scope "Emit packet-only output."
    node $MawCli run --deployment DP-001
    node $MawCli score --deployment DP-001

Expected artifact:

    artifacts/runs/T-001/delegation_packet.md

Expected score behavior:

- Packet-only tasks can complete.
- They are not automatically verified useful outputs unless review-required and backed by passing consensus.

Operator decision:

- If the expected result is a real deliverable, do not accept dry_run routing.

## Demo 6: Dry-Run Incorrectly Used For A Deliverable

Purpose: identify and reject a plan that routes real deliverables to dry_run.

Run:

    node $MawCli plan-check --deployment DP-001

Failure pattern:

    HIGH DRY_RUN_DELIVERABLE T-001: Task T-001 requires a deliverable but is routed to dry_run.
    Fix: Route deliverable tasks to model_agent or local_command; reserve dry_run for packet generation.

Operator decision:

1. Do not approve the deployment.
2. Clarify the intent if the expected output is only a packet.
3. Re-orchestrate if the output is a real deliverable.
4. Confirm the corrected assignment uses model_agent or local_command.

## Demo 7: Local Command Execution

Purpose: run an allowlisted local command only after approval and explicit execution consent.

A valid local-command task needs:

- An agent whose executor_type is local_command.
- The command in that agent command_allowlist.
- A task command block with command and args.
- A deployment assignment using executor: "local_command".
- An approval record.

Run:

    node $MawCli plan-check --deployment DP-001
    node $MawCli approval record --deployment DP-001 --approver "operator" --scope "Run the allowlisted local command in DP-001."
    node $MawCli run --deployment DP-001 --execute

Expected artifacts:

    artifacts/runs/<task_id>/command_output.txt
    artifacts/runs/<task_id>/command_error.txt
    artifacts/runs/<task_id>/command_result.json

Operator decision:

- Exit code 0 registers a command_output artifact.
- Nonzero exit marks the task failed and records a blocker.
- Do not add broad command allowlists casually.

## Demo 8: Local Command Blocked By Policy

Purpose: recognize missing execution consent and missing allowlist entries.

Without --execute:

    node $MawCli run --deployment DP-001

Failure pattern:

    Local command task T-001 requires --execute.

With a command not in the agent allowlist:

    node $MawCli plan-check --deployment DP-001

Failure pattern:

    HIGH LOCAL_COMMAND_NOT_ALLOWLISTED T-001/node: Command node is not allowlisted for shell_1.

Operator decision:

- Add the command to the intended local-command agent only if it is safe.
- Route the task to a different allowlisted agent if available.
- Re-run plan-check before approval.

## Demo 9: Context Is Missing Or Unreadable

Purpose: catch missing local files, unsafe paths, and unreadable context before running a task.

Run:

    node $MawCli context-check --task T-001

Missing file pattern:

    HIGH CONTEXT_FILE_MISSING state/input.md: Context file is missing or unreadable: state/input.md.
    Fix: Create the context file or remove it from input_context.

Path escape pattern:

    HIGH CONTEXT_PATH_ESCAPES_WORKSPACE ../secret.txt: Context path escapes workspace: ../secret.txt.
    Fix: Use a workspace-relative context path.

Automation-friendly output:

    node $MawCli context-check --task T-001 --json

Operator decision:

1. Keep task context paths workspace-relative.
2. Create missing context files or remove bad references.
3. Re-run context-check.
4. Continue only when high-severity context issues are gone.

## Demo 10: Review Or Synthesis Dependency Lacks Artifacts

Purpose: confirm reviewers and synthesizers have dependency artifacts to inspect.

Plan-check pattern:

    HIGH REVIEW_DEPENDENCY_ARTIFACT_MISSING T-003/T-001: Review/synthesis task T-003 lacks artifact context from dependency T-001.
    Fix: Ensure every dependency produces an indexed artifact before reviewer/synthesizer execution.

Context-check pattern:

    HIGH DEPENDENCY_ARTIFACT_MISSING T-001: Dependency T-001 has no indexed artifacts.
    Fix: Add a model/command output artifact for the dependency before continuing.

Inspect:

    Get-Content artifacts\artifact_index.json
    Get-ChildItem artifacts\runs -Recurse

Operator decision:

- Run or rerun the dependency task first.
- Confirm artifacts/artifact_index.json contains an artifact for the dependency.
- Confirm the artifact path exists on disk.
- Re-run context-check for the review or synthesis task.

## Demo 11: Structured Review And Consensus Verification

Purpose: verify that review-required deliverables are accepted only through structured evidence and consensus.

Inspect reviews:

    Get-Content state\review_log.json | ConvertFrom-Json | Select-Object -ExpandProperty reviews

Inspect consensus:

    node $MawCli consensus compute --task T-001 --json

Score after consensus:

    node $MawCli score --deployment DP-001

Expected verified score pattern:

    Verified Useful Outputs: 1
    Consensus Pass Count: 1
    Consensus Split Count: 0
    Consensus Insufficient Count: 0

Passing consensus requires:

- Each criterion resolves to pass.
- Reviewers cite evidence.
- Multi-reviewer tasks have overlapping cited ranges.
- No reviewer fails the criterion with valid citations.
- Enough non-abstaining reviewers participated for the task risk level.

Operator decision:

- If score remains zero, inspect consensus JSON, review_log.json, and artifacts/artifact_index.json.

## Demo 12: Rubber-Stamp Reviews Do Not Verify Output

Purpose: show that pass without citations is not enough.

Failure pattern in consensus:

    {
      "criterion": "The deliverable includes a citable result.",
      "pass_count": 3,
      "fail_count": 0,
      "unverifiable_count": 0,
      "verdict": "fail",
      "convergent_citations": []
    }

Score pattern:

    Verified Useful Outputs: 0
    Consensus Pass Count: 0

Operator decision:

- Treat citation-free pass reviews as malformed evidence, not success.
- Rerun reviewers with line-numbered dependency artifacts available.
- Confirm reviewer JSON includes one per_criterion entry per acceptance criterion.
- Confirm every pass verdict includes at least one citation.
- For medium and high risk, confirm cited ranges overlap across reviewers.

## Demo 13: Legacy Review Migration

Purpose: convert pre-v0.3 flat review records into honest structured abstentions.

Run:

    node $MawCli migrate

Expected output:

    Migrated 17 legacy reviews.

Verify idempotency:

    node $MawCli migrate

Expected output:

    Migrated 0 legacy reviews.

Refresh derived state:

    node $MawCli score --deployment DP-001
    node $MawCli performance update --deployment DP-001

Expected consequence:

- Legacy review records become status: "abstain".
- malformed is true.
- Consensus becomes insufficient.
- verified_useful_outputs can fall to 0.

Operator decision:

- This is intended. MAW does not treat unverified enum reviews as content verification.

## Demo 14: Score And Rerun Interpretation

Purpose: understand workflow intelligence yield and rerun penalties.

Run:

    node $MawCli score --deployment DP-001
    node $MawCli score --deployment DP-001 --json

Important fields:

- verified_useful_outputs: review-required tasks with load-bearing pass consensus.
- consensus_pass_count: load-bearing consensus pass records.
- consensus_split_count: load-bearing consensus split records.
- consensus_insufficient_count: load-bearing consensus insufficient records.
- rerun_count: repeated primary deliverable artifacts for the same task.
- human_interventions: approval records and manual review interventions.
- context_failures: persisted context-check failures.
- workflow_intelligence_yield: verified useful outputs divided by penalty-adjusted work.

Rerun count includes:

- model_output
- command_output
- delegation_packet

Rerun count excludes:

- review_evidence
- structured_review

Operator decision:

- High model-call count with zero verified outputs indicates wasted orchestration or failed verification.
- High rerun count indicates repeated task execution.
- High split count indicates reviewer disagreement.
- High insufficient count indicates review participation or parsing failures.

## Demo 15: Retrospective And Learning Memory

Purpose: turn plan and context defects into future orchestration guidance.

Run durable checks first:

    node $MawCli plan-check --deployment DP-001
    node $MawCli context-check --task T-001

Run retrospective:

    node $MawCli retrospective --deployment DP-001

Expected output:

    Retrospective RET-001
    Path: state/retrospectives/RET-001.md
    Learned Rules: LR-001

Inspect learning memory:

    Get-Content state\learning_memory.json | ConvertFrom-Json | Select-Object -ExpandProperty learning_rules

Activation rule:

    confidence * times_seen >= learning_rule_threshold

Default threshold:

    1.6

Operator decision:

- If a defect repeats, expect its rule to become active.
- If a rule conflicts with the intent, fix the upstream plan shape or registry.
- Do not delete learning rules casually.

## Demo 16: Performance-Aware Routing

Purpose: refresh agent routing memory from assignment and consensus outcomes.

Run:

    node $MawCli performance update --deployment DP-001 --json

Inspect a populated agent:

    (Get-Content state\agent_registry.json | ConvertFrom-Json).agents |
      Where-Object { $_.performance -ne $null } |
      Select-Object agent_id, role, executor_type, performance

Orchestration performance suffix pattern:

    assigned=4 completed=2 failed=2 reviews=1/3 dry_run_mismatches=1

Performance gates:

- LOW_REVIEW_PASS_RATE_FOR_RISK: high-risk task assigned to an agent below performance_review_pass_floor.
- HIGH_FAILURE_RATE_AGENT: medium or high-risk task assigned to an agent above performance_failure_rate_ceiling.

Default thresholds:

    {
      "performance_min_assignments": 3,
      "performance_review_pass_floor": 0.5,
      "performance_failure_rate_ceiling": 0.5
    }

Operator decision:

- For high-risk work, route to agents with better review pass history.
- For medium and high-risk work, avoid agents with high task failure rates.
- Cold-start agents are not gated until they meet the minimum assignment threshold.

## Demo 17: Orchestrator Pre-Flight Retries

Purpose: understand why orchestration may retry or fail before persisting a plan.

Run:

    node $MawCli orchestrate --intent I-001

Common retry triggers:

- DRY_RUN_DELIVERABLE
- EXECUTOR_REGISTRY_MISMATCH
- HIGH_RISK_REVIEW_MISSING
- INSUFFICIENT_REVIEWERS
- NO_DELIVERABLE_ARTIFACT
- LOCAL_COMMAND_MISSING
- LOCAL_COMMAND_NOT_ALLOWLISTED
- LOW_REVIEW_PASS_RATE_FOR_RISK
- HIGH_FAILURE_RATE_AGENT

Success after retry:

    Created deployment DP-001 with tasks T-001, T-002.

Inspect decisions:

    Get-Content state\decision_log.md

Expected synthetic decision pattern:

    Revised orchestrator plan to address pre-flight violations
    Auto-revision after 1 retry(ies). Resolved triggers: DRY_RUN_DELIVERABLE.

Failure pattern:

    Orchestrator could not produce a valid plan after 2 retries. Final violations: DRY_RUN_DELIVERABLE.

Operator decision:

1. Confirm the intent remains status: "new".
2. Confirm no new deployment plan was persisted.
3. Fix the upstream cause.
4. Re-run orchestrate.

Useful inspections:

    Get-Content state\intent_queue.json
    Get-Content state\task_board.json
    Get-Content state\deployment_plan.json

## Demo 18: Failed Deployment Recovery

Purpose: recover from a failed run without losing audit trail.

Inspect status:

    node $MawCli report
    Get-Content state\chat.json
    Get-Content state\task_board.json

Run targeted checks:

    node $MawCli plan-check --deployment DP-001
    node $MawCli context-check --task T-001

Common causes:

| Cause | Fix |
| --- | --- |
| Missing approval | Run approval record with exact approved scope |
| Missing context file | Create the workspace-relative file or remove the path |
| Dependency not ready | Run the dependency first |
| Dependency artifact missing | Regenerate dependency output |
| Local command missing --execute | Re-run with --execute after approval |
| Command not allowlisted | Route differently or safely update allowlist |
| Model API error | Fix API key, quota, or model config |
| Reviewer output malformed | Rerun reviewers through the task execution path |

After fixing:

    node $MawCli run --deployment DP-001 --rerun
    node $MawCli score --deployment DP-001
    node $MawCli retrospective --deployment DP-001
    node $MawCli performance update --deployment DP-001

Operator decision:

- Rerun intentionally. Repeated primary deliverable artifacts are counted in rerun_count.

## Demo 19: Validation And Expected Legacy Failures

Purpose: separate real state defects from expected historical legacy outcomes.

Run:

    node $MawCli validate

Clean output:

    Workflow state is valid.

Common issue pattern after legacy migration:

    TASK_REVIEW_MISSING: Task T-001 is completed but lacks passing load-bearing consensus

Investigate:

    node $MawCli consensus compute --task T-001 --json
    node $MawCli score --deployment DP-001 --json
    Get-Content state\review_log.json

Operator decision:

- For old DP-001 style data, this can be accepted as honest historical state.
- For a new deployment, rerun the task and structured reviewers or repair malformed structured review data only when valid evidence exists.

## Demo 20: Operator Handoff Package

Purpose: produce an evidence packet for another operator or for closing a run.

Run:

    node $MawCli report > handoff-report.md
    node $MawCli score --deployment DP-001 --json > handoff-score.json
    node $MawCli plan-check --deployment DP-001 --json > handoff-plan-check.json
    node $MawCli validate > handoff-validate.txt

Capture stderr too when needed:

    node $MawCli validate *> handoff-validate.txt

Handoff should state:

- Intent ID and deployment ID.
- Approval scope and approver.
- Completed tasks and failed tasks.
- Artifact paths for final deliverables.
- Review-required tasks and consensus verdicts.
- Workflow score and rerun count.
- Plan-check and context-check issues.
- Learning rules created by retrospective.
- Any expected validation failures.

## Demo 21: Bootstrap Session Readiness

Purpose: capture deterministic session-readiness before starting work.

Run ordinary readiness:

    node $MawCli bootstrap

Run architecture readiness:

    node $MawCli bootstrap --work-type architecture

Persist packet:

    node $MawCli bootstrap --work-type architecture --persist

Machine-readable packet:

    node $MawCli bootstrap --work-type architecture --json

Posture interpretation:

- normal: continue normally.
- wide_scan: inspect posture_reasons and widen review before acting.
- governed: higher-risk work promoted a wide_scan posture; treat exit 1 as a governance gate.
- ask_human: stop and get human direction.

Architecture metadata appears under:

- continuity.architecture.entry_points
- continuity.architecture.key_modules
- ### Architecture Entry Points
- ### Key Modules

Operator decision:

- Use --persist when the readiness packet should become an audit artifact.
- Do not treat bootstrap as full static analysis.
- If governed appears for architecture or risky work, inspect posture_reasons for the governed promotion marker and original wide_scan reasons.

## Situation Reference

### When orchestrate Fails

Check:

    Get-Content state\intent_queue.json
    Get-Content state\learning_memory.json
    Get-Content state\agent_registry.json
    Get-Content state\model_config.json

Likely causes:

- Missing API key.
- Model returned invalid JSON.
- Model repeatedly proposed a high-severity invalid plan.
- Registry lacks required agents or reviewer personas.
- Performance gates reject the proposed routing.

Action:

- Fix registry, intent, model config, or learning-rule conflict.
- Re-run orchestrate.
- Do not manually mark the intent planned unless state has a valid plan.

### When plan-check Fails

Check:

    node $MawCli plan-check --deployment DP-001 --json

Action:

- High severity: do not approve.
- Medium severity: decide whether the risk is acceptable and document it.
- Re-run after repair.

### When run Fails

Check:

    node $MawCli report
    Get-Content state\chat.json
    Get-ChildItem artifacts\runs -Recurse

Action:

- Fix the blocker.
- Re-run with --rerun.
- Score and run retrospective after recovery.

### When Consensus Is Insufficient

Check:

    node $MawCli consensus compute --task T-001 --json
    Get-Content state\review_log.json
    Get-ChildItem artifacts\runs\T-001

Likely causes:

- Reviewer JSON failed to parse.
- Reviewer response was truncated.
- Too few non-abstaining reviewers participated.
- Legacy reviews migrated to abstentions.

Action:

- Rerun the review-producing task path.
- Increase model output token limit if truncation recurs.
- Confirm reviewer personas are present for the risk tier.

### When Consensus Is Split

Check:

    node $MawCli consensus compute --task T-001 --json

Action:

- Inspect cited artifact lines.
- Decide whether the deliverable needs edits.
- Rerun the deliverable and reviewers after correction.
- Do not count split consensus as verified.

### When Score Is Lower Than Expected

Check:

    node $MawCli score --deployment DP-001 --json
    node $MawCli consensus compute --task T-001 --json
    node $MawCli context-check --task T-001 --json

Likely causes:

- Consensus did not pass.
- Reruns increased penalty.
- Context failures were recorded.
- Human interventions increased penalty.
- Review-required tasks have insufficient evidence.

Action:

- Improve evidence and rerun reviews.
- Reduce avoidable reruns.
- Fix context defects before running dependent tasks.

### When Bootstrap Escalates

Check:

    node $MawCli bootstrap --work-type ordinary --json
    node $MawCli bootstrap --work-type architecture --json

Action:

- Read posture_reasons first.
- For wide_scan, inspect the source-truth or workspace-surface trigger.
- For governed, identify the original wide_scan triggers plus the governed promotion reason.
- For ask_human, stop and get direction before acting.

## Completion Checklist

Before approving:

    node $MawCli bootstrap --work-type ordinary
    node $MawCli plan-check --deployment DP-001
    node $MawCli context-check --task T-001

Before accepting a run:

    node $MawCli run --deployment DP-001
    node $MawCli score --deployment DP-001
    node $MawCli retrospective --deployment DP-001
    node $MawCli performance update --deployment DP-001
    node $MawCli validate
    node $MawCli report

Confirm:

- Approval was recorded before execution.
- Failed tasks are fixed or explicitly accepted.
- Review-required deliverables have load-bearing consensus.
- Rubber-stamp reviews are not counted as verified.
- Score reflects expected reruns and interventions.
- Learning memory and performance memory were refreshed.
- Any remaining validation issue is documented.
