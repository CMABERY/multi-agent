# MAW: Multi-Agent Workflow Runtime

MAW runs auditable multi-agent workflows from a local TypeScript Node CLI and exposes them through a state-aware operator console. Intent becomes a deployment plan, plans become approved deployments, deployments produce artifacts, artifacts are verified by structured-evidence reviews and load-bearing consensus, and the entire trace lives as inspectable JSON and Markdown in the working directory.

What makes MAW distinctive:

- Honest verification. Review-required deliverables are accepted only when load-bearing consensus passes with cited evidence; rubber-stamp passes do not count.
- An explicit approval gate. Plans can exist without being safe to execute; approval records the human decision and is never auto-skipped.
- A state-aware operator console. status, next, and doctor orient the operator from current state; successful commands emit transition guidance; recoverable failures emit structured repair packets with Error, Why, State Safety, Corrective Command, and Then.
- Implicit active context. Once a deployment, intent, or task is active, --deployment, --intent, and --task default to it. Explicit IDs still override.
- Sanctioned extension. scaffold agent, scaffold reviewer, scaffold protocol, and scaffold command extend the registry and protocol library without hand-editing JSON or generating CLI source.
- Sugar chains, not auto-pilots. maw plan chains intent create, orchestrate, and plan-check in one shot, then stops at the approval gate.
- Local-first by contract. No external telemetry. state/operator_experience.json records normalized command families and outcomes, never raw user text. State stays in ignored runtime folders.

Commands operate on the current working directory, source remains in git, and live workflow data stays in ignored runtime folders.

## Current Repository State

- Repository path: C:\Multi-Agent
- Branch: master
- Remote: origin https://github.com/CMABERY/multi-agent
- Current verified release HEAD: 8348a44 fix: validate risk level and intent text in createIntent
- Package: maw 0.1.0
- Runtime: Node.js 20 or newer
- Language: TypeScript with ECMAScript modules
- CLI entry point: src/index.ts
- CLI command surface: src/cli.ts
- Package binary: maw
- Built target: dist/src/index.js

Ignored local data:

- state/
- artifacts/
- dist/
- node_modules/

## Quick Start

Install and build:

    npm install
    npm run build

Initialize and validate a workspace:

    node dist/src/index.js init
    node dist/src/index.js validate

Orient before choosing the next operation:

    node dist/src/index.js status
    node dist/src/index.js next
    node dist/src/index.js doctor

Inspect CLI help:

    node dist/src/index.js --help

Run the standard gates:

    npm run build
    npm run lint
    npm test

## Normal Workflow

A typical MAW run moves through these stages:

1. Record intent.
2. Orchestrate a deployment plan.
3. Run plan and context checks.
4. Record human approval.
5. Execute the approved deployment.
6. Verify review-required deliverables through structured reviews and consensus.
7. Score the workflow.
8. Run a retrospective.
9. Refresh performance memory.
10. Produce a report or handoff packet.

Representative command flow:

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

## Capability Map

Workflow capabilities:

- Local workspace initialization and seed templates.
- Intent capture with risk, constraints, and budget metadata.
- Model-backed orchestration into prompt contracts, task boards, and deployment plans.
- Human approval and rejection records.
- Approved deployment execution across dry_run, model_agent, and local_command executors.
- Local command allowlist enforcement and explicit --execute gating.
- Plan checks before approval or execution.
- Context checks for files, dependencies, and dependency artifacts.
- Structured review capture for review-required deliverables.
- Load-bearing consensus computation from review evidence.
- Legacy review migration to honest abstentions.
- Workflow intelligence yield scoring.
- Retrospectives that turn defects into learning memory.
- Performance memory for future routing decisions.
- Markdown reporting for handoff.

Operator console capabilities:

- State-aware status and next-command recommendations from a deterministic workflow-state interpreter.
- doctor diagnostics that flag setup, environment, and workflow issues without modifying state.
- Transition guidance appended to successful human-readable commands so operators see workflow state and next command without inspecting JSON.
- Structured recovery packets for known recoverable failures, with Error, Why, State Safety, Corrective Command, and Then.
- Implicit active-context defaults for --deployment, --intent, and --task across orchestrate, plan-check, run, approval record, score, retrospective, performance update, context-check, review record, and consensus compute. Explicit IDs still override.
- maw plan, a sugar command that chains intent create, orchestrate, and plan-check in one call and stops at the approval gate.
- Sanctioned scaffold paths for agents, reviewers, protocols, and local-command execution profiles, with rollback guidance and refusal of unsafe inputs.
- Input validation that refuses invalid risk levels, empty intent text, and re-orchestration of intents that already have a deployment, before any state is written.
- Local operator-experience metrics that record normalized command families, outcomes, and friction signals without storing raw user text.
- Bootstrap readiness packets with continuity, counter-context, posture, and architecture metadata. Bootstrap remains readiness and governance, not a dashboard.

## Documentation

Start here:

- [Project Overview And Capability Insight](docs/project-overview-and-capability-insight.md): product model, capability insight, architecture, boundaries, and maturity.
- [Operator Manual](docs/operator-manual.md): command reference with inputs, reads, writes, model behavior, and checklists.
- [Operational Demonstration Suite](docs/operational-demonstrations.md): scenario playbook for normal operation, failures, verification, recovery, and handoff.

