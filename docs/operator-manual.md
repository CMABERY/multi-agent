# MAW Operator Manual

This is the reference manual for the MAW CLI. Use it to answer four operator questions quickly:

- What command should I run?
- What does that command read and write?
- Does it call a model?
- What should I check before continuing?

For scenario walkthroughs, use [operational-demonstrations.md](operational-demonstrations.md). This manual is the reference surface; the demonstration suite is the practice guide.

Examples use the built local CLI:

    node dist/src/index.js <command>

If the package binary is linked or installed, replace node dist/src/index.js with maw.

Do not run subcommand labels by themselves. For example, intent create is a MAW command path, not a PowerShell executable. In this checkout, run:

    node .\dist\src\index.js intent create --text "Build a verified demo artifact."

## Fast Start

Install, build, initialize, and validate:

    npm install
    npm run build
    node dist/src/index.js init
    node dist/src/index.js validate

Orient before choosing the next operation:

    node dist/src/index.js status
    node dist/src/index.js next
    node dist/src/index.js doctor

Normal workflow:

    node dist/src/index.js intent create --text "Build a verified demo artifact." --risk medium
    node dist/src/index.js orchestrate --intent I-001
    node dist/src/index.js plan-check --deployment DP-001
    node dist/src/index.js approval record --deployment DP-001 --approver "operator" --scope "Run DP-001 as proposed."
    node dist/src/index.js run --deployment DP-001
    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js retrospective --deployment DP-001
    node dist/src/index.js performance update --deployment DP-001
    node dist/src/index.js validate
    node dist/src/index.js report

Session readiness check:

    node dist/src/index.js bootstrap
    node dist/src/index.js bootstrap --work-type architecture

## Operator Map

Use this sequence for most runs:

1. init prepares local workspace files.
2. intent create records the operator objective.
3. orchestrate asks the model to produce a prompt contract, tasks, and deployment plan.
4. plan-check audits the persisted deployment plan.
5. approval record records a human decision.
6. run executes the approved deployment.
7. consensus compute refreshes verification consensus when needed.
8. score computes workflow intelligence yield.
9. retrospective turns defects into learning memory.
10. performance update refreshes routing memory.
11. validate checks state consistency.
12. report produces the current handoff view.

Use bootstrap before starting work when you need a deterministic readiness packet that combines continuity, counter-context, and posture.

## Operating Model

MAW is a local, file-backed multi-agent workflow runtime. Commands read and write JSON and Markdown under the current working directory.

Workspace directories:

- state/ stores workflow state, plans, approvals, reviews, consensus, scores, memory, and metrics.
- artifacts/ stores indexed task outputs and run artifacts.
- protocols/ stores durable protocol templates.
- instructions/ stores durable role instruction templates.
- dist/ stores built JavaScript used by CLI examples.

All commands operate on process.cwd(). Run commands from the workspace root unless you intentionally want to operate on a different workspace.

Runtime data boundaries:

- state/ and artifacts/ are local runtime data.
- dist/ and node_modules/ are generated or installed data.
- These folders are intentionally ignored by git.
- Do not stage runtime or build folders unless a future project decision explicitly changes the source-control contract.

## Prerequisites

Install and build:

    npm install
    npm run build

Model-backed commands require an API key in the environment variable named by state/model_config.json. The default is OPENAI_API_KEY.

    $env:OPENAI_API_KEY = "sk-..."

Commands that call a model:

- orchestrate
- run when any assignment uses model_agent
- automatic structured reviews spawned by run

Commands that do not require a model key:

- init
- intent create
- approval record
- review record
- consensus compute
- migrate
- validate
- score
- plan-check
- context-check
- retrospective, unless it first needs to compute missing score state
- performance update
- status
- next
- doctor
- report
- bootstrap

## Core Concepts

### IDs

MAW uses stable local IDs:

- Intents: I-001, I-002
- Deployments: DP-001, DP-002
- Tasks: T-001, T-002
- Approvals: AP-001, AP-002
- Reviews: R-001, R-002
- Consensus records: C-001, C-002
- Workflow scores: WS-001, WS-002
- Plan checks: PC-001, PC-002
- Context checks: CC-001, CC-002
- Learning rules: LR-001, LR-002
- Retrospectives: RET-001, RET-002
- Artifacts: ART-001, ART-002

### Executors

Tasks and assignments use one executor:

- model_agent: calls the configured model and stores response_output.md.
- local_command: runs an allowlisted local command only when --execute is supplied.
- dry_run: emits a delegation packet and increments dry-run metrics. It is not valid for real deliverable tasks.

### Risk Levels

Risk levels are low, medium, and high.

Risk affects reviewer fanout for review-required deliverables:

- Low risk: 1 reviewer
- Medium risk: 2 reviewers
- High risk: 3 reviewers

### Honest Verification

verified_useful_outputs is consensus-backed. It counts review-required tasks only when the load-bearing consensus record for the task has overall_verdict: "pass".

Raw manual review enum statuses are not load-bearing. review record intentionally stores malformed abstaining reviews because the CLI cannot collect the full structured evidence shape.

### Performance-Aware Routing

performance update rebuilds agent performance from state/performance_ledger.json. Review outcomes come from load-bearing consensus:

- Consensus pass increments review_passes.
- Consensus fail, split, or insufficient increments review_failures.

The orchestrator prompt surfaces performance for agents with nonzero assignment history. plan-check rejects bad risk routing with high-severity issues when thresholds are exceeded.

## Default Workspace Files

init creates missing state and artifact files. Existing files are not overwritten.

State files:

- state/intent_queue.json
- state/task_board.json
- state/deployment_plan.json
- state/agent_registry.json
- state/model_config.json
- state/chat.json
- state/review_log.json
- state/consensus.json
- state/approvals.json
- state/metrics.json
- state/workflow_score.json
- state/plan_checks.json
- state/context_checks.json
- state/learning_memory.json
- state/retrospective_index.json
- state/performance_ledger.json
- state/operator_experience.json
- state/prompt_contract.md
- state/decision_log.md

Artifact index:

- artifacts/artifact_index.json

Template directories:

- protocols/
- instructions/

Default agents in a fresh workspace:

- orchestrator_1: model agent, high tier.
- researcher_1: model agent, mid tier.
- builder_1: dry-run agent, mid tier.
- reviewer_skeptical: reviewer persona skeptical, high tier.
- reviewer_completeness: reviewer persona completeness, high tier.
- reviewer_rigor: reviewer persona rigor, high tier.

