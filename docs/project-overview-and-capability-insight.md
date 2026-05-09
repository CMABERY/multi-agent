# Project Overview And Capability Insight

This document is the depth view behind the README. It takes each concept the README names and unpacks the why, the mechanism, the boundary, and the module that implements it. It is written for operators, implementers, and reviewers who need to understand MAW's design choices before relying on the command reference.

For the conceptual front door, see [../README.md](../README.md). For command syntax, use [operator-manual.md](operator-manual.md). For scenario practice, use [operational-demonstrations.md](operational-demonstrations.md).

## Product Identity

MAW is a local, file-backed multi-agent workflow runtime exposed as a state-aware operator console over that workflow ledger. It is implemented as a TypeScript Node CLI and stores workflow evidence in local JSON and Markdown files.

The product goal is not to make agentic work invisible. The goal is to make it inspectable:

- Intent is recorded before planning.
- Plans are persisted before execution.
- Human approval is explicit.
- Execution creates artifacts.
- Review-required deliverables need structured evidence.
- Consensus is computed from review records.
- Scores and retrospectives preserve learning.
- Reports and bootstrap packets support handoff.

MAW treats workflow state as an audit surface. The operator console layer adds an orientation and recovery surface on top: status, next, doctor, transition guidance, recovery packets, scaffold paths, and local operator-experience metrics. The operator should be able to inspect what happened, why it happened, what evidence supports the result, and what to do next without opening JSON files.

Current release baseline: 8348a44 fix: validate risk level and intent text in createIntent.

## Two-Layer Architecture

MAW is one product organized as two cooperating layers over a single workspace.

### The Workflow Ledger

The ledger is the substrate. It turns intent into evidence, stage by stage, and each artifact produced at one step is the audit surface for the next:

- intent capture in state/intent_queue.json
- orchestration into a prompt contract, task graph, deployment plan, and decision records
- deterministic plan-check and context-check before approval
- explicit human approval in state/approvals.json
- approved deployment execution across dry_run, model_agent, and local_command executors
- structured-evidence reviews and load-bearing consensus
- workflow intelligence yield scoring
- retrospectives and learning memory
- agent performance memory
- Markdown reporting for handoff

Every stage is durable. There is no pass-by-label and no hidden process memory.

### The Operator Console

The console is the surface. It sits on top of the ledger and answers four questions without forcing the operator into JSON:

- Where am I? -> status
- What changed and what is next? -> transition guidance plus next
- What is wrong? -> doctor
- How do I recover? -> structured recovery packets

It also defines the only sanctioned ways to extend MAW (scaffold agent, reviewer, protocol, command), the only sugar chain that automates deterministic stages (maw plan), and the friction-measurement layer (operator metrics).

The console reads the ledger but never repairs it autonomously. status, next, doctor, and the active-context resolvers are all read-only.

### Why Two Layers

Splitting these responsibilities lets each layer be reasoned about independently:

- The ledger's correctness is checkable against persisted state.
- The console's behavior is checkable as deterministic functions over that state.
- Failures in one do not poison the other: doctor and status remain useful even when an in-flight deployment is stuck.
- Operator-console features can ship without touching the ledger contract.

The README presents the same split as a one-line claim per layer. Everything below is the depth that claim points at.

## Operating Model

MAW commands operate on the current working directory. A workspace is just a directory containing the expected state, artifact, protocol, and instruction files.

Primary workspace folders:

- state/: workflow state, plans, approvals, reviews, consensus, metrics, scores, memory, and reports.
- artifacts/: indexed task outputs and run artifacts.
- protocols/: durable operating protocols.
- instructions/: agent role instructions.

The runtime is designed around durable local evidence rather than hidden process memory. Most commands read and write specific files, and the operator manual lists those file surfaces command by command.

## Capability Insight

### Intent And Planning

MAW starts with intent capture. intent create records the objective, risk, constraints, and budget in state/intent_queue.json.

orchestrate then calls the configured model to convert an intent into:

- prompt contract
- task board entries
- deployment plan
- decision log updates

