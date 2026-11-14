import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";

import { DEFAULT_K8S_CA_PATH, DEFAULT_K8S_SA_TOKEN_PATH } from "./token-review.js";

export const DEFAULT_K8S_NAMESPACE_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

export interface PodLookupRequest {
  url: string;
  bearerToken: string;
  ca?: string;
}

export type PodLookupTransport = (input: PodLookupRequest) => Promise<{ status: number }>;

export type GatewayPodExists = (podName: string) => Promise<boolean>;

export interface GatewayPodPresenceOptions {
  transport?: PodLookupTransport;
  apiHost?: string;
  apiPort?: string;
  tokenPath?: string;
  caPath?: string;
  namespacePath?: string;
}

const defaultTransport: PodLookupTransport = (input) => new Promise((resolve, reject) => {
  const request = httpsRequest(input.url, {
    method: "GET",
    headers: { Authorization: `Bearer ${input.bearerToken}`, Accept: "application/json" },
    ...(input.ca ? { ca: input.ca } : {}),
  }, (response) => {
    response.resume();
    response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
    response.on("error", reject);
  });
  request.on("error", reject);
  request.end();
});

export function createGatewayPodPresence(opts: GatewayPodPresenceOptions = {}): GatewayPodExists {
  const transport = opts.transport ?? defaultTransport;
  return async (podName) => {
    const apiHost = opts.apiHost ?? process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
    const apiPort = opts.apiPort ?? process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
    const [bearerToken, ca, namespace] = await Promise.all([
      readFile(opts.tokenPath ?? DEFAULT_K8S_SA_TOKEN_PATH, "utf8").then((token) => token.trim()),
      readFile(opts.caPath ?? DEFAULT_K8S_CA_PATH, "utf8").catch(() => undefined),
      readFile(opts.namespacePath ?? DEFAULT_K8S_NAMESPACE_PATH, "utf8").then((value) => value.trim()),
    ]);
    const { status } = await transport({
      url: `https://${apiHost}:${apiPort}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`,
      bearerToken,
      ...(ca ? { ca } : {}),
    });
    if (status === 200) return true;
    if (status === 404) return false;
    throw new Error(`pod lookup HTTP ${status}`);
  };
}
