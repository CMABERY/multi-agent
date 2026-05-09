# MAW: Multi-Agent Workflow Runtime

MAW is a local, file-backed TypeScript Node CLI for auditable multi-agent workflows. It turns operator intent into structured plans, approval gates, task execution records, review evidence, consensus, scores, retrospectives, performance memory, and handoff reports.

The project is intentionally local-first. Commands operate on the current working directory, source remains in git, and live workflow data stays in ignored runtime folders.

## Current Repository State

- Repository path: C:\Multi-Agent
- Branch: master
- Remote: origin https://github.com/CMABERY/multi-agent
- Current verified release HEAD: 6d68de0 chore: expand bootstrap continuity architecture
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

MAW currently provides:

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
- Bootstrap readiness packets with continuity, counter-context, posture, and architecture metadata.

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

Completed and released:

- Bootstrap git status cap semantics fix.
- Repository-wide removal of literal grave accent characters from tracked files.
- D4 governed-promotion reason marker for bootstrap governed posture.
- D3 bootstrap continuity architecture schema, runtime collection, Markdown rendering, docs, tests, commit, and push.

Known deferred scope:

- Bootstrap architecture metadata is bounded to known local source candidates; it is not full static architecture analysis.
- Runtime state and artifacts are intentionally excluded from source control and from this README.
