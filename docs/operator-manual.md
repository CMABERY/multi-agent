# MAW Operator Manual

This manual is the operating surface for the local MAW CLI. It covers every command currently exposed by src/cli.ts, the inputs each command accepts, the state files it reads and writes, and the main use-cases an operator is expected to run.

For scenario walkthroughs and troubleshooting demonstrations, use [operational-demonstrations.md](operational-demonstrations.md). This manual is the reference surface; the demonstration suite shows end-to-end operator practice.

Examples use:

    node dist/src/index.js <command>

If the package binary is linked or installed, replace node dist/src/index.js with maw.

Do not run subcommand names by themselves. For example, intent create is a command label inside MAW, not a PowerShell executable. In this checkout, run:

    node .\dist\src\index.js intent create --text "Build a verified demo artifact."

## Operating Model

MAW is a local, file-backed multi-agent workflow runtime. The CLI reads and writes JSON and Markdown under the current working directory:

- state/ contains workflow state, plans, approvals, reviews, consensus, scores, memory, and metrics.
- artifacts/ contains indexed task outputs and run artifacts.
- protocols/ contains durable protocol templates.
- instructions/ contains durable role instruction templates.
- dist/ contains built JavaScript used by the CLI examples in this manual.

All commands operate on process.cwd(). Run commands from the workspace root unless you intentionally want to operate on a different workspace.

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
- retrospective, unless it needs to compute missing score over state that triggers no model calls
- performance update
- report

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

Risk levels are:

- low
- medium
- high

Risk affects reviewer fanout for review-required deliverables:

- Low risk: 1 reviewer
- Medium risk: 2 reviewers
- High risk: 3 reviewers

### Honest Verification

verified_useful_outputs is consensus-backed. It counts review-required tasks only when the load-bearing consensus record for the task has overall_verdict: "pass".

Raw manual review enum statuses are not load-bearing. review record intentionally stores malformed abstaining reviews, because the CLI cannot collect the full structured evidence shape.

### Performance-Aware Routing

Agent performance is rebuilt from state/performance_ledger.json by performance update. The current implementation derives review outcomes from load-bearing consensus:

- Consensus pass increments review_passes.
- Consensus fail, split, or insufficient increments review_failures.

The orchestrator prompt surfaces performance for agents with nonzero assignment history, and pre-flight plan checks reject bad risk routing with high-severity issues.

## Default Workspace Files

init creates these state files if missing:

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
- state/prompt_contract.md
- state/decision_log.md
- artifacts/artifact_index.json

It also creates protocol and instruction templates.

Default agents in a fresh workspace:

- orchestrator_1: model agent, high tier
- researcher_1: model agent, mid tier
- builder_1: dry-run agent, mid tier
- reviewer_skeptical: reviewer persona skeptical, high tier
- reviewer_completeness: reviewer persona completeness, high tier
- reviewer_rigor: reviewer persona rigor, high tier

Existing files are not overwritten by init.

## Full CLI Surface

### Global Help And Version

Use these to inspect the binary:

    node dist/src/index.js --help
    node dist/src/index.js --version
    node dist/src/index.js help <command>

Inputs:

- --help: optional, prints command help.
- --version: optional, prints package CLI version.
- help <command>: optional command path such as intent, intent create, or score.

State effects: none.

Exit behavior:

- Help and version exit successfully.

## Command Reference

### init

Initialize a workspace in the current directory.

    node dist/src/index.js init

Inputs: none.

Writes:

- Creates missing state/, artifacts/, protocols/, and instructions/ files.

Does not:

- Overwrite existing state.
- Run models.
- Validate existing state.

Use-cases:

- Start a new MAW workspace.
- Repair a workspace that is missing default folders or empty default files.

Expected output:

    Initialized multi-agent workflow workspace.

### intent create

Create a new user intent.

    node dist/src/index.js intent create --text "Build a verified demo artifact."

All inputs:

