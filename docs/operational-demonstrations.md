# MAW Operational Demonstration Suite

This document demonstrates how MAW is operated in practice. The operator manual is the command reference. This file is the scenario guide: it shows one complete normal run and the situational workflows an operator is likely to encounter.

All examples use PowerShell from the repository checkout at `C:\Multi-Agent`.

Do not run subcommand labels by themselves. `intent create` is not a PowerShell command. It must be invoked through MAW:

```powershell
node .\dist\src\index.js intent create --text "Build a verified demo artifact."
```

## Demonstration Ground Rules

Run demonstrations in an isolated workspace when possible. MAW reads and writes state in the current working directory, so a scratch directory prevents accidental changes to the live `state/` folder.

```powershell
cd C:\Multi-Agent
npm install
npm run build

$MawCli = "C:\Multi-Agent\dist\src\index.js"
$DemoRoot = "$env:TEMP\maw-operational-demo"
New-Item -ItemType Directory -Force $DemoRoot | Out-Null
Set-Location $DemoRoot
```

From the scratch workspace, every MAW command should use:

```powershell
node $MawCli <command>
```

Model-backed demonstrations require the environment variable named in `state/model_config.json`. The default is `OPENAI_API_KEY`.

```powershell
$env:OPENAI_API_KEY = "sk-..."
```

State-only demonstrations do not need an API key. These include `init`, `intent create`, `approval record`, `plan-check`, `context-check`, `consensus compute`, `migrate`, `score`, `retrospective`, `performance update`, `validate`, and `report`.

## Demo Index

| Situation | Demonstration |
| --- | --- |
| Normal operator path | Demo 1 |
| Fresh workspace setup | Demo 2 |
| Intent capture variants | Demo 3 |
| Approval required before execution | Demo 4 |
| Dry-run packet only | Demo 5 |
| Dry-run incorrectly used for a deliverable | Demo 6 |
| Local command execution | Demo 7 |
| Local command blocked by missing `--execute` or allowlist | Demo 8 |
| Context is missing or unreadable | Demo 9 |
| Review and synthesis dependencies lack artifacts | Demo 10 |
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

## Demo 1: Complete Typical Workflow

This is the normal end-to-end path: create an intent, orchestrate a plan, approve it, run it, verify it, score it, learn from it, and produce a report.

Start in a fresh scratch workspace:

```powershell
Set-Location $DemoRoot
node $MawCli init
```

Expected output:

```text
Initialized multi-agent workflow workspace.
```

Create a medium-risk intent:

```powershell
node $MawCli intent create `
  --text "Create a concise operator-facing summary of the MAW verification workflow." `
  --risk medium `
  --constraint "Use only workspace-local evidence." `
  --constraint "The output must be reviewable by cited acceptance criteria."
```

Expected output:

```text
I-001
```

Ask the orchestrator to produce the prompt contract, tasks, and deployment plan:

```powershell
node $MawCli orchestrate --intent I-001
```

Expected output pattern:

```text
Created deployment DP-001 with tasks T-001, T-002.
```

If orchestration throws with pre-flight violations, go to Demo 17. Otherwise inspect the proposed plan:

```powershell
node $MawCli plan-check --deployment DP-001
node $MawCli report
```

If `plan-check` reports high-severity issues, do not approve yet. Fix the upstream cause or re-orchestrate after adjusting the intent or registry.

Approve the deployment:

```powershell
node $MawCli approval record `
  --deployment DP-001 `
  --approver "operator" `
  --scope "Run DP-001 exactly as proposed by the orchestrator."