Seeded runtime guidance:

- protocols/ contains durable workflow protocols.
- instructions/ contains agent role instructions.

## Source Layout

Entry points:

- src/index.ts: executable entry.
- src/cli.ts: CLI command surface.

Core runtime modules:

- src/schemas.ts: persisted state and packet schemas.
- src/workspace.ts: workspace initialization and seed templates.
- src/bootstrap.ts: session readiness and posture engine.
- src/orchestrator.ts: intent-to-plan orchestration.
- src/runner.ts: approved deployment execution and reviewer spawning.
- src/planCheck.ts: deployment plan pre-flight checks.
- src/contextCheck.ts: scoped context sufficiency checks.
- src/reviews.ts: review persistence and legacy migration.
- src/consensus.ts: structured review consensus.
- src/scoring.ts: workflow score computation.
- src/retrospective.ts: retrospective and learning memory.
- src/performance.ts: agent performance memory.
- src/report.ts: workflow reporting.
- src/validator.ts: state validation.
- src/storage.ts: JSON and text persistence helpers.

Operator console modules:

- src/operatorState.ts: deterministic workflow-state interpreter and active-context resolvers; read-only.
- src/operatorDoctor.ts: read-only diagnostic findings and repair guidance.
- src/operatorGuidance.ts: transition guidance renderer for successful commands.
- src/operatorRecovery.ts: structured recovery packets for known recoverable failures.
- src/scaffold.ts: sanctioned extension scaffolds for agents, reviewers, protocols, and local-command profiles.
- src/autoPlan.ts: maw plan chain over intent create, orchestrate, and plan-check; stops at the approval gate.
- src/operatorExperience.ts: local operator-experience metrics, command-family classification, and report rendering.
- src/operatorEntrypoint.ts: CLI wrapper that classifies the invocation, preserves recovery behavior, and records best-effort metrics.

## Model And Execution Boundaries

Commands that can call a model:

- orchestrate
- run when a task uses model_agent
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
- retrospective, unless it first computes missing score state
- performance update
- report
- bootstrap
- status
- next
- doctor
- scaffold agent, scaffold reviewer, scaffold protocol, scaffold command
- operator metrics

Commands that may call a model when invoked:

- orchestrate
- plan (calls orchestrate as part of the chain; plan-check is deterministic)
- run when any assignment uses model_agent
- automatic structured reviews spawned by run

Local command execution requires:

- A local_command agent.
- An allowlisted command.
- A deployment approval.
- The --execute flag on run.

## Bootstrap Readiness

bootstrap is the deterministic session-readiness command. It reads local source, selected state summaries, artifact index summaries, safe git metadata, and presence checks for dist/ and node_modules/.

It does not call models, call network services, run validateWorkspace, mutate operational state by default, or inspect dist/ and node_modules/ deeply.

Postures:

- normal: no escalation.
- wide_scan: wider review is needed before acting.
- governed: architecture or risky work promoted a wide_scan posture into governed review.
- ask_human: stop and get human direction.

Bootstrap also exposes continuity.architecture metadata for known entry points and key modules. This is bounded deterministic metadata, not full static analysis.

## Repository Hygiene

The repository has an explicit hygiene rule: tracked files must contain zero grave accent characters, ASCII code 96. Documentation should use indented command blocks and plain text instead of fenced blocks or inline code markers.

Standard verification:

    npm run build
    npm run lint
    npm test
    git diff --check

Focused checks:

    npm test -- tests/bootstrap.test.ts
    npm test -- tests/repositoryHygiene.test.ts

Runtime status check:

    git status -sb -- state artifacts dist node_modules

## Current Release Baseline

Current release: 8348a44 fix: validate risk level and intent text in createIntent.

Released in this baseline:

- Operator state interpreter and status, next, and doctor commands.
- Transition guidance appended to successful human-readable commands.
- Structured recovery packets for known recoverable failures, with bare-message fallback for unknown errors.
- Sanctioned scaffold paths for agent, reviewer, protocol, and local-command profile extensions.
- Local operator-experience metrics with normalized command families and no raw user text.
- Schema and workspace updates to seed state/operator_experience.json on init.
- Implicit active-context defaults for --deployment, --intent, and --task on the ten state-targeting commands.
- maw plan sugar command that chains intent create, orchestrate, and plan-check; stops at approval.
- Orchestrator guard that refuses any intent already holding a deployment or no longer in status new, even after a partial-write window.
- createIntent input validation that refuses invalid --risk values and empty --text before any state is written.

Earlier completed work still in effect:

- Bootstrap git status cap semantics fix.
- Repository-wide removal of literal grave accent characters from tracked files.
- D4 governed-promotion reason marker for bootstrap governed posture.
- D3 bootstrap continuity architecture schema, runtime collection, Markdown rendering, docs, tests, commit, and push.

Known deferred scope:

- Bootstrap architecture metadata is bounded to known local source candidates; it is not full static architecture analysis.
- Runtime state and artifacts are intentionally excluded from source control and from this README.