The orchestrator is not allowed to persist a high-severity invalid plan silently. Proposed plans are checked in memory through plan-check logic before persistence. High-severity defects trigger retries up to the configured retry limit.

Insight: planning is model-backed, but acceptance of a plan is constrained by local deterministic checks.

### Approval And Execution

approval record creates a human approval or rejection record. run expects approval before executing a deployment that requires it.

Execution supports three executor paths:

- dry_run: emits a delegation packet and does not create a real deliverable.
- model_agent: calls the configured model and stores a model output artifact.
- local_command: runs only allowlisted commands and only when the operator passes --execute.

Insight: execution is deliberately gated. Local command execution requires both configured allowlist permission and a runtime operator flag.

### Plan And Context Safety

plan-check audits deployments before approval or execution. It catches issues such as missing assignments, executor mismatches, dry-run misuse, missing reviewer coverage, missing artifacts, local command policy failures, and performance-gated routing defects.

context-check audits task context. It verifies workspace-relative paths, readable context files, dependency state, dependency artifacts, and transitive artifact availability for review and synthesis tasks.

Insight: MAW separates plan correctness from context sufficiency so operators can diagnose failures at the right level.

### Review And Consensus

Review-required deliverables are not verified by simple pass labels. MAW expects structured review records with per-criterion verdicts, citations, and rationale.

Consensus computation turns review records into a load-bearing verdict:

- pass
- fail
- split
- insufficient
- unverifiable

Risk controls reviewer fanout:

- low risk: 1 reviewer
- medium risk: 2 reviewers
- high risk: 3 reviewers

Insight: verified output is consensus-backed. Rubber-stamp reviews and legacy enum passes do not count as verified useful output.

### Scoring, Learning, And Performance

score computes workflow intelligence yield from state. It accounts for verified useful outputs, consensus outcomes, failed tasks, reruns, human interventions, and context failures.

retrospective turns plan-check and context-check defects into learning rules. Active rules are injected into future orchestrator prompts when they cross the configured confidence threshold.

performance update rebuilds per-agent performance memory from assignment history and consensus-backed outcomes. Future planning can use that history to avoid weak routing.

Insight: MAW feeds verified outcomes back into future planning, but the feedback remains local and inspectable.

### Operator Orientation And Navigation

The operator console layer answers four questions without inspecting JSON: where am I, what changed, what is next, and what is wrong.

- status renders workflow state, active intent/deployment/task, readiness flags, blockers, stale conditions, risky conditions, the next safe command, and a one-line reason.
- next prints exactly one recommended command. The optional --reason form adds the same one-line reason status would print.
- doctor diagnoses setup, environment, and workflow issues without modifying state. It surfaces missing API keys, reviewer coverage gaps, local-command policy issues, action-required chat, current high-severity plan-check issues, and failed context checks.
- Successful human-readable commands append transition guidance: workflow state, next command, and reason. JSON outputs and the report and bootstrap payloads remain untouched.

Insight: orientation is a deterministic read over current state. operatorState is read-only and never calls validateWorkspace.

### Implicit Active Context

When a deployment, intent, or task is active in operator state, --deployment, --intent, and --task become optional on the ten state-targeting commands. The CLI resolves the omitted flag through resolveActiveDeploymentId, resolveActiveIntentId, or resolveActiveTaskId, all of which read the same OperatorState the operator console renders.

Resolution rules:

- Explicit IDs always win. Passing --deployment DP-002 overrides the active deployment.
- The active context comes from the same interpreter that drives status. The two views always agree.
- If no active context exists for the requested kind, MAW emits a recovery packet pointing at maw status and refuses to run the command.

Resolution applies to: orchestrate, plan-check, run, approval record, score, retrospective, performance update, context-check, review record, and consensus compute.

Insight: implicit context is a UX shortcut, not a guess. The resolver delegates to operatorState and never invents an ID. The recovery packet on missing context keeps "no active context" from ever silently picking the wrong target.

### Auto-Plan Chain

maw plan is a sugar command that runs intent create, orchestrate, and plan-check in one call and stops at the approval gate. Approval, run, score, retrospective, and performance update remain explicit operator actions; the chain never auto-skips approval.