```

Expected output:

```text
AP-001
```

Run the deployment:

```powershell
node $MawCli run --deployment DP-001
```

Expected output pattern:

```text
Completed: T-001, T-002
```

For review-required deliverables, `run` also spawns structured reviewers and computes consensus. Medium-risk review-required tasks receive two reviewers. High-risk review-required tasks receive three.

Compute score, retrospective, performance memory, and validation:

```powershell
node $MawCli score --deployment DP-001
node $MawCli retrospective --deployment DP-001
node $MawCli performance update --deployment DP-001
node $MawCli validate
node $MawCli report
```

Successful completion means:

- The deployment status is `completed`.
- Review-required deliverables have load-bearing consensus.
- `workflow_score.json` has been refreshed.
- `learning_memory.json` has been updated from plan and context defects.
- `agent_registry.json` contains updated performance data when the deployment produced ledger entries.
- `validate` either passes or reports issues that the operator explicitly accepts as expected historical state.

## Demo 2: Fresh Workspace Setup

Use this when starting a new workspace or repairing missing default files.

```powershell
Set-Location $DemoRoot
node $MawCli init
node $MawCli validate
```

Expected output:

```text
Initialized multi-agent workflow workspace.
Workflow state is valid.
```

Inspect the default files:

```powershell
Get-ChildItem state
Get-ChildItem artifacts
Get-Content state\agent_registry.json
Get-Content state\model_config.json
```

The fresh registry should include:

- `orchestrator_1`
- `researcher_1`
- `builder_1`
- `reviewer_skeptical`
- `reviewer_completeness`
- `reviewer_rigor`

The three reviewer agents are important. High-risk review-required tasks need three distinct reviewer personas.

## Demo 3: Intent Capture Variants

Use `intent create` to record operator intent before planning. Intent records preserve risk, constraints, and budget.

Low-risk packet-only intent:

```powershell
node $MawCli intent create `
  --text "Create a delegation packet for a future implementation only." `
  --risk low `
  --constraint "Do not produce the implementation."
```

Medium-risk normal deliverable:

```powershell
node $MawCli intent create `
  --text "Draft a verified operating checklist for reviewers." `
  --risk medium `
  --budget "Keep estimated model cost below 1 USD."
```

High-risk intent:

```powershell
node $MawCli intent create `
  --text "Analyze a high-risk deployment decision and produce a reviewable recommendation." `
  --risk high `
  --constraint "Require independent review." `
  --constraint "Every acceptance criterion must be evidence-checkable."
```

Inspect the queue:

```powershell
Get-Content state\intent_queue.json | ConvertFrom-Json | Select-Object -ExpandProperty intents
```

Operator decision:

- Use `low` only when mistakes have low consequence.
- Use `medium` for normal deliverables.
- Use `high` when the output should require stronger independent verification.

## Demo 4: Approval Required Before Execution

Plans commonly require approval. If the operator tries to run before approval, MAW blocks execution.

```powershell
node $MawCli run --deployment DP-001
```

Expected failure pattern:

```text
Deployment DP-001 requires explicit approval before execution.
```

Record approval:

```powershell
node $MawCli approval record `
  --deployment DP-001 `
  --approver "operator" `
  --scope "Run DP-001 after plan-check review."
```

Then run:

```powershell
node $MawCli run --deployment DP-001
```

To reject instead:

```powershell
node $MawCli approval record `
  --deployment DP-001 `
  --approver "operator" `
  --scope "Reject until routing is corrected." `
  --decision rejected
```

A rejected deployment is set to `blocked`. Re-orchestrate or repair state before approval.

## Demo 5: Dry-Run Packet Only

Dry-run is valid for delegation packets and task packets. It is not valid for real deliverables.

Create an explicit packet-only intent:

```powershell
node $MawCli intent create `
  --text "Create a delegation packet only for a future documentation implementation." `
  --risk low `
  --constraint "The output is only a packet, not the final documentation."
node $MawCli orchestrate --intent I-001
node $MawCli plan-check --deployment DP-001
node $MawCli approval record `
  --deployment DP-001 `
  --approver "operator" `
  --scope "Emit packet-only output."
node $MawCli run --deployment DP-001
```

Expected artifact:

```text
artifacts/runs/T-001/delegation_packet.md
```

Expected score behavior:

```powershell
node $MawCli score --deployment DP-001
```

Packet-only tasks can complete, but they are not automatically verified useful outputs unless they are review-required and receive passing consensus.

## Demo 6: Dry-Run Incorrectly Used For A Deliverable

If a task asks for a real deliverable but the assignment uses `dry_run`, plan-check reports `DRY_RUN_DELIVERABLE`.

Run:

```powershell
node $MawCli plan-check --deployment DP-001
```

Failure pattern:

```text
HIGH DRY_RUN_DELIVERABLE T-001: Task T-001 requires a deliverable but is routed to dry_run.
Fix: Route deliverable tasks to model_agent or local_command; reserve dry_run for packet generation.
```

Operator response:

1. Do not approve the deployment.
2. Clarify the intent if the expected output is only a packet.
3. Re-orchestrate if the output is a real deliverable.
4. Confirm the corrected assignment uses `model_agent` or `local_command`.

