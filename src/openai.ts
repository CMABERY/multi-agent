import { ModelConfigSchema, type ModelConfig, type ModelTier } from "./schemas.js";
import { loadJson } from "./storage.js";

export interface ModelRequest {
  model?: string;
  instructions: string;
  input: string;
  maxOutputTokens?: number;
  tools?: ModelTool[];
  toolChoice?: ModelToolChoice;
  include?: string[];
}

export interface ModelTool {
  type: string;
  [key: string]: unknown;
}

export type ModelToolChoice = "auto" | "required" | "none" | Record<string, unknown>;

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ModelResponse {
  text: string;
  truncated: boolean;
  status?: string;
  reason?: string;
  usage?: ModelUsage;
}

export interface ModelClient {
  createResponse(request: ModelRequest): Promise<ModelResponse>;
}

export class OpenAIResponsesClient implements ModelClient {
  constructor(private readonly config: ModelConfig) {}

  async createResponse(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = process.env[this.config.api_key_env];
    if (!apiKey) {
      throw new Error("Missing OpenAI API key environment variable: " + (this.config.api_key_env));
    }

    const body: Record<string, unknown> = {
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: request.maxOutputTokens ?? this.config.max_output_tokens
    };
    if (request.tools && request.tools.length > 0) body.tools = request.tools;
    if (request.toolChoice) body.tool_choice = request.toolChoice;
    if (request.include && request.include.length > 0) body.include = request.include;

    const response = await fetch("" + (this.config.base_url) + "/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + (apiKey),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error("OpenAI Responses API request failed (" + (response.status) + "): " + (body));
    }

    const data: unknown = await response.json();
    const status = stringProperty(data, "status");
    const incompleteDetails = recordProperty(data, "incomplete_details");
    const reason = incompleteDetails ? stringProperty(incompleteDetails, "reason") : undefined;
    return {
      text: extractResponseText(data),
      truncated: status === "incomplete" || reason === "max_output_tokens",
      status,
      reason,
      usage: extractUsage(data)
    };
  }
}

export async function createDefaultModelClient(root: string): Promise<OpenAIResponsesClient> {
  const config = ModelConfigSchema.parse(await loadJson(root, "state/model_config.json"));
  return new OpenAIResponsesClient(config);
}

export async function loadModelConfig(root: string): Promise<ModelConfig> {
  return ModelConfigSchema.parse(await loadJson(root, "state/model_config.json"));
}

export function selectModel(config: ModelConfig, tier: ModelTier | "orchestrator", explicit?: string): string {
  if (explicit) return explicit;
  if (tier === "orchestrator") return config.default_models.orchestrator;
  return config.default_models[tier];
}

export function estimateModelCostUsd(
  config: ModelConfig,
  model: string,
  usage: ModelUsage | undefined
): number {
  if (!usage) return 0;
  const pricing = config.pricing[model];
  if (!pricing) return 0;
  return (
    (usage.input_tokens / 1_000_000) * pricing.input_per_1m_usd +
    (usage.output_tokens / 1_000_000) * pricing.output_per_1m_usd
  );
}

function extractResponseText(data: unknown): string {
  const outputText = stringProperty(data, "output_text");
  if (outputText) return outputText;
  const output = arrayProperty(data, "output");
  const chunks: string[] = [];
  for (const item of output) {
    const content = arrayProperty(item, "content");
    for (const part of content) {
      const text = stringProperty(part, "text");
      const partOutputText = stringProperty(part, "output_text");
      if (text) chunks.push(text);
      if (partOutputText) chunks.push(partOutputText);
    }
  }
  if (chunks.length > 0) return chunks.join("\n");
  return JSON.stringify(data) ?? "";
}

function extractUsage(data: unknown): ModelUsage | undefined {
  const usage = recordProperty(data, "usage");
  if (!usage) return undefined;
  const inputTokens = numberProperty(usage, "input_tokens");
  const outputTokens = numberProperty(usage, "output_tokens");
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return isRecord(property) ? property : undefined;
}

function arrayProperty(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const property = value[key];
  return Array.isArray(property) ? property : [];
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "number" ? property : undefined;
}
