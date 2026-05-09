# Project Overview And Capability Insight

This document explains what MAW is, what it can do, where its boundaries are, and how the current codebase is organized. It is written for operators, implementers, and reviewers who need a product-level view before using the command reference.

For command syntax, use [operator-manual.md](operator-manual.md). For scenario practice, use [operational-demonstrations.md](operational-demonstrations.md).

## Product Identity

MAW is a local, file-backed multi-agent workflow runtime. It is implemented as a TypeScript Node CLI and stores workflow evidence in local JSON and Markdown files.

The product goal is not to make agentic work invisible. The goal is to make it inspectable:

- Intent is recorded before planning.
- Plans are persisted before execution.
- Human approval is explicit.
- Execution creates artifacts.
- Review-required deliverables need structured evidence.
- Consensus is computed from review records.
- Scores and retrospectives preserve learning.
- Reports and bootstrap packets support handoff.

MAW treats workflow state as an audit surface. The operator should be able to inspect what happened, why it happened, and what evidence supports the result.

## Current Repository Baseline

- Package: maw 0.1.0
- Runtime: Node.js 20 or newer
- Language: TypeScript with ECMAScript modules
- Entry point: src/index.ts
- CLI surface: src/cli.ts
- Built target: dist/src/index.js
- Current release baseline: 6d68de0 chore: expand bootstrap continuity architecture
- Main reference docs: README.md, docs/operator-manual.md, docs/operational-demonstrations.md

The repository is source-focused. state/, artifacts/, dist/, and node_modules/ are intentionally ignored and should not be treated as product source.

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

This flow keeps planning, approval, execution, verification, scoring, learning, and handoff as distinct audit stages.

## Safety Boundaries

MAW is conservative about side effects:

- init does not overwrite existing files.
- plan-check and context-check are deterministic state checks.
- bootstrap does not mutate operational state unless --persist is supplied.
- local_command execution requires an allowlisted command and --execute.
- model calls are limited to orchestrate, model_agent run tasks, and automatic structured reviewers.
- runtime folders are ignored by git.

The most important operator boundary is approval. A plan can exist without being safe to execute. Approval records the human decision to proceed or reject.

## Documentation Model

The documentation set is split by purpose:

- README.md is the front door and quick orientation.
- docs/project-overview-and-capability-insight.md is the product and capability view.
- docs/operator-manual.md is the command reference.
- docs/operational-demonstrations.md is the scenario playbook.

This split avoids one document trying to serve every reader.

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

MAW is most useful when treated as a disciplined workflow ledger:

- Use intent create before planning.
- Treat plan-check as the approval precondition.
- Treat approval scope as the execution contract.
- Treat artifacts as the evidence surface.
- Treat consensus as the verification gate.
- Treat score and retrospective as feedback, not decoration.
- Treat bootstrap posture as the session-start risk signal.

The core habit is simple: do not rely on memory or trust labels. Make the workflow leave inspectable evidence at each stage.

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