This defect is high severity. During orchestration, B.1 pre-flight should reject the invalid plan before it is persisted and retry automatically.

## Demo 7: Local Command Execution

Local commands require explicit approval, an allowlisted command, and the `--execute` flag.

A valid local-command task needs:

- An agent whose `executor_type` is `local_command`.
- The command in that agent's `command_allowlist`.
- A task `command` block with `command` and `args`.
- A deployment assignment using `executor: "local_command"`.
- An approval record.

Before running:

```powershell
node $MawCli plan-check --deployment DP-001
```

Approve:

```powershell
node $MawCli approval record `
  --deployment DP-001 `
  --approver "operator" `
  --scope "Run the allowlisted local command in DP-001."
```

Execute:

```powershell
node $MawCli run --deployment DP-001 --execute
```

Expected artifacts:

```text
artifacts/runs/<task_id>/command_output.txt
artifacts/runs/<task_id>/command_error.txt
artifacts/runs/<task_id>/command_result.json
```

If the command exits with code `0`, MAW registers a `command_output` artifact. If it exits nonzero, the task is marked failed and the blocker is recorded.

## Demo 8: Local Command Blocked By Policy

Two common local-command failures are missing `--execute` and missing allowlist entries.

Without `--execute`:

```powershell
node $MawCli run --deployment DP-001
```

Failure pattern:

```text
Local command task T-001 requires --execute.
```

With a command not in the agent allowlist:

```powershell
node $MawCli plan-check --deployment DP-001
```

Failure pattern:

```text
HIGH LOCAL_COMMAND_NOT_ALLOWLISTED T-001/node: Command node is not allowlisted for shell_1.
```

Operator response:

- Add the command to the intended local-command agent only if it is safe.
- Route the task to a different allowlisted agent if available.
- Do not widen permissions or command allowlists casually.
- Re-run `plan-check` before approval.

## Demo 9: Context Is Missing Or Unreadable

Run a context check before executing a task that depends on local files or upstream artifacts.

```powershell
node $MawCli context-check --task T-001
```

Missing file pattern:

```text
HIGH CONTEXT_FILE_MISSING state/input.md: Context file is missing or unreadable: state/input.md.
Fix: Create the context file or remove it from input_context.
```

Path escape pattern:

```text
HIGH CONTEXT_PATH_ESCAPES_WORKSPACE ../secret.txt: Context path escapes workspace: ../secret.txt.
Fix: Use a workspace-relative context path.
```

Operator response:

1. Keep task context paths workspace-relative.
2. Create missing context files or remove bad references.
3. Re-run `context-check`.
4. Only continue when high-severity context issues are gone.

JSON output is useful for automation:

```powershell
node $MawCli context-check --task T-001 --json
```

## Demo 10: Review Or Synthesis Dependency Lacks Artifacts

Review and synthesis tasks need dependency artifacts to inspect. If a dependency did not produce an indexed artifact, context and plan checks block the route.

Plan-check pattern:

```text
HIGH REVIEW_DEPENDENCY_ARTIFACT_MISSING T-003/T-001: Review/synthesis task T-003 lacks artifact context from dependency T-001.
Fix: Ensure every dependency produces an indexed artifact before reviewer/synthesizer execution.
```

Context-check pattern:

```text
HIGH DEPENDENCY_ARTIFACT_MISSING T-001: Dependency T-001 has no indexed artifacts.
Fix: Add a model/command output artifact for the dependency before continuing.
```

Operator response:

- Run or rerun the dependency task first.
- Confirm `artifacts/artifact_index.json` contains an artifact for the dependency.
- Confirm the artifact path exists on disk.
- Re-run `context-check` for the review or synthesis task.

## Demo 11: Structured Review And Consensus Verification

For review-required deliverables, `run` automatically spawns structured reviewers after the deliverable task completes. Reviewer count follows risk:

- Low: 1 reviewer
- Medium: 2 reviewers
- High: 3 reviewers

Inspect reviews:

```powershell
Get-Content state\review_log.json | ConvertFrom-Json | Select-Object -ExpandProperty reviews
```

Inspect consensus:

```powershell
node $MawCli consensus compute --task T-001 --json
```

A passing consensus requires:

- Each criterion resolves to `pass`.
- Reviewers cite evidence.
- Multi-reviewer tasks have overlapping cited ranges.
- No reviewer fails the criterion with valid citations.
- Enough non-abstaining reviewers participated for the task risk level.

Score after consensus:

```powershell
node $MawCli score --deployment DP-001
```

Expected verified score pattern for a genuinely verified deliverable:

```text
Verified Useful Outputs: 1
Consensus Pass Count: 1
Consensus Split Count: 0
Consensus Insufficient Count: 0
```

If score remains zero, inspect:

```powershell
node $MawCli consensus compute --task T-001 --json
Get-Content state\review_log.json
Get-Content artifacts\artifact_index.json
```

## Demo 12: Rubber-Stamp Reviews Do Not Verify Output

A review that says `pass` without citations is not enough. This is the core honest-verification behavior.

Failure pattern in consensus:

```json
{
  "criterion": "The deliverable includes a citable result.",
  "pass_count": 3,
  "fail_count": 0,
  "unverifiable_count": 0,
  "verdict": "fail",
  "convergent_citations": []
}
```

Score pattern:

```text
Verified Useful Outputs: 0
Consensus Pass Count: 0
```

Operator response:

- Treat citation-free pass reviews as malformed evidence, not success.
- Rerun reviewers with line-numbered dependency artifacts available.
- Confirm reviewer JSON includes one `per_criterion` entry per acceptance criterion.
- Confirm every pass verdict includes at least one citation.
- For medium/high risk, confirm cited ranges overlap across reviewers.

## Demo 13: Legacy Review Migration

Pre-v0.3 review records were flat enum reviews. Migration converts them to structured abstentions. It does not promote old pass enums into verified content.

Run migration:

```powershell
node $MawCli migrate
```

Expected output:

```text
Migrated 17 legacy reviews.
```

Re-run migration to verify idempotency:

```powershell
node $MawCli migrate
```

Expected output:

```text
Migrated 0 legacy reviews.
```

Refresh score and performance:

```powershell
node $MawCli score --deployment DP-001
node $MawCli performance update --deployment DP-001
```

Expected consequence:

- Legacy review records become `status: "abstain"`.
- `malformed` is `true`.
- Consensus becomes `insufficient`.
- `verified_useful_outputs` can fall to `0`.

This is intended. It means MAW no longer treats unverified enum reviews as content verification.

## Demo 14: Score And Rerun Interpretation

Score is computed from state and written to `state/workflow_score.json`.

```powershell
node $MawCli score --deployment DP-001
node $MawCli score --deployment DP-001 --json
```

Important fields:

- `verified_useful_outputs`: review-required tasks with load-bearing pass consensus.
- `consensus_pass_count`: load-bearing consensus pass records.
- `consensus_split_count`: load-bearing consensus split records.
- `consensus_insufficient_count`: load-bearing consensus insufficient records.
- `rerun_count`: repeated primary deliverable artifacts for the same task.
- `human_interventions`: approval records and manual review interventions.
- `context_failures`: persisted context-check failures.
- `workflow_intelligence_yield`: verified useful outputs divided by penalty-adjusted work.

Rerun count includes primary deliverable artifact types:

- `model_output`
- `command_output`
- `delegation_packet`

Rerun count excludes reviewer-derived artifacts:

- `review_evidence`
- `structured_review`

Operator interpretation:

- A high model-call count with zero verified outputs indicates wasted orchestration or failed verification.
- A high rerun count indicates repeated task execution.
- A high split count indicates reviewer disagreement.
- A high insufficient count indicates review participation or parsing failures.

## Demo 15: Retrospective And Learning Memory

Retrospective turns plan/context defects into learning rules and refreshes performance memory.

Run durable checks first:

```powershell
node $MawCli plan-check --deployment DP-001
node $MawCli context-check --task T-001
```

Then run retrospective:

```powershell
node $MawCli retrospective --deployment DP-001
```

Expected output:

```text
Retrospective RET-001
Path: artifacts/retrospectives/RET-001.md
Learned Rules: LR-001
```

Inspect learning memory:

```powershell
Get-Content state\learning_memory.json | ConvertFrom-Json | Select-Object -ExpandProperty learning_rules
```

Active rules are injected into future orchestrator prompts when:

```text
confidence * times_seen >= learning_rule_threshold
```

Default threshold:

```text
1.6
```

Operator response:

- If a defect repeats, expect its rule to become active.
- If a rule conflicts with the intent, fix the upstream plan shape or registry.
- Do not delete learning rules casually; they are the orchestrator's memory of past failures.

## Demo 16: Performance-Aware Routing

Performance memory is stored on agents after `performance update`.

```powershell
node $MawCli performance update --deployment DP-001 --json
```

Inspect a populated agent:

```powershell
(Get-Content state\agent_registry.json | ConvertFrom-Json).agents |
  Where-Object { $_.performance -ne $null } |
  Select-Object agent_id, role, executor_type, performance