- --text <text>: required. The user request or operating objective.
- --constraint <constraint...>: optional variadic list. Adds one or more constraints to the intent.
- --risk <risk>: optional. One of low, medium, or high. Defaults to medium.
- --budget <budget>: optional free-text budget description.

Examples:

    node dist/src/index.js intent create --text "Draft a launch plan" --risk medium
    node dist/src/index.js intent create --text "Analyze regulated workflow" --risk high --constraint "No external actions" "Cite all generated evidence"
    node dist/src/index.js intent create --text "Prototype local report" --budget "Keep model cost under $1"

Reads:

- state/intent_queue.json

Writes:

- Appends an intent to state/intent_queue.json.

Returns:

- The new intent ID, such as I-001.

Use-cases:

- Start all normal planned work.
- Capture constraints and budget before asking the orchestrator for a plan.
- Preserve intent history without immediately planning.

Operator notes:

- --risk is not validated by Commander before reaching the typed code path. Use only low, medium, or high.
- A created intent starts with status: "new".

### orchestrate

Ask the orchestrator model to convert an intent into a prompt contract, task board entries, deployment plan, and decision records.

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

- state/plan_checks.json. Pre-flight validation happens in memory only.

Model input includes:

- Intent ID, text, risk, budget, constraints
- Registered agents
- Agent performance suffixes when agent.performance.tasks_assigned > 0
- Active learning rules where confidence * times_seen >= learning_rule_threshold

Pre-flight behavior:

- The model response is parsed into a proposed plan in memory.
- collectPlanIssues validates it before persistence.
- High-severity issues trigger model retries.
- orchestrator_max_retries controls retries; default is 2.
- If retries are exhausted, orchestration throws and the intent stays new.

High-severity pre-flight examples:

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

Use-cases:

- Generate a plan for a new intent.
- Force the system to revise invalid routing before state is persisted.
- Inject learned rules and performance memory into planning.

Expected output:

    Created deployment DP-001 with tasks T-001, T-002.

Failure examples:

- Missing model key: set the environment variable named by api_key_env.
- Truncated model response: increase max_output_tokens or reduce intent complexity.
- Unknown agent selected by model: adjust registry or rerun orchestration.
- Max retries exhausted: inspect the final violation codes in the thrown error.

### plan-check

Persist a deployment plan check.

    node dist/src/index.js plan-check --deployment DP-001
    node dist/src/index.js plan-check --deployment DP-001 --json

Inputs:

- --deployment <deploymentId>: required.
- --json: optional. Print the full PlanCheck JSON.

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

Use-cases:

- Audit an already persisted deployment.
- Produce durable plan-check records for retrospectives.
- Populate learning memory after running retrospective.
- Diagnose why orchestration pre-flight might be rejecting a plan.

Important issue categories:

- Structural assignment issues
- Executor mismatch issues
- Dry-run deliverable misuse
- Missing high-risk review
- Insufficient reviewer personas
- Untestable acceptance criteria
- Missing citable artifacts
- Local command allowlist problems
- Review/synthesis dependency artifact gaps
- Performance-gated routing failures

### approval record

Approve or reject a deployment.

    node dist/src/index.js approval record --deployment DP-001 --approver "human" --scope "Run deployment DP-001."
    node dist/src/index.js approval record --deployment DP-001 --approver "human" --scope "Reject until dry-run routing is fixed." --decision rejected

All inputs:

- --deployment <deploymentId>: required.
- --approver <name>: required.
- --scope <scope>: required. The exact approved or rejected scope.
- --decision <decision>: optional. approved or rejected. Defaults to approved.

Reads:

- state/approvals.json
- state/deployment_plan.json

Writes:

- Appends to state/approvals.json.
- Updates the deployment in state/deployment_plan.json.

Status effects:

- approved sets deployment status to approved and fills approved_at.
- rejected sets deployment status to blocked and clears approved_at.

Returns:

- Approval ID such as AP-001.

Use-cases:

- Permit a proposed deployment to run.
- Record a human rejection with scope.
- Preserve an approval audit trail.

### run