- The chain is intentionally narrow. It covers only the deterministic and orchestration stages where automation is safe.
- createIntent is the first step, so its input validation (non-empty --text, --risk in low/medium/high) refuses bad input before any state is written.
- If orchestrate fails mid-chain, the intent stays in status new with no deployment. The operator can re-run maw orchestrate (which now defaults to the active intent) to retry without recreating the intent.
- If plan-check returns high-severity issues, plan exits 1 and prints the issues. The deployment is still persisted so doctor and orchestrate can repair it.

Insight: chaining lives one layer above the workflow primitives. It composes existing functions rather than reshaping the contract, and approval remains the immovable gate.

### Structured Recovery

Expected recoverable failures emit a structured packet rather than a bare error:

- Error
- Why
- State Safety
- Corrective Command
- Then

Unknown errors fall through to a concise message. MAW does not invent recovery advice for failures it does not recognize.

Insight: recovery packets keep the operator on a known repair path while preserving honest behavior for unclassified errors.

### Safe Extensibility

Sanctioned scaffold paths let operators extend the system without hand-editing JSON or generating CLI source.

- scaffold agent, scaffold reviewer, scaffold protocol, and scaffold command write only to state/agent_registry.json or protocols/<safe-name>.md.
- Scaffolds default permissions to false, refuse duplicate IDs and existing protocol files, and reject unsafe paths or shell metacharacters.
- scaffold command creates a local-command execution profile only. It does not generate new MAW CLI source commands. Local execution still requires deployment approval and run --execute.
- Output includes Changed, Rollback, Next, and Reason so each extension is reversible and auditable.

Insight: extension is governed and reversible. The product surface is intentionally bounded.

### Operator Experience Metrics

MAW records a small local operator-experience record at the CLI entry point.

- State file: state/operator_experience.json.
- Stored fields: normalized command family names, outcomes, timestamps, workflow state values, and safe workflow IDs already used by MAW state.
- Not stored: intent text, approval scope, prompt text, review text, protocol body, command arguments, or any raw argv tokens.
- Recording is best-effort. Pre-init invocations do not create state. The metrics command itself never records itself.
- Derived metrics include next-step coverage, invalid command rate, help invocation rate, successful error recovery rate, extension success rate, time to first successful workflow, and commands before successful deployment.

Insight: metrics measure the friction of the operator console, not the productivity of the human operator. They are local only with no external telemetry.

### Bootstrap Readiness

bootstrap creates a session-readiness packet with:

- continuity frame
- counter-context frame
- posture
- posture reasons
- required extra review
- architecture metadata

It is deterministic and local. It does not call models, call network services, run validateWorkspace, or mutate operational state unless --persist is supplied.

Postures:

- normal: no escalation.
- wide_scan: wider review is needed before acting.
- governed: architecture or risky work promoted wide_scan into governed review.
- ask_human: stop and get human direction.

The current D4 behavior adds a deterministic governed-promotion reason only when architecture or risky work promotes wide_scan to governed.

The current D3 behavior adds continuity.architecture metadata for known local source candidates. This includes entry points and key modules with path, role, and evidence.

Insight: bootstrap is readiness support, not full source understanding. It tells the operator what it saw, what it did not inspect, and how cautious the next action should be.

## Architecture View

### Entry Points

- src/index.ts: executable entry. It imports createCli and parses process arguments.
- src/cli.ts: command surface. It wires CLI commands to runtime modules.

### Schema And Persistence

- src/schemas.ts: Zod schema authority for persisted state and bootstrap packets.
- src/storage.ts: JSON and text persistence helpers.
- src/workspace.ts: workspace initialization and seed templates.

### Workflow Runtime

- src/orchestrator.ts: intent-to-plan orchestration.
- src/runner.ts: approved deployment execution and reviewer spawning.
- src/approvals.ts: approval recording and lookup.
- src/artifacts.ts: artifact indexing helpers.
- src/agents.ts: agent registry access helpers.
- src/metrics.ts: metrics updates.