```

The next orchestration input includes a performance suffix for agents with assignment history:

```text
assigned=4 completed=2 failed=2 reviews=1/3 dry_run_mismatches=1
```

Performance gates:

- `LOW_REVIEW_PASS_RATE_FOR_RISK`: high-risk task assigned to an agent below `performance_review_pass_floor`.
- `HIGH_FAILURE_RATE_AGENT`: medium/high-risk task assigned to an agent above `performance_failure_rate_ceiling`.

Default thresholds in `state/model_config.json`:

```json
{
  "performance_min_assignments": 3,
  "performance_review_pass_floor": 0.5,
  "performance_failure_rate_ceiling": 0.5
}
```

Operator response:

- For high-risk work, route to agents with better review pass history.
- For medium/high-risk work, avoid agents with high task failure rates.
- Cold-start agents are not gated until they meet the minimum assignment threshold.

## Demo 17: Orchestrator Pre-Flight Retries

The orchestrator validates proposed plans before persistence. High-severity plan-check issues trigger retry.

Common retry triggers:

- `DRY_RUN_DELIVERABLE`
- `EXECUTOR_REGISTRY_MISMATCH`
- `HIGH_RISK_REVIEW_MISSING`
- `INSUFFICIENT_REVIEWERS`
- `NO_DELIVERABLE_ARTIFACT`
- `LOCAL_COMMAND_MISSING`
- `LOCAL_COMMAND_NOT_ALLOWLISTED`
- `LOW_REVIEW_PASS_RATE_FOR_RISK`
- `HIGH_FAILURE_RATE_AGENT`

Run orchestration:

```powershell
node $MawCli orchestrate --intent I-001
```

Success after retry still persists the corrected plan:

```text
Created deployment DP-001 with tasks T-001, T-002.
```

Inspect decisions:

```powershell
Get-Content state\decision_log.md
```

Expected synthetic decision pattern:

```text
Revised orchestrator plan to address pre-flight violations
Auto-revision after 1 retry(ies). Resolved triggers: DRY_RUN_DELIVERABLE.
```

If retries are exhausted:

```text
Orchestrator could not produce a valid plan after 2 retries. Final violations: DRY_RUN_DELIVERABLE.
```

Operator response:

1. Confirm the intent remains `status: "new"`.
2. Confirm no new deployment plan was persisted.
3. Fix the upstream cause.
4. Re-run `orchestrate`.

Useful inspections:

```powershell
Get-Content state\intent_queue.json
Get-Content state\task_board.json
Get-Content state\deployment_plan.json
```

## Demo 18: Failed Deployment Recovery

When a deployment fails, MAW records blockers and leaves state available for inspection.

Inspect status:

```powershell
node $MawCli report
Get-Content state\chat.json
Get-Content state\task_board.json
```

Run targeted checks:

```powershell
node $MawCli plan-check --deployment DP-001
node $MawCli context-check --task T-001
```

Common causes and fixes:

| Cause | Fix |
| --- | --- |
| Missing approval | Run `approval record` with an exact approved scope |
| Missing context file | Create the workspace-relative file or remove the path |
| Dependency not ready | Run the dependency first |
| Dependency artifact missing | Regenerate dependency output |
| Local command missing `--execute` | Re-run with `--execute` after approval |
| Command not allowlisted | Route differently or safely update allowlist |
| Model API error | Fix API key, quota, or model config |
| Reviewer output malformed | Rerun reviewers through the task execution path |

After fixing:

```powershell
node $MawCli run --deployment DP-001 --rerun
node $MawCli score --deployment DP-001
node $MawCli retrospective --deployment DP-001
node $MawCli performance update --deployment DP-001
```

Rerun intentionally. Repeated primary deliverable artifacts are counted in `rerun_count`.

## Demo 19: Validation And Expected Legacy Failures

Validation checks schema and cross-file references.

```powershell
node $MawCli validate
```

Clean output:

```text
Workflow state is valid.
```

Common issue pattern after legacy migration:

```text
TASK_REVIEW_MISSING: Task T-001 is completed but lacks passing load-bearing consensus
```

Operator interpretation:

- For old DP-001 style data, this can be expected historical state.
- For a new deployment, this means a completed review-required task has not passed honest verification.

Investigate:

```powershell
node $MawCli consensus compute --task T-001 --json
node $MawCli score --deployment DP-001 --json
Get-Content state\review_log.json
```

Fix options:

- Rerun the task and its structured reviewers.
- Repair malformed structured review data only if you have valid evidence.
- Accept the validation issue only when documenting historical legacy state.

## Demo 20: Operator Handoff Package

Use this when handing the workspace to another operator or closing a run.

```powershell
node $MawCli report > handoff-report.md
node $MawCli score --deployment DP-001 --json > handoff-score.json
node $MawCli plan-check --deployment DP-001 --json > handoff-plan-check.json
node $MawCli validate > handoff-validate.txt
```

If validation writes errors to stderr, capture both streams:

```powershell
node $MawCli validate *> handoff-validate.txt
```

The handoff should state:

- Intent ID and deployment ID.
- Approval scope and approver.
- Completed tasks and failed tasks.
- Artifact paths for final deliverables.
- Review-required tasks and consensus verdicts.
- Workflow score and rerun count.
- Plan-check and context-check issues.
- Learning rules created by retrospective.
- Any expected validation failures.

## Situation Reference

### When `orchestrate` Fails

Check:

```powershell
Get-Content state\intent_queue.json
Get-Content state\learning_memory.json
Get-Content state\agent_registry.json
Get-Content state\model_config.json
```

Likely causes:

- Missing API key.
- Model returned invalid JSON.
- Model repeatedly proposed a high-severity invalid plan.
- Registry lacks required agents or reviewer personas.
- Performance gates reject the proposed routing.

Action:

- Fix registry, intent, model config, or learning-rule conflict.
- Re-run `orchestrate`.
- Do not manually mark the intent planned unless state has a valid plan.

### When `plan-check` Fails

Check the issue code and recommended fix:

```powershell
node $MawCli plan-check --deployment DP-001 --json
```

Action:

- High severity: do not approve.
- Medium severity: decide whether the risk is acceptable, then document it.
- Re-run after repair.

### When `run` Fails

Check:

```powershell
node $MawCli report
Get-Content state\chat.json
Get-ChildItem artifacts\runs -Recurse
```

Action:

- Fix the blocker.
- Re-run with `--rerun`.
- Score and run retrospective after recovery.

### When Consensus Is `insufficient`

Check:

```powershell
node $MawCli consensus compute --task T-001 --json
Get-Content state\review_log.json
Get-ChildItem artifacts\runs\T-001
```

Likely causes:

- Reviewer JSON failed to parse.
- Reviewer response was truncated.
- Too few non-abstaining reviewers participated.
- Legacy reviews migrated to abstentions.

Action:

- Rerun the review-producing task path.
- Increase model output token limit if truncation recurs.
- Confirm reviewer personas are present for the risk tier.

### When Consensus Is `split`

Check per-criterion dissent:

```powershell
node $MawCli consensus compute --task T-001 --json
```

Action:

- Inspect cited artifact lines.
- Decide whether the deliverable needs edits.
- Rerun the deliverable and reviewers after correction.
- Do not count split consensus as verified.

### When Score Is Lower Than Expected

Check:

```powershell
node $MawCli score --deployment DP-001 --json
node $MawCli consensus compute --task T-001 --json
node $MawCli context-check --task T-001 --json
```

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

## Completion Checklist

A run is operationally complete when the operator has run:

```powershell
node $MawCli plan-check --deployment DP-001
node $MawCli run --deployment DP-001
node $MawCli score --deployment DP-001
node $MawCli retrospective --deployment DP-001
node $MawCli performance update --deployment DP-001
node $MawCli validate
node $MawCli report
```

And has confirmed:

- Approval was recorded before execution.
- Failed tasks are either fixed or explicitly accepted.
- Review-required deliverables have load-bearing consensus.
- Rubber-stamp reviews are not counted as verified.
- Score reflects expected reruns and interventions.
- Learning memory and performance memory were refreshed.
- Any remaining validation issue is documented.