## Command Summary

| Command | Required inputs | Optional inputs | Primary writes | Model call |
| --- | --- | --- | --- | --- |
| init | none | none | default workspace files | no |
| intent create | --text | --constraint, --risk, --budget | state/intent_queue.json | no |
| orchestrate | none | --intent (defaults to active), --json | prompt contract, tasks, deployment, decisions, metrics | yes |
| plan-check | none | --deployment (defaults to active), --json | state/plan_checks.json | no |
| approval record | --approver, --scope | --deployment (defaults to active), --decision | approvals and deployment status | no |
| run | none | --deployment (defaults to active), --execute, --rerun | task and deployment state, artifacts, metrics, reviews, consensus | depends on tasks |
| context-check | none | --task (defaults to active), --json | state/context_checks.json | no |
| review record | --reviewer | --task (defaults to active), --status, --issue | state/review_log.json | no |
| consensus compute | none | --task (defaults to active), --json | state/consensus.json | no |
| migrate | none | none | review log and consensus | no |
| score | none | --deployment (defaults to active), --json | state/workflow_score.json | no |
| retrospective | none | --deployment (defaults to active), --json | retrospectives, learning memory, performance ledger | no |
| performance update | none | --deployment (defaults to active), --json | performance ledger and agent registry | no |
| status | none | none | none | no |
| next | none | --reason | none | no |
| doctor | none | none | none | no |
| validate | none | none | may migrate legacy reviews | no |
| report | none | none | none | no |
| bootstrap | none | --json, --work-type, --persist | nothing by default; state/bootstrap only with --persist | no |
| scaffold agent | --id, --role, --executor | --model-tier, --model, --max-cost, --allow-tool, --allow-command | state/agent_registry.json | no |
| scaffold reviewer | --id, --persona | --model-tier, --model, --max-cost | state/agent_registry.json | no |
| scaffold protocol | --name | --title, --body | protocols/<name>.md | no |
| scaffold command | --agent-id, --command | --role, --model-tier | state/agent_registry.json | no |
| operator metrics | none | none | none | no |

## Active Context Defaults

State-targeting commands accept their primary ID flag as optional. When --deployment, --intent, or --task is omitted, MAW resolves it from the operator state interpreter:

- --deployment defaults to the active deployment (operator state active_deployment_id).
- --intent defaults to the active intent (operator state active_intent_id).
- --task defaults to the active task (operator state active_task_id).

If no active context exists for the requested kind, MAW prints a recovery packet pointing at maw status:

    Error: No active deployment. Pass --deployment <id> or run maw status to inspect deployments.
    Why: the workspace has no active deployment to default to.
    State Safety: safe; no command was run.
    Corrective Command: maw status
    Then: maw next

Pass the explicit flag to override the default. Active-context resolution applies to: orchestrate, plan-check, run, approval record, score, retrospective, performance update, context-check, review record, and consensus compute.

Operator habit: run status or next first to confirm the active deployment, intent, or task before using the implicit form. Active context comes from the same interpreter that drives status, so the two views always agree.

## Transition Guidance

Successful human-readable commands now finish with operator transition guidance after their command-specific result:

    Workflow State: planning_needed
    Next: maw orchestrate --intent I-001
    Reason: active intent is new and has no deployment.

The guidance tells you the resulting workflow state, the next safe command, and why that command is recommended. This applies to init, intent create, orchestrate, approval record, review record, consensus compute, migrate, run, validate success, score, plan-check, context-check, retrospective, performance update, and bootstrap Markdown output.

Machine-readable --json output remains pure JSON and does not include transition guidance. report remains a handoff payload; use status or next as its navigation companion.

## Structured Recovery Packets

Expected recoverable failures print a structured recovery packet instead of a bare error. The packet uses these labels:

- Error
- Why
- State Safety
- Corrective Command
- Then

Unknown or unclassified failures still print the concise error message so MAW does not invent unsafe repair advice.

Missing approval example:

    Error: Deployment DP-001 requires explicit approval before execution.
    Why: DP-001 requires approval and no approved approval record exists.
    State Safety: safe; execution did not start.
    Corrective Command: maw plan-check --deployment DP-001
    Then: maw approval record --deployment DP-001 --approver "operator" --scope "Run DP-001 after plan-check review."

Missing API key example:

    Error: Missing OpenAI API key environment variable: OPENAI_API_KEY
    Why: model-backed commands require the configured environment variable.
    State Safety: safe; the model request did not run.
    Corrective Command: $env:OPENAI_API_KEY = "sk-..."
    Then: maw next

Local command execute-gate example:

    Error: Local command task T-001 requires --execute.
    Why: local command execution is gated by an explicit operator flag.
    State Safety: safe; local command did not run.
    Corrective Command: maw run --deployment DP-001 --execute
    Then: maw status

## Command Reference

### Global Help And Version

Commands:

    node dist/src/index.js --help
    node dist/src/index.js --version
    node dist/src/index.js help <command>

Inputs:

- --help: optional. Prints command help.
- --version: optional. Prints CLI version.
- help <command>: optional command path such as intent, intent create, or score.

State effects: none.

Exit behavior:

- Help and version exit successfully.

### status

Purpose: summarize where the operator is in the workflow and what command is safe to run next.

Command:

    node dist/src/index.js status

Inputs: none.

Reads:

- Existing workflow state files.

Writes: none.

Does not:

- Run models.
- Run validateWorkspace.
- Run bootstrap.
- Repair or migrate state.

Output includes:

- Workflow state.
- Active intent, deployment, and task, or none.
- Readiness flags using yes and no.
- Blockers.
- Stale conditions.
- Risky conditions.
- Next command.
- Reason for the next command.

Use when:

- You need orientation without opening JSON files.
- You are unsure whether to plan, check, approve, run, verify, score, repair, or report.

### next

Purpose: print the single recommended next command.

Command:

    node dist/src/index.js next
    node dist/src/index.js next --reason

Inputs:

- --reason: optional. Also prints the short reason for the recommendation.

Reads:

- Existing workflow state files.

Writes: none.

Output:

- Default mode prints exactly one command.
- --reason prints the command and one Reason line.

Use when:

- You want MAW to reduce workflow uncertainty to one action.
- You are scripting a prompt or handoff that needs the next safe command.

### doctor

Purpose: diagnose setup, state, environment, configuration, and workflow issues without modifying state.

Command:

    node dist/src/index.js doctor