### Verification Runtime

- src/planCheck.ts: deployment plan checks.
- src/contextCheck.ts: scoped context checks.
- src/reviews.ts: review persistence and migration.
- src/consensus.ts: structured review consensus.
- src/validator.ts: workspace validation.

### Intelligence And Reporting

- src/scoring.ts: workflow score computation.
- src/retrospective.ts: retrospective and learning memory.
- src/performance.ts: agent performance memory.
- src/report.ts: workflow reporting.
- src/reviewerPrompts.ts: structured reviewer prompts.
- src/intelligenceCommon.ts: shared intelligence utilities.

### Readiness

- src/bootstrap.ts: continuity collection, counter-context collection, posture evaluation, architecture metadata, and Markdown rendering for bootstrap packets.

### Operator Console

- src/operatorState.ts: workflow-state interpreter; reads workspace stores and returns workflow state, active objects, readiness flags, blockers, stale and risky conditions, and a single recommended next command. Also exports resolveActiveDeploymentId, resolveActiveIntentId, and resolveActiveTaskId for implicit-context defaults.
- src/operatorDoctor.ts: read-only diagnostics that produce findings with repair guidance.
- src/operatorGuidance.ts: transition guidance renderer for successful human-readable commands.
- src/operatorRecovery.ts: structured recovery packet matcher and renderer for known recoverable failures.
- src/scaffold.ts: sanctioned extension scaffolds for agents, reviewers, protocols, and local-command profiles.
- src/autoPlan.ts: maw plan chain over intent create, orchestrate, and plan-check; stops at the approval gate. Accepts an optional ModelClient for tests.
- src/operatorExperience.ts: local friction metrics, command-family classification, event log, derived metrics, and report rendering.
- src/operatorEntrypoint.ts: CLI wrapper that classifies the invocation, preserves recovery packet behavior, and records best-effort metrics.

## Data Flow

Typical data flow:

1. init creates missing workspace files.
2. intent create appends a new intent.
3. orchestrate reads intent, registry, model config, memory, and artifact index, then writes a prompt contract, tasks, deployment plan, decisions, metrics, and updated intent state.
4. plan-check writes durable plan-check results.
5. approval record writes approval state and updates deployment status.
6. run reads approved plan state, executes tasks, writes artifacts, updates task and deployment state, records metrics, and spawns reviewers when needed.
7. consensus compute writes load-bearing consensus.
8. score writes workflow score.
9. retrospective writes learning memory and retrospective records.
10. performance update writes performance ledger and agent performance projections.
11. report reads current state and prints a Markdown handoff view.
12. bootstrap reads local readiness signals and optionally persists a readiness packet.

Operator console flow runs alongside the workflow flow:

- status, next, and doctor read state and orient the operator without modifying anything.
- Successful commands emit transition guidance so the operator sees workflow state and next command without inspecting JSON.
- Recoverable failures emit structured repair packets; unknown failures fall through to a concise message.
- Scaffold commands write only sanctioned artifacts under state/agent_registry.json or protocols/<safe-name>.md.
- The CLI entry point records normalized friction events to state/operator_experience.json on a best-effort basis. Pre-init invocations do not create state, and operator metrics never records itself.

This flow keeps planning, approval, execution, verification, scoring, learning, handoff, and operator orientation as distinct audit stages.

## Safety Boundaries

MAW is conservative about side effects:

- init does not overwrite existing files.
- plan-check and context-check are deterministic state checks.
- bootstrap does not mutate operational state unless --persist is supplied.
- local_command execution requires an allowlisted command and --execute.
- model calls are limited to orchestrate, model_agent run tasks, and automatic structured reviewers.
- runtime folders are ignored by git.
- status, next, and doctor are read-only and never call validateWorkspace.
- Operator-experience metrics are local only and do not store raw argv or free-form user text.
- Pre-init help and invalid command invocations do not create state or the metrics file.
- Scaffold mutations are limited to state/agent_registry.json or protocols/<safe-name>.md, and scaffold command does not generate MAW CLI source.
- createIntent validates --text and --risk before any disk write; invalid values refuse with a recovery packet and leave state/intent_queue.json untouched.
- orchestrate refuses any intent that already has a deployment in state/deployment_plan.json or whose status is no longer new, regardless of how that state arose. The deployment-plan check runs first so partial-write windows still refuse.
- maw plan never auto-skips approval. Approval, run, score, retrospective, and performance update remain explicit operator actions.

