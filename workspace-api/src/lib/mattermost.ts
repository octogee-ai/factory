/**
 * Mattermost API client — uses K8s DNS, no env var IPs.
 *
 * In-cluster: http://mattermost.{namespace}.svc.cluster.local:8065
 */
import { logger } from "../middleware/logging";

const MM_URL =
  process.env.MM_URL ||
  `http://mattermost.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:8065`;

function getAdminToken(): string {
  const token = process.env.MM_ADMIN_TOKEN;
  if (!token) throw new Error("MM_ADMIN_TOKEN not configured");
  return token;
}

export async function mmApi(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
): Promise<unknown> {
  const authToken = token || getAdminToken();
  const url = `${MM_URL}/api/v4${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error(`MM API error: ${resp.status} ${method} ${path}`, {
      response: text.slice(0, 500),
    });
    throw new Error(`MM API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

export { MM_URL };