Inputs: none.

Reads:

- Existing workflow state files.
- state/model_config.json when present and parseable.

Writes: none.

Does not:

- Run models.
- Run validateWorkspace.
- Run bootstrap.
- Repair or migrate state.
- Execute deployment commands.

Findings can include:

- Uninitialized workspace.
- Invalid state files.
- Missing model API key environment variable.
- Missing or insufficient reviewer personas for high-risk reviewable tasks.
- Local-command tasks needing --execute.
- Local-command tasks whose command is not allowlisted.
- Failed or blocked tasks.
- Chat messages requiring action.
- Current high-severity plan-check failures.
- Context-check failures.
- Missing approval.
- Missing verification.
- Missing or stale score.
- Missing retrospective.
- Missing performance ledger entries.

Output includes:

- Doctor Summary.
- Workflow State.
- Findings with repair guidance.
- State Safety.
- Next command.
- Reason.

Use when:

- status or next points to maw doctor.
- A workflow is blocked or failed.
- You need a safe repair path before continuing.

### init

Purpose: initialize a workspace in the current directory.

Command:

    node dist/src/index.js init

Inputs: none.

Reads: none.

Writes:

- Creates missing state/, artifacts/, protocols/, and instructions/ files.

Does not:

- Overwrite existing state.
- Run models.
- Validate existing state.

Expected output:

    Initialized multi-agent workflow workspace.
    Workflow State: idle
    Next: maw intent create --text "Describe the work"
    Reason: no active intent exists.

Use when:

- Starting a new MAW workspace.
- Repairing missing default folders or empty default files.

### intent create

Purpose: record a user intent before planning.

Command:

    node dist/src/index.js intent create --text "Build a verified demo artifact."

Inputs:

- --text <text>: required. User request or operating objective.
- --constraint <constraint...>: optional. Adds one or more constraints.
- --risk <risk>: optional. One of low, medium, or high. Defaults to medium.
- --budget <budget>: optional. Free-text budget description.

Examples:

    node dist/src/index.js intent create --text "Draft a launch plan" --risk medium
    node dist/src/index.js intent create --text "Analyze regulated workflow" --risk high --constraint "No external actions" "Cite all generated evidence"
    node dist/src/index.js intent create --text "Prototype local report" --budget "Keep model cost under $1"

Reads:

- state/intent_queue.json

Writes:

- Appends an intent to state/intent_queue.json.

Human-readable output:

- Created intent I-001.
- Transition guidance with the current workflow state and next command.

Operator notes:

- Use only low, medium, or high for --risk.
- A created intent starts with status: "new".

### orchestrate

Purpose: ask the orchestrator model to convert an intent into a prompt contract, task board entries, deployment plan, and decision records.

Command:

    node dist/src/index.js orchestrate --intent I-001

Inputs:

- --intent <intentId>: required. Intent ID such as I-001.

Reads:

- state/intent_queue.json
- state/agent_registry.json
- state/model_config.json
- state/task_board.json
- state/deployment_plan.json
- artifacts/artifact_index.json
- state/learning_memory.json

Writes on success:

- state/prompt_contract.md
- state/task_board.json
- state/deployment_plan.json
- state/intent_queue.json
- state/decision_log.md
- state/metrics.json

Does not write:

- state/plan_checks.json. Pre-flight validation happens in memory.

Model input includes:

- Intent ID, text, risk, budget, and constraints.
- Registered agents.
- Agent performance suffixes when agent.performance.tasks_assigned is greater than 0.
- Active learning rules where confidence * times_seen is greater than or equal to learning_rule_threshold.

Pre-flight behavior:

- The model response is parsed into a proposed plan in memory.
- collectPlanIssues validates it before persistence.
- High-severity issues trigger model retries.
- orchestrator_max_retries controls retries. The default is 2.
- If retries are exhausted, orchestration throws and the intent stays new.

Common high-severity pre-flight codes:

- ASSIGNMENT_TASK_MISSING
- ASSIGNMENT_AGENT_MISSING
- EXECUTOR_REGISTRY_MISMATCH
- DRY_RUN_DELIVERABLE
- HIGH_RISK_REVIEW_MISSING
- INSUFFICIENT_REVIEWERS
- NO_DELIVERABLE_ARTIFACT
- LOCAL_COMMAND_MISSING
- LOCAL_COMMAND_NOT_ALLOWLISTED
- REVIEW_DEPENDENCY_ARTIFACT_MISSING
- LOW_REVIEW_PASS_RATE_FOR_RISK
- HIGH_FAILURE_RATE_AGENT

Expected output:

    Created deployment DP-001 with tasks T-001, T-002.
    Workflow State: approval_precheck_needed
    Next: maw plan-check --deployment DP-001
    Reason: deployment is proposed and needs a current plan check before approval.

Failure handling:

- Missing model key: set the environment variable named by api_key_env.
- Truncated model response: increase max_output_tokens or reduce intent complexity.
- Unknown agent selected by model: adjust registry or rerun orchestration.
- Max retries exhausted: inspect the final violation codes in the thrown error.

### plan-check

Purpose: persist a deployment plan check before approval or execution.

Command:

    node dist/src/index.js plan-check --deployment DP-001
    node dist/src/index.js plan-check --deployment DP-001 --json

Inputs:

- --deployment <deploymentId>: required.
- --json: optional. Prints the full PlanCheck JSON.

Reads:

- state/deployment_plan.json
- state/task_board.json
- state/agent_registry.json
- artifacts/artifact_index.json
- state/model_config.json
- state/plan_checks.json

Writes:

- Upserts one check per deployment in state/plan_checks.json.

Exit behavior:

- Sets nonzero exit code if any issue has severity high.

Human-readable output:

- Plan Check PC-001: pass or fail.
- Any issues with recommended fixes.
- Transition guidance with the current workflow state and next command.
- --json output remains the raw PlanCheck JSON.

Use when:

- Auditing an already persisted deployment.
- Producing durable plan-check records for retrospectives.
- Diagnosing why orchestration pre-flight rejected a plan.

Issue categories:

- Structural assignment issues.
- Executor mismatch issues.
- Dry-run deliverable misuse.
- Missing high-risk review.
- Insufficient reviewer personas.
- Untestable acceptance criteria.
- Missing citable artifacts.
- Local command allowlist problems.
- Review or synthesis dependency artifact gaps.
- Performance-gated routing failures.

### approval record

Purpose: approve or reject a deployment with human scope.