Run an approved deployment.

    node dist/src/index.js run --deployment DP-001
    node dist/src/index.js run --deployment DP-001 --execute
    node dist/src/index.js run --deployment DP-001 --rerun

All inputs:

- --deployment <deploymentId>: required.
- --execute: optional. Required for local_command assignments.
- --rerun: optional. Allows explicit rerun of a completed or failed deployment.

Reads:

- state/deployment_plan.json
- state/task_board.json
- state/agent_registry.json
- state/approvals.json
- state/model_config.json for model tasks and reviewers
- Task input context files
- Dependency artifact files

Writes:

- Updates deployment status in state/deployment_plan.json.
- Updates task statuses in state/task_board.json.
- Writes artifacts under artifacts/runs/<task_id>/.
- Updates artifacts/artifact_index.json.
- Updates state/metrics.json.
- Updates state/chat.json for blockers or review defects.
- Writes structured reviews to state/review_log.json for review-required deliverables.
- Writes consensus to state/consensus.json after spawned reviews.

Execution behavior by executor:

- dry_run: writes delegation_packet.md, registers a delegation_packet artifact, increments dry-run metric.
- model_agent: builds a scoped context packet, calls the configured model, writes response_output.md, registers model_output.
- local_command: requires --execute, checks command allowlist, writes command_output.txt, command_error.txt, and command_result.json, registers command_output on exit code 0.

Approval behavior:

- If a deployment requires approval, an approved record must exist before run.
- If status is not approved, use --rerun only for intentional reruns.

Review behavior:

- After a review-required deliverable task completes, MAW spawns structured reviewers sequentially.
- Reviewer count is based on task risk: low 1, medium 2, high 3.
- Review artifacts are registered as review_evidence and structured_review.
- Malformed or truncated reviewer output becomes an abstention and does not throw.
- Consensus is computed automatically after spawned reviewers finish.

Exit behavior:

- Prints completed task IDs.
- Prints failed task IDs if any.
- Sets nonzero exit code when any task failed.

Use-cases:

- Execute an approved plan.
- Dry-run a plan shape without external actions.
- Execute allowlisted local commands only after explicit approval and --execute.
- Rerun a deployment after fixing blockers or state.

Common blockers:

- Deployment DP-001 requires explicit approval before execution.
- Local command task T-001 requires --execute.
- Command is not allowlisted for <agent_id>: <command>
- Dependency not completed: T-001
- Model quota or missing API key errors.

### context-check

Check whether a task has sufficient, readable context.

    node dist/src/index.js context-check --task T-007
    node dist/src/index.js context-check --task T-007 --json

Inputs:

- --task <taskId>: required.
- --json: optional. Print the full ContextCheck JSON.

Reads:

- state/task_board.json
- artifacts/artifact_index.json
- state/context_checks.json
- Files listed in task.input_context
- Dependency artifact files

Writes:

- Upserts one check per task in state/context_checks.json.

Exit behavior:

- Sets nonzero exit code if any issue has severity high.

Checks:

- Context paths must stay inside the workspace.
- Context files must exist and be readable.
- Dependencies must exist.
- Dependencies must be completed or approved.
- Dependency artifacts must exist and be readable.
- Review/synthesis/final/integration tasks receive transitive dependency artifact checks.
- Completed deliverable tasks cannot have only delegation-packet artifacts.

Use-cases:

- Debug missing context before running a reviewer or synthesizer.
- Confirm a final review task can see its dependency artifacts.
- Generate durable context-check issues for scoring and retrospectives.

### review record

Record a manual review note.

    node dist/src/index.js review record --task T-001 --reviewer "human" --status fail --issue "Missing evidence for criterion 2"

All inputs:

- --task <taskId>: required.
- --reviewer <reviewer>: required. Reviewer ID or name.
- --status <status>: optional. pass or fail. Defaults to pass.
- --issue <issue...>: optional variadic list of issue text.

Reads:

- state/review_log.json

Writes:

- Appends a review to state/review_log.json.

Important behavior:

