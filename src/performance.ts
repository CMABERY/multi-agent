import {
  AgentRegistrySchema,
  ConsensusStoreSchema,
  PerformanceLedgerSchema,
  type Agent,
  type PerformanceLedgerEntry
} from "./schemas.js";
import { isDeliverableTask, loadDeploymentContext } from "./intelligenceCommon.js";
import { loadJson, loadJsonOrDefault, nowIso, saveJson } from "./storage.js";

const emptyPerformance = {
  tasks_assigned: 0,
  tasks_completed: 0,
  tasks_failed: 0,
  review_passes: 0,
  review_failures: 0,
  dry_run_deliverable_mismatches: 0,
  average_score_contribution: 0,
  known_failure_modes: [] as string[]
};

export async function updateAgentPerformance(
  root: string,
  input: { deploymentId: string }
): Promise<Agent[]> {
  const { plan, tasks } = await loadDeploymentContext(root, input.deploymentId);
  const registry = AgentRegistrySchema.parse(await loadJson(root, "state/agent_registry.json"));
  const ledger = PerformanceLedgerSchema.parse(
    await loadJsonOrDefault(root, "state/performance_ledger.json", { entries: [] })
  );
  const consensusStore = ConsensusStoreSchema.parse(
    await loadJsonOrDefault(root, "state/consensus.json", { consensus_records: [] })
  );
  const deltas = computeDeploymentDeltas({
    deploymentId: plan.deployment_id,
    assignments: plan.assignments,
    tasks,
    consensusByTask: new Map(
      consensusStore.consensus_records
        .filter((consensus) => consensus.is_load_bearing)
        .map((consensus) => [consensus.task_id, consensus.overall_verdict])
    )
  });

  ledger.entries = [
    ...ledger.entries.filter((entry) => entry.deployment_id !== plan.deployment_id),
    ...deltas
  ];
  applyLedgerToRegistry(registry.agents, ledger.entries);

  await saveJson(root, "state/performance_ledger.json", ledger);
  await saveJson(root, "state/agent_registry.json", registry);
  return registry.agents;
}

function computeDeploymentDeltas(input: {
  deploymentId: string;
  assignments: Array<{ task_id: string; agent_id: string }>;
  tasks: Array<{
    task_id: string;
    status: string;
    executor: string;
    output_required: string;
    blocker?: string;
  }>;
  consensusByTask: Map<string, "pass" | "fail" | "split" | "insufficient">;
}): PerformanceLedgerEntry[] {
  const taskById = new Map(input.tasks.map((task) => [task.task_id, task]));
  const byAgent = new Map<string, PerformanceLedgerEntry>();
  const now = nowIso();

  for (const assignment of input.assignments) {
    const task = taskById.get(assignment.task_id);
    if (!task) continue;
    const entry = byAgent.get(assignment.agent_id) ?? {
      deployment_id: input.deploymentId,
      agent_id: assignment.agent_id,
      tasks_assigned: 0,
      tasks_completed: 0,
      tasks_failed: 0,
      review_passes: 0,
      review_failures: 0,
      dry_run_deliverable_mismatches: 0,
      known_failure_modes: [],
      updated_at: now
    };

    entry.tasks_assigned += 1;
    if (task.status === "completed" || task.status === "approved") entry.tasks_completed += 1;
    if (task.status === "failed") entry.tasks_failed += 1;
    if (task.executor === "dry_run" && isDeliverableTask(task as any)) {
      entry.dry_run_deliverable_mismatches += 1;
    }
    const consensusVerdict = input.consensusByTask.get(task.task_id);
    if (consensusVerdict === "pass") entry.review_passes += 1;
    else if (consensusVerdict) entry.review_failures += 1;
    if (
      task.blocker &&
      (task.status === "failed" || task.status === "blocked") &&
      !entry.known_failure_modes.includes(task.blocker)
    ) {
      entry.known_failure_modes.push(task.blocker);
    }
    byAgent.set(assignment.agent_id, entry);
  }

  return Array.from(byAgent.values());
}

function applyLedgerToRegistry(agents: Agent[], entries: PerformanceLedgerEntry[]): void {
  for (const agent of agents) {
    const aggregate = structuredClone(emptyPerformance);
    const agentEntries = entries.filter((entry) => entry.agent_id === agent.agent_id);
    for (const entry of agentEntries) {
      aggregate.tasks_assigned += entry.tasks_assigned;
      aggregate.tasks_completed += entry.tasks_completed;
      aggregate.tasks_failed += entry.tasks_failed;
      aggregate.review_passes += entry.review_passes;
      aggregate.review_failures += entry.review_failures;
      aggregate.dry_run_deliverable_mismatches += entry.dry_run_deliverable_mismatches;
      for (const mode of entry.known_failure_modes) {
        if (!aggregate.known_failure_modes.includes(mode)) aggregate.known_failure_modes.push(mode);
      }
    }
    aggregate.average_score_contribution = computeScoreContribution(aggregate);
    agent.performance = aggregate;
  }
}

function computeScoreContribution(performance: NonNullable<Agent["performance"]>): number {
  if (performance.tasks_assigned === 0) return 0;
  const positive = performance.tasks_completed + performance.review_passes;
  const negative =
    performance.tasks_failed +
    performance.review_failures +
    performance.dry_run_deliverable_mismatches;
  return Math.max(0, positive - negative) / performance.tasks_assigned;
}