Command:

    node dist/src/index.js approval record --deployment DP-001 --approver "human" --scope "Run deployment DP-001."
    node dist/src/index.js approval record --deployment DP-001 --approver "human" --scope "Reject until dry-run routing is fixed." --decision rejected

Inputs:

- --deployment <deploymentId>: required.
- --approver <name>: required.
- --scope <scope>: required. Exact approved or rejected scope.
- --decision <decision>: optional. approved or rejected. Defaults to approved.

Reads:

- state/approvals.json
- state/deployment_plan.json

Writes:

- Appends to state/approvals.json.
- Updates deployment status in state/deployment_plan.json.

Status effects:

- approved sets deployment status to approved and fills approved_at.
- rejected sets deployment status to blocked and clears approved_at.

Human-readable output:

- Recorded approval AP-001.
- Transition guidance with the current workflow state and next command.

### run

Purpose: execute an approved deployment.

Command:

    node dist/src/index.js run --deployment DP-001
    node dist/src/index.js run --deployment DP-001 --execute
    node dist/src/index.js run --deployment DP-001 --rerun

Inputs:

- --deployment <deploymentId>: required.
- --execute: optional. Required for local_command assignments.
- --rerun: optional. Allows explicit rerun of a completed or failed deployment.

Reads:

- state/deployment_plan.json
- state/task_board.json
- state/agent_registry.json
- state/approvals.json
- state/model_config.json for model tasks and reviewers.
- Task input context files.
- Dependency artifact files.

Writes:

- Updates deployment status in state/deployment_plan.json.
- Updates task statuses in state/task_board.json.
- Writes artifacts under artifacts/runs/<task_id>/.
- Updates artifacts/artifact_index.json.
- Updates state/metrics.json.
- Updates state/chat.json for blockers or review defects.
- Writes structured reviews to state/review_log.json for review-required deliverables.
- Writes consensus to state/consensus.json after spawned reviews.

Executor behavior:

- dry_run writes delegation_packet.md, registers a delegation_packet artifact, and increments the dry-run metric.
- model_agent builds a scoped context packet, calls the configured model, writes response_output.md, and registers model_output.
- local_command requires --execute, checks the command allowlist, writes command_output.txt, command_error.txt, and command_result.json, and registers command_output on exit code 0.

Approval behavior:

- If a deployment requires approval, an approved record must exist before run.
- Use --rerun only for intentional reruns of completed or failed deployments.

Review behavior:

- After a review-required deliverable task completes, MAW spawns structured reviewers sequentially.
- Reviewer count is based on task risk: low 1, medium 2, high 3.
- Review artifacts are registered as review_evidence and structured_review.
- Malformed or truncated reviewer output becomes an abstention and does not throw.
- Consensus is computed automatically after spawned reviewers finish.

Exit behavior:

- Prints completed task IDs.
- Prints failed task IDs if any.
- Prints transition guidance with the resulting workflow state and next command.
- Sets nonzero exit code when any task failed.

Common blockers:

- Deployment DP-001 requires explicit approval before execution.
- Local command task T-001 requires --execute.
- Command is not allowlisted for <agent_id>: <command>.
- Dependency not completed: T-001.
- Model quota or missing API key errors.

### context-check

Purpose: check whether a task has sufficient, readable context.

Command:

    node dist/src/index.js context-check --task T-007
    node dist/src/index.js context-check --task T-007 --json

Inputs:

- --task <taskId>: required.
- --json: optional. Prints the full ContextCheck JSON.

Reads:

- state/task_board.json
- artifacts/artifact_index.json
- state/context_checks.json
- Files listed in task.input_context.
- Dependency artifact files.

Writes:

- Upserts one check per task in state/context_checks.json.

Exit behavior:

- Sets nonzero exit code if any issue has severity high.

Human-readable output:

- Context Check CC-001: pass or fail.
- Any issues with recommended fixes.
- Transition guidance with the current workflow state and next command.
- --json output remains the raw ContextCheck JSON.

Checks:

- Context paths stay inside the workspace.
- Context files exist and are readable.
- Dependencies exist.
- Dependencies are completed or approved.
- Dependency artifacts exist and are readable.
- Review, synthesis, final, and integration tasks receive transitive dependency artifact checks.
- Completed deliverable tasks cannot have only delegation-packet artifacts.

### review record

Purpose: record a manual review note without treating it as verified structured evidence.

Command:

    node dist/src/index.js review record --task T-001 --reviewer "human" --status fail --issue "Missing evidence for criterion 2"

Inputs:

- --task <taskId>: required.
- --reviewer <reviewer>: required. Reviewer ID or name.
- --status <status>: optional. pass or fail. Defaults to pass.
- --issue <issue...>: optional. Variadic issue text.

Reads:

- state/review_log.json

Writes:

- Appends a review to state/review_log.json.

Important behavior:

- Manual CLI reviews are marked malformed: true.
- Manual CLI reviews become status: "abstain".
- Manual CLI reviews are not load-bearing for scoring.
- Use automated structured reviews from run for evidence-backed verification.

Human-readable output:

- Recorded review R-001.
- Transition guidance with the current workflow state and next command.

### consensus compute

Purpose: compute or recompute load-bearing consensus for one task.

Command:

    node dist/src/index.js consensus compute --task T-001
    node dist/src/index.js consensus compute --task T-001 --json

Inputs:

- --task <taskId>: required.
- --json: optional. Prints the full consensus record.

Reads:

- state/review_log.json
- state/task_board.json
- state/consensus.json

Writes:

- Upserts the load-bearing consensus record for the task in state/consensus.json.
- Marks older consensus records for that task as non-load-bearing.

Consensus logic:

- Pass requires reviewer convergence and citations.
- Fail wins when a reviewer fails with valid citations.
- Split means disagreement without satisfying pass or fail rules.
- Unverifiable means reviewers explicitly marked unverifiable, or all available criterion signal is abstention-only.
- Overall pass requires every criterion to pass.
- Overall insufficient applies when fewer than the required non-abstain reviewers participated.

Use when:

- Recomputing after manually inserting structured reviews.
- Refreshing migrated legacy tasks after code updates.
- Inspecting why a review-required task is not verified.

Human-readable output:

- Consensus C-001: pass, fail, split, insufficient, or unverifiable.
- Transition guidance with the current workflow state and next command.
- --json output remains the raw consensus record.

### migrate

Purpose: convert legacy pre-v0.3 flat reviews to structured abstentions.