- Manual CLI reviews are marked malformed: true.
- Manual CLI reviews become status: "abstain".
- Manual CLI reviews are not load-bearing for scoring.
- Use automated structured reviews from run for evidence-backed verification.

Returns:

- Review ID such as R-001.

Use-cases:

- Record human notes without affecting verified score.
- Preserve pre-v0.3 style review input as non-load-bearing data.
- Add a manual issue trail before rerunning structured verification.

### consensus compute

Compute or recompute load-bearing consensus for one task.

    node dist/src/index.js consensus compute --task T-001
    node dist/src/index.js consensus compute --task T-001 --json

Inputs:

- --task <taskId>: required.
- --json: optional. Print the full consensus record.

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

Use-cases:

- Recompute after manually inserting structured reviews.
- Refresh legacy migrated tasks after code updates.
- Inspect why a review-required task is not verified.

Failure examples:

- No reviews exist for the task.
- Review log schema is invalid.
- Task ID does not exist and reviews have no criteria to infer.

### migrate

Convert legacy pre-v0.3 flat reviews to structured abstentions.

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

Use-cases:

- Upgrade old DP data to honest verification semantics.
- Intentionally turn legacy enum passes into abstaining, malformed structured reviews.
- Drop old inflated pass rates out of scoring.

Expected consequence:

- Legacy DP-001 style data will score zero verified_useful_outputs after migration until real structured reviews exist.

### score

Compute Workflow Intelligence Yield for a deployment.

    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js score --deployment DP-001 --json

Inputs:

- --deployment <deploymentId>: required.
- --json: optional. Print full score JSON.

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
- review_pass_rate: verified_useful_outputs / review_required_tasks, or 1 when no tasks required review.
- failed_tasks: failed tasks in deployment context.
- rerun_count: extra primary deliverable artifacts per assigned task.
- human_interventions: approvals for the deployment.
- context_failures: failed context checks for deployment tasks.
- workflow_intelligence_yield: verified useful outputs divided by the cost/penalty denominator.

Rerun artifact types counted:

- model_output
- command_output
- delegation_packet

Rerun artifact types excluded:

- review_evidence
- structured_review
- manual_output
- sidecar files not registered as artifacts

Use-cases:

- Quantify a deployment after run and consensus.
- Refresh score after recomputing consensus.
- Produce machine-readable quality signals for downstream analysis.

### retrospective

Generate a deterministic retrospective and update learning memory.

    node dist/src/index.js retrospective --deployment DP-001
    node dist/src/index.js retrospective --deployment DP-001 --json

Inputs:

- --deployment <deploymentId>: required.
- --json: optional. Print the retrospective JSON record.

Reads:

- Deployment context
- state/workflow_score.json
- state/plan_checks.json
- state/context_checks.json
- state/chat.json
- state/learning_memory.json
- state/retrospective_index.json
- Performance inputs used by performance update

Writes:

- state/retrospectives/<RET-ID>.md
- state/retrospective_index.json
- state/learning_memory.json
- state/performance_ledger.json
- state/agent_registry.json
- Possibly state/workflow_score.json if score was missing

Learning rule inputs:

- High and medium plan-check issues.
- High and medium context-check issues.

Learning rule examples:

- DRY_RUN_DELIVERABLE: do not route deliverables to dry-run unless the output is only a delegation packet.
- INSUFFICIENT_REVIEWERS: high-risk reviewable tasks require at least three distinct reviewer personas.
- UNTESTABLE_ACCEPTANCE_CRITERIA: criteria must be observable and evidence-checkable.
- LOW_REVIEW_PASS_RATE_FOR_RISK: do not route high-risk reviewable tasks to low pass-rate agents.
- HIGH_FAILURE_RATE_AGENT: do not route non-low-risk tasks to high failure-rate agents.

Use-cases:

- Close the loop after a deployment.
- Convert plan/context defects into learning rules.
- Refresh performance ledger and registry performance.
- Produce a human-readable summary of issues and learned rules.

Idempotency:

- Retrospective is one record per deployment.
- Learning rule times_seen is not incremented again for the same source.
- Performance ledger entries for the deployment are replaced before projection.