The most important operator boundary is approval. A plan can exist without being safe to execute. Approval records the human decision to proceed or reject.

## Documentation Model

The documentation set is split by depth and audience. Each document avoids duplicating the others:

- README.md is the front door. It states each MAW concept in one sentence and points the reader here for depth.
- docs/project-overview-and-capability-insight.md (this document) is the depth view. It takes each README concept and unpacks the why, the bound, and the implementing module.
- docs/operator-manual.md is the command reference. It documents per-command inputs, reads, writes, model behavior, recovery packets, and operator checklists.
- docs/operational-demonstrations.md is the scenario playbook. It walks through twenty-five demos covering normal operation, failures, verification, recovery, extension, and handoff.

This split avoids one document trying to serve every reader. Quick orientation lives in the README. Design rationale lives here. Command syntax lives in the manual. Worked scenarios live in the demonstration suite.

## Current Maturity

Current strengths:

- Local file-backed audit trail.
- Explicit approval gate.
- Deterministic plan and context checks.
- Structured review and consensus model.
- Honest handling of legacy reviews as abstentions.
- Score, retrospective, and performance feedback loops.
- Bootstrap readiness with posture and architecture metadata.
- Repository hygiene enforcement for grave accent removal.
- State-aware operator console with status, next, doctor, transition guidance, and structured recovery packets.
- Implicit active-deployment, intent, and task context across the ten state-targeting commands.
- maw plan sugar chain that stops at the approval gate.
- Sanctioned scaffold paths for agents, reviewers, protocols, and local-command profiles.
- Input validation that refuses invalid risk levels, empty intent text, and re-orchestration of intents that already have a deployment, before any state is written.
- Local operator-experience metrics that surface friction signals without persisting raw user text.

Current constraints:

- Orchestration and model-agent execution depend on configured model access.
- Bootstrap architecture metadata is bounded to known source candidates.
- The project does not perform full static architecture analysis.
- Runtime state is local and ignored; handoff requires explicit report or persisted packets.
- Manual review records are non-load-bearing unless represented as valid structured evidence.

Known deferred scope:

- Full architecture discovery beyond deterministic bootstrap candidates.
- Additional CLI behavior for architecture metadata beyond bootstrap packet population and rendering.
- Runtime state inclusion in source-controlled documentation.

## Operator Insight

MAW is most useful when treated as a disciplined workflow ledger plus a state-aware operator console:

- Use status to orient before acting.
- Use next when you want a single recommended command without scanning state.
- Use doctor before deciding to repair or escalate.
- Use maw plan when the work is well-scoped and you want intent, orchestration, and plan-check in one shot; review the resulting plan before recording approval.
- Use intent create when you want to think between stages; orchestrate, plan-check, and approval record will default --intent and --deployment to the active context.
- Treat approval scope as the execution contract.
- Treat artifacts as the evidence surface.
- Treat consensus as the verification gate.
- Treat score and retrospective as feedback, not decoration.
- Treat bootstrap posture as the session-start risk signal.
- Treat scaffold paths as the only sanctioned way to extend the system.
- Treat operator metrics as a local friction signal for the console itself, not a productivity score for the human.

The core habit is simple: do not rely on memory or trust labels. Make the workflow leave inspectable evidence at each stage, and let the operator console show you that evidence without opening JSON.

## Verification Expectations

Standard repository gates:

    npm run build
    npm run lint
    npm test

Focused gates:

    npm test -- tests/bootstrap.test.ts
    npm test -- tests/repositoryHygiene.test.ts

Diff and runtime checks:

    git diff --check
    git status -sb -- state artifacts dist node_modules

Documentation must preserve the repository hygiene rule: tracked files contain zero grave accent characters.