Command:

    node dist/src/index.js migrate

Inputs: none.

Reads:

- state/review_log.json
- state/task_board.json
- state/consensus.json

Writes:

- Converts legacy review records in state/review_log.json.
- Computes consensus for affected tasks.

Idempotency:

- Only records without per_criterion are migrated.
- Re-running after migration reports 0 migrated records.

Expected consequence:

- Legacy DP-001 style data will score zero verified_useful_outputs after migration until real structured reviews exist.

Human-readable output:

- Migrated N legacy reviews.
- Transition guidance with the current workflow state and next command.

### score

Purpose: compute Workflow Intelligence Yield for a deployment.

Command:

    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js score --deployment DP-001 --json

Inputs:

- --deployment <deploymentId>: required.
- --json: optional. Prints full score JSON.

Reads:

- state/deployment_plan.json
- state/task_board.json
- artifacts/artifact_index.json
- state/consensus.json
- state/metrics.json
- state/approvals.json
- state/context_checks.json
- state/workflow_score.json

Writes:

- Upserts one score per deployment in state/workflow_score.json.

Key fields:

- verified_useful_outputs: review-required tasks with load-bearing pass consensus.
- consensus_pass_count: load-bearing pass consensus records.
- consensus_split_count: load-bearing split consensus records.
- consensus_insufficient_count: load-bearing insufficient consensus records.
- review_pass_rate: verified_useful_outputs divided by review_required_tasks, or 1 when no tasks required review.
- failed_tasks: failed tasks in deployment context.
- rerun_count: extra primary deliverable artifacts per assigned task.
- human_interventions: approvals for the deployment.
- context_failures: failed context checks for deployment tasks.
- workflow_intelligence_yield: verified useful outputs divided by the cost and penalty denominator.

Rerun count includes:

- model_output
- command_output
- delegation_packet

Rerun count excludes:

- review_evidence
- structured_review

Human-readable output:

- Workflow Score WS-001.
- Deployment ID and score fields.
- Transition guidance with the current workflow state and next command.
- --json output remains the raw workflow score.

### retrospective

Purpose: generate a deterministic retrospective and update learning memory.

Command:

    node dist/src/index.js retrospective --deployment DP-001
    node dist/src/index.js retrospective --deployment DP-001 --json

Inputs:

- --deployment <deploymentId>: required.
- --json: optional. Prints the retrospective JSON record.

Reads:

- state/workflow_score.json
- state/plan_checks.json
- state/context_checks.json
- state/chat.json
- state/learning_memory.json
- state/retrospective_index.json
- Performance inputs used by performance update.

Writes:

- state/retrospectives/<RET-ID>.md
- state/retrospective_index.json
- state/learning_memory.json
- state/performance_ledger.json
- state/agent_registry.json
- Possibly state/workflow_score.json if score was missing.

Learning rule sources:

- High and medium plan-check issues.
- High and medium context-check issues.
- Repeated blockers in chat.
- Score and rerun patterns.

Human-readable output:

- Retrospective RET-001.
- Retrospective path and learned rule IDs.
- Transition guidance with the current workflow state and next command.
- --json output remains the raw retrospective record.

### performance update

Purpose: rebuild per-agent performance memory from a deployment.

Command:

    node dist/src/index.js performance update --deployment DP-001
    node dist/src/index.js performance update --deployment DP-001 --json

Inputs:

- --deployment <deploymentId>: required.
- --json: optional. Prints all agents after performance projection.

Reads:

- state/agent_registry.json
- state/performance_ledger.json
- state/consensus.json

Writes:

- state/performance_ledger.json
- state/agent_registry.json

Performance fields:

- tasks_assigned
- tasks_completed
- tasks_failed
- dry_run_mismatches
- review_passes
- review_failures

Consensus-backed review outcome rules:

- Load-bearing consensus pass increments review_passes.
- Load-bearing consensus fail, split, or insufficient increments review_failures.
- No load-bearing consensus leaves both counters unchanged for that task.

Human-readable output:

- Per-agent performance summaries when agents have performance state.
- Transition guidance with the current workflow state and next command.
- --json output remains the raw agent projection.

### validate

Purpose: validate workflow state consistency.

Command:

    node dist/src/index.js validate

Inputs: none.

Reads:

- state/agent_registry.json
- state/task_board.json
- state/deployment_plan.json
- state/approvals.json
- artifacts/artifact_index.json
- state/review_log.json
- state/consensus.json

Writes:

- May migrate legacy reviews through migrateLegacyReviews if legacy records are present and the task board schema is valid.

Exit behavior:

- Prints Workflow state is valid. and transition guidance when no issues remain.
- Sets nonzero exit code when validation issues remain.

Common expected historical issue:

- TASK_REVIEW_MISSING for legacy completed tasks after v0.3. It means the task lacks passing load-bearing consensus, not that the schema is broken.

### report

Purpose: print a Markdown report of current workflow state.

Command:

    node dist/src/index.js report

Inputs: none.

Reads:

- state/intent_queue.json
- state/task_board.json
- state/deployment_plan.json
- state/approvals.json
- state/review_log.json
- state/metrics.json
- state/decision_log.md

Writes: none.

Use when:

- Preparing operator handoff.
- Inspecting current deployment, task, approval, review, and metrics state.
- Getting a quick view before repair work.

Navigation note:

- report remains a handoff payload and does not append transition guidance.
- Run status or next when you need the current navigation recommendation after reading a report.

### bootstrap

Purpose: generate a deterministic session-readiness packet that pairs continuity with counter-context and posture.

Command:

    node dist/src/index.js bootstrap
    node dist/src/index.js bootstrap --json
    node dist/src/index.js bootstrap --work-type ordinary
    node dist/src/index.js bootstrap --work-type stateful
    node dist/src/index.js bootstrap --work-type architecture
    node dist/src/index.js bootstrap --work-type risky
    node dist/src/index.js bootstrap --persist

Inputs:

- --json: optional. Prints the structured BootstrapPacket as JSON instead of Markdown.
- --work-type <type>: optional. One of ordinary, stateful, architecture, risky. Defaults to ordinary.
- --persist: optional. Writes state/bootstrap/BS-NNN.md, state/bootstrap/BS-NNN.json, and updates state/bootstrap/index.json.

Reads, best effort:

- package.json and tsconfig.json.
- state/deployment_plan.json, state/task_board.json, state/agent_registry.json, state/intent_queue.json, state/model_config.json.
- artifacts/artifact_index.json.
- .git through safe read-only git commands.
- .gitignore, dist/, and node_modules/ presence only.