### performance update

Rebuild per-agent performance memory from a deployment.

    node dist/src/index.js performance update --deployment DP-001
    node dist/src/index.js performance update --deployment DP-001 --json

Inputs:

- --deployment <deploymentId>: required.
- --json: optional. Print all agents after performance projection.

Reads:

- Deployment context
- state/agent_registry.json
- state/performance_ledger.json
- state/consensus.json

Writes:

- state/performance_ledger.json
- state/agent_registry.json

Performance counters:

- tasks_assigned
- tasks_completed
- tasks_failed
- review_passes
- review_failures
- dry_run_deliverable_mismatches
- average_score_contribution
- known_failure_modes

Consensus-backed review outcome rules:

- Load-bearing consensus pass increments review_passes.
- Load-bearing consensus fail, split, or insufficient increments review_failures.
- No load-bearing consensus leaves both counters unchanged for that task.

Use-cases:

- Refresh routing memory after scoring/consensus changes.
- Make B.2 performance-aware orchestration see recent results.
- Repair stale or manually edited agent.performance values from ledger projection.

### validate

Validate state consistency.

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

- Prints Workflow state is valid. and exits successfully when no issues exist.
- Prints issues and sets nonzero exit code when invalid.

Common validation issue codes:

- SCHEMA_INVALID
- TASK_OWNER_MISSING
- TASK_DEPENDENCY_MISSING
- TASK_APPROVAL_MISSING
- TASK_REVIEW_MISSING
- ARTIFACT_MISSING
- DEPLOYMENT_TASK_MISSING
- DEPLOYMENT_AGENT_MISSING

Important note:

- TASK_REVIEW_MISSING for legacy completed tasks after v0.3 is often expected. It means the task lacks passing load-bearing consensus, not that the schema is broken.

Use-cases:

- Check state before handoff.
- Detect broken references after manual state edits.
- Trigger one-time legacy review migration.

### report

Print a Markdown report of the current workflow state.

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

Output sections:

- Intents
- Deployments
- Tasks
- Approvals
- Reviews
- Decisions
- Metrics

Use-cases:

- Produce an operator-readable status snapshot.
- Paste a run summary into a PR description or handoff.
- Check whether approvals and decisions were recorded.

### bootstrap

Generate a session-readiness packet that pairs the workspace's continuity frame (project, stack, active deployments and tasks, recent artifacts) with a counter-context frame (git/source-truth risks, runtime warnings, drift, parse failures) and a deterministic posture recommendation.

Bootstrap is readiness support, not proof of complete understanding.

    node dist/src/index.js bootstrap
    node dist/src/index.js bootstrap --json
    node dist/src/index.js bootstrap --work-type ordinary
    node dist/src/index.js bootstrap --work-type stateful
    node dist/src/index.js bootstrap --work-type architecture
    node dist/src/index.js bootstrap --work-type risky
    node dist/src/index.js bootstrap --persist

Inputs:

- --json: optional. Print the structured BootstrapPacket as JSON instead of Markdown.
- --work-type <type>: optional. One of ordinary, stateful, architecture, risky. Defaults to ordinary. Higher-risk work types tighten posture escalation.
- --persist: optional. Write state/bootstrap/BS-NNN.{md,json} and update state/bootstrap/index.json.

Reads (best-effort, never fails on missing files):

- package.json, tsconfig.json
- state/deployment_plan.json, state/task_board.json, state/agent_registry.json, state/intent_queue.json, state/model_config.json
- artifacts/artifact_index.json
- .git/ (read-only git rev-parse, rev-list, remote, bounded status --porcelain -unormal, bounded ls-files --others --exclude-standard --directory, rev-parse --abbrev-ref)
- .gitignore, dist/, node_modules/ (presence only, not contents)

Writes:

- Default mode: nothing.
- --persist only: state/bootstrap/BS-NNN.md, state/bootstrap/BS-NNN.json, state/bootstrap/index.json.

Does not:

- Call models or any network service.
- Run validateWorkspace() (which can migrate legacy reviews).
- Mutate any operational state file (task_board, deployment_plan, approvals, review_log, consensus, workflow_score, learning_memory, performance_ledger, metrics, chat, intent_queue, prompt_contract.md, decision_log.md, artifact_index.json).
- Inspect node_modules/ or dist/ deeply; only their presence is reported.

Posture levels and exit codes:

- normal → exit 0. No escalations triggered.
- wide_scan → exit 0. Source-of-truth gaps, capped total git status output, large/capped top-level untracked entries, hygiene gaps, active deployments/tasks, or doc/code drift detected — review more before acting.
- governed → exit 1. wide_scan triggers combined with --work-type risky or architecture. The packet includes a governed promotion reason in posture_reasons so the operator can see that governed review was selected because wide_scan triggers were present for higher-risk work. required_extra_review lists action steps such as initializing git, adding .gitignore, or running plan-check before approval.
- ask_human → exit 2. Hard stop: core state file unparseable, running deployment overlaps with stateful/risky/architecture work, or risky work attempted without reliable source truth.

Persistence behavior:

- --persist always writes regardless of posture. Even when posture is ask_human, the persisted packet becomes the audit artifact for the stop condition.
- The exit code follows posture *after* successful write.

Use-cases:

- Quick read on workspace readiness before starting a session.
- Capture an audit trail of what was true at session start (--persist).
- Block automation in CI when posture is governed or ask_human.

Operator notes:

