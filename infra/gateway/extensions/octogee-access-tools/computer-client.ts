import { readFile } from "node:fs/promises";

export interface ComputerContext {
  gatewayId: string;
  ownerUid: string;
  vmInstanceId: string;
  agentAccountId: string;
  ownerMattermostUserId: string | null;
}

export interface ComputerBrokerOptions {
  agentId: string;
  signal: AbortSignal;
  brokerUrl?: string;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
  readTokenImpl?: (path: string) => Promise<string>;
}

function parseComputerContext(body: unknown): ComputerContext {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid computer context");
  const data = body as Record<string, unknown>;
  if (typeof data.gatewayId !== "string" || !data.gatewayId ||
    typeof data.ownerUid !== "string" || !data.ownerUid ||
    typeof data.vmInstanceId !== "string" || !/^\d+$/u.test(data.vmInstanceId) ||
    typeof data.agentAccountId !== "string" || !data.agentAccountId ||
    (data.ownerMattermostUserId !== null && (typeof data.ownerMattermostUserId !== "string" || !/^[a-z0-9]{26}$/u.test(data.ownerMattermostUserId)))) {
    throw new Error("Invalid computer context");
  }
  return { gatewayId: data.gatewayId, ownerUid: data.ownerUid, vmInstanceId: data.vmInstanceId,
    agentAccountId: data.agentAccountId, ownerMattermostUserId: data.ownerMattermostUserId };
}

async function computerContextFailure(response: Response): Promise<Error> {
  const failure = new Error(`Computer context request failed (${response.status})`);
  if (response.status !== 409) return failure;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure;
  }
  if (body && typeof body === "object" && "error" in body && body.error === "computer-unavailable") {
    return new Error("Computer is unavailable (computer-unavailable): the gateway or VM is not ready. Retry when the computer is running.");
  }
  return failure;
}

export async function computerContext(options: ComputerBrokerOptions): Promise<ComputerContext> {
  const readToken = options.readTokenImpl ?? ((path: string) => readFile(path, "utf8"));
  const token = (await readToken(options.tokenPath ?? "/var/run/octogee/api-token/token")).trim();
  const baseUrl = options.brokerUrl ?? process.env.FLEET_BROKER_URL ?? process.env.OCTOGEE_API_URL ??
    `http://octogee-api.${process.env.K8S_NAMESPACE ?? "octogee"}.svc.cluster.local:3001`;
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/$/u, "")}/internal/agent-access/computer-context`, {
    method: "POST",
    headers: { "x-k8s-sa-token": token, "content-type": "application/json" },
    body: JSON.stringify({ agentId: options.agentId }),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) throw await computerContextFailure(response);
  return parseComputerContext(await response.json());
}