Writes:

- Default mode: nothing.
- --persist only: state/bootstrap/BS-NNN.md, state/bootstrap/BS-NNN.json, and state/bootstrap/index.json.

Human-readable output:

- Markdown bootstrap packet.
- Transition guidance after the packet.
- --json output remains the raw BootstrapPacket JSON.

Does not:

- Call models or any network service.
- Run validateWorkspace, which can migrate legacy reviews.
- Mutate operational state files such as task_board, deployment_plan, approvals, review_log, consensus, workflow_score, learning_memory, performance_ledger, metrics, chat, intent_queue, prompt_contract.md, decision_log.md, or artifact_index.json.
- Inspect node_modules/ or dist/ deeply.

Architecture metadata:

- JSON includes continuity.architecture.
- continuity.architecture contains entry_points and key_modules.
- Each entry has path, role, and evidence.
- Markdown renders these as ### Architecture Entry Points and ### Key Modules.
- Metadata is bounded and deterministic from known local source files, not full static analysis.
- Missing candidate source files are omitted.

Postures and exit codes:

- normal: exit 0. No escalations triggered.
- wide_scan: exit 0. Source-of-truth gaps, capped total git status output, large or capped top-level untracked entries, hygiene gaps, active deployments or tasks, or drift require wider review.
- governed: exit 1. wide_scan triggers combined with --work-type risky or architecture. The packet includes a governed promotion reason in posture_reasons so the operator can see that governed review was selected because wide_scan triggers were present for higher-risk work.
- ask_human: exit 2. Hard stop for unparseable core state, running deployment overlap with stateful, risky, or architecture work, or risky work without reliable source truth.

D4 governed promotion marker:

    governed promotion: WORK_TYPE work requires governed review because wide_scan triggers are present.

Operator notes:

- --persist always writes regardless of posture.
- The exit code follows posture after successful write.
- status_capped means bounded total git status --porcelain -unormal output was truncated.
- untracked_capped means the bounded untracked-entry probe was truncated.
- Bootstrap surfaces not_inspected in JSON and ### Not Inspected in Markdown.
- Elevated posture renders Counter-Context before Continuity so warnings are visible first.

### scaffold

Purpose: add sanctioned extensions through validated scaffold paths instead of hand-editing JSON or generating CLI source.

The scaffold group has four subcommands:

- scaffold agent
- scaffold reviewer
- scaffold protocol
- scaffold command

All scaffold commands share these guarantees:

- Inputs are validated before any file is written.
- Persisted artifacts are parsed by AgentRegistrySchema or written under protocols/.
- Default permissions for new agents are all false.
- Path traversal in protocol names is rejected.
- Duplicate agent IDs and existing protocol files are refused. There is no --replace flag in this release.
- Output uses a stable shape: summary, Changed list, Rollback list, optional Note block, Next, and Reason.
- No model or OpenAI calls.
- No validateWorkspace call.
- Mutations are limited to state/agent_registry.json or protocols/<safe-name>.md.

scaffold command intentionally does not generate new MAW CLI source commands. It scaffolds a local-command execution profile in state/agent_registry.json. Local execution still requires a deployment approval and the --execute flag on run.

#### scaffold agent

Purpose: register a new model_agent, local_command, or dry_run agent in state/agent_registry.json.

Command:

    node dist/src/index.js scaffold agent --id researcher_2 --role "Research Agent" --executor model_agent --model-tier mid

Inputs:

- --id <id>: required. Letters, digits, underscore, hyphen; must start with a letter.
- --role <role>: required. Reviewer roles must use scaffold reviewer instead.
- --executor <executor>: required. One of model_agent, local_command, dry_run.
- --model-tier <tier>: optional. low, mid, or high. Default mid; default low for local_command.
- --model <model>: optional. Explicit model name.
- --max-cost <amount>: optional nonnegative number. Default 1 for model_agent, 0 otherwise.
- --allow-tool <tool...>: optional repeatable values.
- --allow-command <command...>: optional repeatable values. Valid only for the local_command executor; passing --allow-command with any other executor refuses the scaffold.

Reads:

- state/agent_registry.json

Writes:

- Appends one agent to state/agent_registry.json.

Refusal behavior:

- Existing agent_id refuses with a clear error and leaves the registry unchanged.
- Reviewer roles refuse and direct the operator to scaffold reviewer.
- Allow-command values are validated as bare executable names for local_command agents; unsafe values refuse the entire scaffold.
- Allow-command paired with a non-local-command executor refuses the scaffold without modification.

Output shape:

    Scaffolded agent researcher_2.

    Changed:
    - state/agent_registry.json

    Rollback:
    - Remove agent researcher_2 from state/agent_registry.json, then run maw doctor.

    Next: maw doctor
    Reason: verify scaffolded extension before routing work.

#### scaffold reviewer

Purpose: register a Reviewer Agent with a required reviewer_persona.

Command:

    node dist/src/index.js scaffold reviewer --id reviewer_adversarial --persona adversarial

Inputs:

- --id <id>: required. Same safe-id rules as scaffold agent.
- --persona <persona>: required. One of default, skeptical, completeness, rigor, adversarial.
- --model-tier <tier>: optional. Default high.
- --model <model>: optional.
- --max-cost <amount>: optional nonnegative number. Default 1.

Reads:

- state/agent_registry.json

Writes:

- Appends a Reviewer Agent (executor_type model_agent) to state/agent_registry.json.

Refusal behavior:

- Existing agent_id refuses with a clear error and leaves the registry unchanged.

Output shape:

    Scaffolded reviewer reviewer_adversarial with persona adversarial.

    Changed:
    - state/agent_registry.json

    Rollback:
    - Remove agent reviewer_adversarial from state/agent_registry.json, then run maw doctor.

    Next: maw doctor
    Reason: verify scaffolded reviewer before high-risk review work.

#### scaffold protocol

Purpose: create a structured protocol document under protocols/.

Command:

    node dist/src/index.js scaffold protocol --name release-checklist --title "Release Checklist"

Inputs:

- --name <name>: required. Lowercase letters, digits, and hyphens only. Must not start or end with a hyphen, contain whitespace, slash, backslash, or dot-dot.
- --title <title>: optional. Defaults to title-cased name.
- --body <body>: optional. Becomes the Purpose section content; otherwise a placeholder is used.

Reads:

- The target file under protocols/ to confirm it does not already exist.

Writes:

- protocols/<name>.md with sections: Purpose, Required Inputs, Steps, Acceptance Criteria, Rollback.

Refusal behavior:

- Unsafe names refuse with a clear error and write nothing.
- Existing protocol files refuse without overwriting.

Output shape:

    Scaffolded protocol protocols/release-checklist.md.

    Changed:
    - protocols/release-checklist.md

    Rollback:
    - Delete protocols/release-checklist.md, then run maw status.

    Next: maw status
    Reason: verify scaffolded protocol before referencing it from a task.

#### scaffold command

Purpose: scaffold a sanctioned local-command execution profile in state/agent_registry.json.

This subcommand does not generate new MAW CLI source commands. The intent is to add a bare executable to a local_command agent's command_allowlist so future plans can route to it under deployment approval and --execute.

Command:

    node dist/src/index.js scaffold command --agent-id shell_node --command node --role "Shell Agent"

Inputs:

- --agent-id <id>: required. Same safe-id rules as scaffold agent.
- --command <command>: required. Bare executable name. Letters, digits, underscore, hyphen, and dot only. Must start with a letter or digit. Whitespace, slashes, backslashes, dot-dot, and shell separators (semicolon, ampersand, pipe, redirection, quotes, grave accent, dollar) refuse.
- --role <role>: optional. Default Shell Agent. Used only when creating a new agent.
- --model-tier <tier>: optional. Default low. Used only when creating a new agent.

Reads:

- state/agent_registry.json

Writes:

- If the agent does not exist: appends a new local_command agent with the command on its allowlist.
- If the agent exists and is local_command: appends the command to command_allowlist if missing. Other fields stay stable.
- If the agent exists but is not local_command: refuses without modification.

Refusal behavior:

- Unsafe command names refuse and leave the registry unchanged.
- Non-local-command existing agents refuse and leave the registry unchanged.

Output shape:

    Scaffolded command profile shell_node for node.

    Changed:
    - state/agent_registry.json

    Rollback:
    - Remove node from shell_node command_allowlist, or remove agent shell_node entirely if it was created only for this command.

    Note:
    - Local execution still requires deployment approval and maw run --execute.

    Next: maw doctor
    Reason: verify command policy before approving local execution.

When the command is already on the existing agent allowlist, the summary changes to "Command <name> is already on <agent> allowlist; no change." but Changed still records state/agent_registry.json since the file is rewritten with the same contents.

### operator metrics

Purpose: print the local operator-experience metrics report.

Command:

    node dist/src/index.js operator metrics

Inputs: none.

Reads:

- state/operator_experience.json

Writes: none. The metrics command does not record itself, so reading metrics never changes metrics.

Does not:

- Run models.
- Run validateWorkspace.
- Run bootstrap.
- Repair or migrate state.
- Execute any workflow command.

Output:

    Operator Experience Metrics
    Command Attempts: <integer>
    Next-Step Coverage: A/B (rate)
    Invalid Command Rate: A/B (rate)
    Help Invocation Rate: A/B (rate)
    Successful Error Recovery Rate: A/B (rate)
    Extension Success Rate: A/B (rate)
    Time To First Successful Workflow: n/a or duration
    Commands Before Successful Deployment: n/a or N

Use when:

- You want to inspect operator friction signals after a session.
- A reviewer wants to confirm metric values without inspecting raw JSON.

## Operator Experience Metrics

MAW records a small, local operator-experience metrics record at the CLI entry point. The goal is to measure operator friction, not generic activity.

State file:

- state/operator_experience.json

Boundaries:

- Local only. No external telemetry, no network calls, no analytics endpoints.
- No raw free-form user text is stored. Metrics never persist intent text, approval scope, prompt text, review text, protocol body, or command arguments.
- Stored fields are limited to normalized command family names (such as "init", "intent create", "scaffold reviewer", "operator metrics"), outcomes, timestamps, workflow state values, and safe workflow IDs already used elsewhere in MAW state.
- The event log is bounded. The cap is 500 events; the oldest entries are trimmed when the cap is exceeded. first_successful_deployment_at and first_complete_workflow_at are preserved across trim.
- Metrics recording is best-effort. If the workspace is uninitialized, state is invalid, or the metrics file cannot be written, the CLI command result still stands and no metrics error is shown to the operator.

Recorded per-event fields:

- event_id, such as OX-001
- created_at
- command family
- outcome: success, failure, invalid, or help
- next_step_applicable
- next_step_present
- recoverable_error
- recovery_success
- extension_command
- workflow_state_after when available

Top-level fields:

- started_at, updated_at
- pending_recovery: corrective and next command families captured when a recoverable error renders a recovery packet
- first_successful_deployment_at: set the first time a successful run leaves workflow state past execution (verification_needed, scoring_needed, retrospective_needed, performance_update_needed, or complete)
- first_complete_workflow_at: set the first time any event sees workflow_state_after equal to complete

Metric definitions:

- Next-step coverage: events with next_step_present divided by events with next_step_applicable.
- Invalid command rate: invalid events divided by total command attempts.
- Help invocation rate: help events divided by total command attempts.
- Successful error recovery rate: recovery_success events divided by recoverable_error events.
- Extension success rate: successful extension events divided by total extension events.
- Time to first successful workflow: duration from started_at to first_complete_workflow_at, or n/a.
- Commands before successful deployment: count of recorded events before first_successful_deployment_at, or n/a.

Operator notes:

- Metrics are friction signals, not productivity scores. A high invalid-command rate or low next-step coverage points at navigation problems, not at the operator.
- The operator metrics command itself is intentionally excluded from the event log so reading metrics never changes metrics.
- To reset metrics, delete state/operator_experience.json. Init recreates the file with empty defaults.
- Workflow command writes (such as state/agent_registry.json or state/deployment_plan.json) are workflow state. state/operator_experience.json is metadata about CLI usage and is separate from workflow audit state.

## Configuration Reference

### state/model_config.json

Shape:

    {
      "provider": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key_env": "OPENAI_API_KEY",
      "default_models": {
        "orchestrator": "gpt-5.2",
        "high": "gpt-5.2",
        "mid": "gpt-5-mini",
        "low": "gpt-5-nano"
      },
      "max_output_tokens": 4000,
      "learning_rule_threshold": 1.6,
      "orchestrator_max_retries": 2,
      "learning_rule_cap": 10,
      "performance_min_assignments": 3,
      "performance_review_pass_floor": 0.5,
      "performance_failure_rate_ceiling": 0.5,
      "pricing": {}
    }

