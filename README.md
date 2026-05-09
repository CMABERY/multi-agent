# MAW: Multi-Agent Workflow Runtime

MAW runs auditable multi-agent workflows from a local TypeScript Node CLI and exposes them through a state-aware operator console. Intent becomes a deployment plan, plans become approved deployments, deployments produce artifacts, artifacts are verified by structured-evidence reviews and load-bearing consensus, and the entire trace lives as inspectable JSON and Markdown in the working directory.

## What Makes MAW Distinctive

- Honest verification. Review-required deliverables are accepted only when load-bearing consensus passes with cited evidence. Rubber-stamp passes do not count.
- An explicit approval gate. A plan can exist without being safe to execute. Approval records the human decision and is never auto-skipped.
- A state-aware operator console. status, next, and doctor orient the operator from current state. Successful commands emit transition guidance. Recoverable failures emit structured repair packets with Error, Why, State Safety, Corrective Command, and Then.
- Implicit active context. Once a deployment, intent, or task is active, --deployment, --intent, and --task default to it. Explicit IDs still override.
- Sanctioned extension. scaffold agent, scaffold reviewer, scaffold protocol, and scaffold command extend the registry and protocol library without hand-editing JSON or generating CLI source.
- Sugar chains, not auto-pilots. maw plan chains intent create, orchestrate, and plan-check in one shot, then stops at the approval gate.
- Local-first by contract. No external telemetry. state/operator_experience.json records normalized command families and outcomes, never raw user text. State stays in ignored runtime folders.

## Two Layers Over One Workspace

MAW is one product organized as two layers:

- The workflow ledger turns intent into evidence. Plan, approval, execution, review, consensus, score, retrospective, and performance memory each leave durable artifacts in state/ and artifacts/. Nothing is pass-by-label; verification rests on cited evidence and load-bearing consensus.
- The operator console sits on top of that ledger and answers four questions without forcing the operator into JSON: where am I, what changed, what is next, and what is wrong. It also defines the only sanctioned ways to extend the system and records local friction metrics for the console itself.

For the depth view of how the layers compose, what each module does, why each concept exists, and how each is bounded, see [docs/project-overview-and-capability-insight.md](docs/project-overview-and-capability-insight.md).

## Quick Start

Install and build:

    npm install
    npm run build

Initialize and orient:

    node dist/src/index.js init
    node dist/src/index.js status
    node dist/src/index.js next
    node dist/src/index.js doctor

Run the standard gates:

    npm run build
    npm run lint
    npm test

## Normal Operation

A typical run moves through these stages:

1. Capture intent.
2. Orchestrate a deployment plan.
3. Run plan and context checks.
4. Record human approval.
5. Execute the approved deployment.
6. Verify review-required deliverables through structured reviews and consensus.
7. Score the workflow.
8. Run a retrospective.
9. Refresh performance memory.
10. Produce a report or handoff packet.

Stages 1 through 3 can be chained in one command when the work is well-scoped:

    node dist/src/index.js plan --text "Build a verified demo artifact." --risk medium

maw plan stops at the approval gate. Approval, run, score, retrospective, and performance update remain explicit operator actions.

For the full step-by-step command reference, see [docs/operator-manual.md](docs/operator-manual.md). For scenario practice, see [docs/operational-demonstrations.md](docs/operational-demonstrations.md).

## Repository State

- Repository path: C:\Multi-Agent
- Branch: master
- Remote: origin https://github.com/CMABERY/multi-agent
- Current verified release HEAD: 8348a44 fix: validate risk level and intent text in createIntent
- Package: maw 0.1.0
- Runtime: Node.js 20 or newer
- Language: TypeScript with ECMAScript modules
- Built target: dist/src/index.js

Ignored runtime data:

- state/
- artifacts/
- dist/
- node_modules/

## Documentation Map

Four documents serve four readers. Each sits at a different depth and avoids duplicating the others:

- This README is the front door. Conceptual orientation, what makes MAW different, quick start, and pointers to deeper docs.
- [docs/project-overview-and-capability-insight.md](docs/project-overview-and-capability-insight.md) is the depth view. Per-concept rationale, capability boundaries, the architecture of every module, data flow, safety boundaries, and operator philosophy.
- [docs/operator-manual.md](docs/operator-manual.md) is the command reference. Per-command inputs, reads, writes, model behavior, recovery packets, and operator checklists.
- [docs/operational-demonstrations.md](docs/operational-demonstrations.md) is the scenario playbook. Twenty-five demos covering normal operation, failures, verification, recovery, extension, and handoff.

Seeded runtime guidance also lives under protocols/ (durable workflow protocols) and instructions/ (agent role instructions).

## Repository Hygiene

Tracked files must contain zero grave accent characters (ASCII code 96). Documentation uses indented command blocks and plain text instead of fenced blocks or inline code markers.

Standard verification:

    npm run build
    npm run lint
    npm test
    git diff --check

Focused checks:

    npm test -- tests/repositoryHygiene.test.ts
    npm test -- tests/bootstrap.test.ts

Runtime status check:

    git status -sb -- state artifacts dist node_modules