- Posture decisions are deterministic and transparent: every escalation appears in posture_reasons with a one-line rationale.
- Ordinary work in a workspace with a wide top-level untracked surface escalates to wide_scan.
- status_capped means the bounded total git status --porcelain -unormal output was truncated; it is separate from untracked_capped, which only means the bounded untracked-entry probe was truncated.
- Bootstrap intentionally surfaces what it has *not* inspected (see not_inspected in JSON / ### Not Inspected in Markdown). Treat that list as a prompt to widen scope before acting.
- The Markdown renderer puts Counter-Context **before** Continuity whenever posture is elevated, so warnings are not buried under the active-task summary.

## End-to-End Use-Cases

### Use-Case 1: Start A Fresh Workspace

    npm install
    npm run build
    node dist/src/index.js init
    node dist/src/index.js validate

Expected result:

- Default files exist.
- Fresh validation passes.

If validation fails immediately, inspect any manually existing state files because init does not overwrite them.

### Use-Case 2: Create, Plan, Approve, Run, Verify, And Learn

    node dist/src/index.js intent create --text "Build a verified demo artifact." --risk medium
    node dist/src/index.js orchestrate --intent I-001
    node dist/src/index.js plan-check --deployment DP-001
    node dist/src/index.js approval record --deployment DP-001 --approver "operator" --scope "Run DP-001 as proposed."
    node dist/src/index.js run --deployment DP-001
    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js retrospective --deployment DP-001
    node dist/src/index.js validate

Use this for normal model-agent deployments.

Operator decision points:

- If plan-check fails, inspect high-severity issues before approval.
- If run fails, inspect state/chat.json, task blockers, and run artifacts.
- If score shows zero verified outputs, inspect state/consensus.json.

### Use-Case 3: Create A Low-Risk Dry-Run Packet

Dry-run is valid only when the required output is a delegation or task packet. The orchestrator should encode that if the intent is explicit.

    node dist/src/index.js intent create --text "Create a delegation packet only for a future implementation." --risk low
    node dist/src/index.js orchestrate --intent I-001
    node dist/src/index.js plan-check --deployment DP-001
    node dist/src/index.js approval record --deployment DP-001 --approver "operator" --scope "Emit delegation packet only."
    node dist/src/index.js run --deployment DP-001

Expected artifact:

- artifacts/runs/T-001/delegation_packet.md

If plan-check reports DRY_RUN_DELIVERABLE, the task is asking for a real deliverable and must not be dry-run routed.

### Use-Case 4: Run A Local Command Task

Local command tasks are usually orchestrated or manually created in state. A local-command assignment must satisfy:

- Task executor is local_command.
- Assignment executor is local_command.
- Task has command: { command, args }.
- Agent executor type is local_command.
- Agent command_allowlist includes the command.
- Deployment has approval.
- run is called with --execute.

Run:

    node dist/src/index.js approval record --deployment DP-001 --approver "operator" --scope "Run approved allowlisted command."
    node dist/src/index.js run --deployment DP-001 --execute

Expected artifacts:

- artifacts/runs/<task>/command_output.txt
- artifacts/runs/<task>/command_error.txt
- artifacts/runs/<task>/command_result.json

If command exits nonzero:

- Task is marked failed.
- Blocker is added to state/chat.json.
- Deployment is marked failed.

### Use-Case 5: Recover From A Failed Deployment

1. Inspect failure:

    node dist/src/index.js report
    node dist/src/index.js context-check --task T-001

2. Fix the upstream cause:

- Missing approval: record approval.
- Missing context file: create or fix workspace-relative file.
- Missing dependency artifact: rerun or repair dependency.
- Local command failure: fix command or allowlist.
- Model quota: fix OPENAI_API_KEY or billing.

3. Rerun intentionally:

    node dist/src/index.js run --deployment DP-001 --rerun
    node dist/src/index.js score --deployment DP-001

Reruns are counted from primary deliverable artifacts.

### Use-Case 6: Recompute Consensus And Score After Review Changes

    node dist/src/index.js consensus compute --task T-001
    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js performance update --deployment DP-001

Use this after:

- Manual insertion of structured review records.
- Re-running reviewer tasks.
- Migrating legacy reviews.
- Updating consensus logic.

### Use-Case 7: Migrate Legacy Reviews

    node dist/src/index.js migrate
    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js performance update --deployment DP-001

Expected result:

- Legacy enum reviews become abstaining, malformed structured reviews.
- Consensus is insufficient unless real structured reviews exist.
- verified_useful_outputs may drop to zero.
- Performance review failures may rise because consensus is honest.

### Use-Case 8: Generate Learning Rules From Plan And Context Failures

    node dist/src/index.js plan-check --deployment DP-001
    node dist/src/index.js context-check --task T-001
    node dist/src/index.js retrospective --deployment DP-001

Then inspect:

    Get-Content state/learning_memory.json

Rules above the threshold are injected into future orchestrator prompts.

Default activation threshold:

    confidence * times_seen >= 1.6

Default rule cap:

    10 most recently seen active rules

### Use-Case 9: Refresh Performance-Aware Routing Memory

    node dist/src/index.js performance update --deployment DP-001 --json

Run this after:

- Consensus recomputation.
- Score refresh.
- Retrospective.
- Manual repair of ledger or registry.

The orchestrator sees performance suffixes on future orchestrate calls.

### Use-Case 10: Check Why A High-Risk Plan Is Rejected

Run a persisted check:

    node dist/src/index.js plan-check --deployment DP-001 --json

Look for:

- INSUFFICIENT_REVIEWERS: fewer than three distinct reviewer personas.
- LOW_REVIEW_PASS_RATE_FOR_RISK: high-risk task routed to an agent below review pass floor.
- HIGH_FAILURE_RATE_AGENT: medium/high risk task routed to an agent above failure ceiling.
- HIGH_RISK_REVIEW_MISSING: high-risk task does not require review.

Fix route, registry, risk level, or criteria, then orchestrate again.

### Use-Case 11: Produce An Operator Handoff

    node dist/src/index.js report > handoff.md
    node dist/src/index.js score --deployment DP-001 --json > score.json
    node dist/src/index.js plan-check --deployment DP-001 --json > plan-check.json

Include:

- Current deployment status.
- Completed and failed tasks.
- Score summary.
- Consensus status for review-required tasks.
- Plan/context issues.
- Known blockers.

### Use-Case 12: Audit The Current DP-001 Legacy State

The current repository state has legacy DP-001 data migrated to honest verification.

Useful commands:

    node dist/src/index.js validate
    node dist/src/index.js score --deployment DP-001 --json
    node dist/src/index.js performance update --deployment DP-001 --json

Expected current pattern:

- verified_useful_outputs is 0.
- workflow_intelligence_yield is 0.
- rerun_count is 14.
- Validation reports TASK_REVIEW_MISSING for legacy completed reviewed tasks.
- Consensus for those tasks is insufficient, not pass.

This is not a regression. It is the intended post-v0.3 honest-verification result.

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

Performance is maintained by performance update; avoid hand-editing it unless repairing state.

## State Editing Guidance

Prefer CLI commands over manual state edits.

When manual edits are necessary:

- Stop all MAW commands first.
- Keep IDs stable.
- Keep paths workspace-relative.
- Preserve schema enum values exactly.
- Run node dist/src/index.js validate after edits.
- Recompute derived state after edits:

    node dist/src/index.js consensus compute --task T-001
    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js performance update --deployment DP-001

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
- Default fresh workspace has skeptical, completeness, and rigor.

### Local Command Refuses To Run

Symptoms:

    Local command task T-001 requires --execute.
    Command is not allowlisted for shell_1: node

Fix:

- Use --execute.
- Ensure the assigned local-command agent's command_allowlist includes the command.
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

## Recommended Operator Checklists

### Before Approval

    node dist/src/index.js plan-check --deployment DP-001
    node dist/src/index.js context-check --task T-001
    node dist/src/index.js report

Approve only when:

- Plan check has no high-severity issues.
- Critical tasks have readable context.
- Dry-run routes are delegation-only.
- High-risk tasks require review and have enough reviewer personas.
- Local-command routes are allowlisted and intentional.

### After Run

    node dist/src/index.js score --deployment DP-001
    node dist/src/index.js retrospective --deployment DP-001
    node dist/src/index.js performance update --deployment DP-001
    node dist/src/index.js validate

Accept the run only when:

- Required deliverables have artifacts.
- Review-required tasks have passing load-bearing consensus, unless the run is intentionally expected to fail verification.
- Score reflects expected reruns and interventions.
- Retrospective created or refreshed learning rules.

### Before Handoff

    node dist/src/index.js report
    node dist/src/index.js score --deployment DP-001 --json
    node dist/src/index.js plan-check --deployment DP-001 --json
    node dist/src/index.js validate

Document any expected validation failures, especially legacy TASK_REVIEW_MISSING records.

## Command Summary Table

| Command | Required inputs | Optional inputs | Primary writes | Model call |
| --- | --- | --- | --- | --- |
| init | none | none | default workspace files | no |
| intent create | --text | --constraint, --risk, --budget | state/intent_queue.json | no |
| orchestrate | --intent | none | prompt contract, tasks, deployment, decisions, metrics | yes |
| approval record | --deployment, --approver, --scope | --decision | approvals, deployment status | no |
| review record | --task, --reviewer | --status, --issue | review log | no |
| consensus compute | --task | --json | consensus | no |
| migrate | none | none | review log, consensus | no |
| run | --deployment | --execute, --rerun | task/deployment state, artifacts, metrics, reviews, consensus | depends on tasks |
| validate | none | none | may migrate legacy reviews | no |
| score | --deployment | --json | workflow score | no |
| plan-check | --deployment | --json | plan checks | no |
| context-check | --task | --json | context checks | no |
| retrospective | --deployment | --json | retrospective, learning memory, performance | no |
| performance update | --deployment | --json | performance ledger, agent registry | no |
| report | none | none | none | no |
| bootstrap | none | --json, --work-type, --persist | nothing by default; state/bootstrap/BS-NNN.{md,json} only with --persist | no |

## Completion Standard For A Run

A deployment is operationally complete when:

1. The deployment has run to completed, or any failure is intentionally documented.
2. Every review-required deliverable has load-bearing consensus.
3. score has been recomputed.
4. retrospective has been run.
5. performance update has refreshed routing memory.
6. validate has been run, and remaining issues are either fixed or explicitly accepted as historical/expected.
