import { AgentRegistrySchema, AgentSchema, type Agent } from "./schemas.js";
import { loadJson, saveJson } from "./storage.js";

export async function registerAgent(root: string, agent: Agent): Promise<Agent> {
  const parsedAgent = AgentSchema.parse(agent);
  const registry = AgentRegistrySchema.parse(await loadJson(root, "state/agent_registry.json"));
  const existingIndex = registry.agents.findIndex((entry) => entry.agent_id === parsedAgent.agent_id);
  if (existingIndex >= 0) {
    registry.agents[existingIndex] = parsedAgent;
  } else {
    registry.agents.push(parsedAgent);
  }
  await saveJson(root, "state/agent_registry.json", registry);
  return parsedAgent;
}

export async function getAgent(root: string, agentId: string): Promise<Agent> {
  const registry = AgentRegistrySchema.parse(await loadJson(root, "state/agent_registry.json"));
  const agent = registry.agents.find((entry) => entry.agent_id === agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  return agent;
}
