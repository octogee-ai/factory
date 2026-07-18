import { isValidModelRef } from "./agent-models.js";

export type ChannelSessionModelOperation =
  | { operation: "getSessionModel"; agentId: string }
  | { operation: "listModels"; agentId: string }
  | { operation: "listModelsByProvider"; agentId: string; provider: string }
  | { operation: "setSessionModel"; agentId: string; modelRef: string }
  | { operation: "resetSessionModel"; agentId: string };

const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
const AGENT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,255})$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}

function isOperationBody(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasValidAgentId(body: Record<string, unknown>): boolean {
  return typeof body.agentId === "string" && AGENT_ID.test(body.agentId);
}

function parseSimpleOperation(body: Record<string, unknown>): ChannelSessionModelOperation | null {
  return exactKeys(body, ["operation", "agentId"]) ? body as ChannelSessionModelOperation : null;
}

function parseProviderOperation(body: Record<string, unknown>): ChannelSessionModelOperation | null {
  const valid = exactKeys(body, ["operation", "agentId", "provider"])
    && typeof body.provider === "string"
    && IDENTIFIER.test(body.provider);
  return valid ? body as ChannelSessionModelOperation : null;
}

function parseSetOperation(body: Record<string, unknown>): ChannelSessionModelOperation | null {
  const valid = exactKeys(body, ["operation", "agentId", "modelRef"])
    && typeof body.modelRef === "string"
    && isValidModelRef(body.modelRef);
  return valid ? body as ChannelSessionModelOperation : null;
}

export function parseChannelSessionModelOperation(value: unknown): ChannelSessionModelOperation | null {
  if (!isOperationBody(value) || !hasValidAgentId(value)) return null;
  const body = value;
  switch (body.operation) {
    case "getSessionModel":
    case "listModels":
    case "resetSessionModel":
      return parseSimpleOperation(body);
    case "listModelsByProvider":
      return parseProviderOperation(body);
    case "setSessionModel":
      return parseSetOperation(body);
    default:
      return null;
  }
}

export function channelSessionModelCommand(operation: ChannelSessionModelOperation): string {
  switch (operation.operation) {
    case "getSessionModel": return "/status";
    case "listModels": return "/models";
    case "listModelsByProvider": return `/models ${operation.provider}`;
    case "setSessionModel": return `/model ${operation.modelRef}`;
    case "resetSessionModel": return "/model default";
  }
}