Defaulted fields may be omitted in older workspaces and are filled by schema parsing:

- max_output_tokens
- learning_rule_threshold
- orchestrator_max_retries
- learning_rule_cap
- performance_min_assignments
- performance_review_pass_floor
- performance_failure_rate_ceiling
- pricing

Pricing shape:

    {
      "pricing": {
        "model-name": {
          "input_per_1m_usd": 1,
          "output_per_1m_usd": 2
        }
      }
    }

Pricing affects estimated cost only. It does not change model selection.

### state/agent_registry.json

Core agent shape:

    {
      "agent_id": "researcher_1",
      "role": "Research Agent",
      "executor_type": "model_agent",
      "model_tier": "mid",
      "allowed_tools": [],
      "command_allowlist": [],
      "permissions": {
        "external_actions": false,
        "destructive_actions": false,
        "credential_access": false,
        "paid_actions": false,
        "public_actions": false
      },
      "max_cost_usd": 1
    }

Reviewer agents require:

    {
      "role": "Reviewer Agent",
      "reviewer_persona": "skeptical"
    }

Allowed reviewer personas:

- default
- skeptical
- completeness
- rigor
- adversarial

Performance is maintained by performance update. Avoid hand-editing it unless repairing state.

## State Editing Guidance

Prefer CLI commands over manual state edits.

When manual edits are necessary:

- Stop all MAW commands first.
- Keep IDs stable.
- Keep paths workspace-relative.
- Preserve schema enum values exactly.
- Run validate after edits.
- Recompute derived state after edits.

Recommended repair sequence:

    node dist/src/index.js consensus compute --task T-001
    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js performance update --deployment DP-001
    node dist/src/index.js validate

Derived files include:

- state/consensus.json
- state/workflow_score.json
- state/performance_ledger.json
- state/agent_registry.json performance blocks
- state/learning_memory.json

## Troubleshooting

### Missing API Key

Symptom:

    Missing OpenAI API key environment variable: OPENAI_API_KEY

Fix:

    $env:OPENAI_API_KEY = "sk-..."

Or update state/model_config.json api_key_env to the environment variable you want to use.

### Model Quota Or API Error

Symptom:

    OpenAI Responses API request failed (429): ...

Fix:

- Check account quota and billing.
- Rerun the deployment after resolving quota.
- Failed task blockers are stored in state/chat.json.

### Orchestrator Cannot Produce A Valid Plan

Symptom:

    Orchestrator could not produce a valid plan after 2 retries. Final violations: ...

Fix:

- Inspect violation codes.
- Run plan-check if a plan was persisted from an earlier attempt.
- Repair registry, risk level, reviewer pool, or intent constraints.
- Re-run orchestrate.

### Dry-Run Deliverable Rejected

Symptom:

    DRY_RUN_DELIVERABLE

Meaning:

- The task output is a real deliverable, but assignment executor is dry_run.

Fix:

- Route to model_agent or local_command.
- Use dry_run only when output is a delegation packet or task packet.

### High-Risk Task Rejected For Reviewer Pool

Symptom:

    INSUFFICIENT_REVIEWERS

Meaning:

- Fewer than three distinct reviewer personas exist in state/agent_registry.json.

Fix:

- Register or restore reviewer agents with distinct reviewer_persona values.
- A default fresh workspace has skeptical, completeness, and rigor.

### Local Command Refuses To Run

Symptoms:

    Local command task T-001 requires --execute.
    Command is not allowlisted for shell_1: node

Fix:

- Use --execute.
- Ensure the assigned local-command agent command_allowlist includes the command.
- Confirm deployment approval exists.

### Validation Fails With TASK_REVIEW_MISSING

Meaning:

- A completed review-required task lacks passing load-bearing consensus.

Fix options:

- If this is legacy migrated data, accept it as honest historical state.
- If this is a current run, inspect state/review_log.json and state/consensus.json.
- Rerun the deliverable or reviewers, then recompute consensus and score.

### Consensus Is Insufficient

Meaning:

- Too few non-abstaining reviewers participated for the task risk level.

Fix:

- Inspect reviewer artifacts under artifacts/runs/<task_id>/.
- Look for malformed or truncated reviewer output.
- Rerun the task or insert valid structured reviews, then run consensus compute.

### Score Is Zero

Meaning:

- No review-required task has load-bearing pass consensus.

Fix:

- Inspect state/consensus.json.
- Ensure reviewer pass verdicts include citations.
- Ensure citations overlap across reviewers for multi-reviewer tasks.
- Recompute consensus and score.

## Operator Checklists

### Before Approval

Run:

    node dist/src/index.js bootstrap --work-type ordinary
    node dist/src/index.js plan-check --deployment DP-001
    node dist/src/index.js context-check --task T-001
    node dist/src/index.js report

Approve only when:

- Bootstrap posture is acceptable for the work type.
- Plan check has no high-severity issues.
- Critical tasks have readable context.
- Dry-run routes are delegation-only.
- High-risk tasks require review and have enough reviewer personas.
- Local-command routes are allowlisted and intentional.

### After Run

Run:

    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js retrospective --deployment DP-001
    node dist/src/index.js performance update --deployment DP-001
    node dist/src/index.js validate

Accept the run only when:

- Required deliverables have artifacts.
- Review-required tasks have passing load-bearing consensus, unless the run is intentionally expected to fail verification.
- Score reflects expected reruns and interventions.
- Retrospective created or refreshed learning rules.
- Remaining validation issues are fixed or explicitly accepted as historical.

### Before Handoff

Run:

    node dist/src/index.js report
    node dist/src/index.js score --deployment DP-001 --json
    node dist/src/index.js plan-check --deployment DP-001 --json
    node dist/src/index.js validate

Document:

- Intent ID and deployment ID.
- Approval scope and approver.
- Completed and failed tasks.
- Artifact paths for final deliverables.
- Consensus status for review-required tasks.
- Score summary.
- Plan-check and context-check issues.
- Any expected validation failures.

## Completion Standard

A deployment is operationally complete when:

1. The deployment has run to completed, or any failure is intentionally documented.
2. Every review-required deliverable has load-bearing consensus.
3. score has been recomputed.
4. retrospective has been run.
5. performance update has refreshed routing memory.
6. validate has been run.
7. Remaining issues are either fixed or explicitly accepted as historical or expected.
