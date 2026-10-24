import { readFile } from "node:fs/promises";
import { isValidUsername } from "../../shared/types/identity.js";
import { builderClaimSlug } from "@octogee/shared/server/builder-claim";

interface PersistenceClientDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  readToken: (path: string) => Promise<string>;
}
const defaults: PersistenceClientDeps = {
  env: process.env, fetch, readToken: path => readFile(path, "utf8"),
};

export async function persistBuilderProjects(slug: string, deps: PersistenceClientDeps = defaults): Promise<void> {
  if (!isValidUsername(slug) || builderClaimSlug(deps.env) !== slug) throw new Error("project flush requires this Builder's slug");
  return persistCustomerFiles(slug, deps);
}

export async function persistSharedCustomerFiles(slug: string, deps: PersistenceClientDeps = defaults): Promise<void> {
  if (deps.env.GATEWAY_CLASS !== "shared" || !isValidUsername(slug)) throw new Error("Shared checkpoint requires its gateway identity and customer slug");
  return persistCustomerFiles(slug, deps);
}

async function persistCustomerFiles(slug: string, deps: PersistenceClientDeps): Promise<void> {
  const token = (await deps.readToken(deps.env.OCTOGEE_API_SA_TOKEN_PATH || "/var/run/secrets/octogee-gateway-broker/token")).trim();
  if (!token) throw new Error("project flush has no gateway credential");
  const response = await deps.fetch(`${(deps.env.GATEWAY_EDGE_INTERNAL_URL || "http://127.0.0.1:3001").replace(/\/$/u, "")}/internal/projects/flush`, {
    method: "POST", headers: { "content-type": "application/json", "x-k8s-sa-token": token },
    body: JSON.stringify({ slug }), signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) throw new Error(`project remote save failed: HTTP ${response.status}; retain local work`);
  const result = await response.json() as { projects?: unknown };
  if (!Number.isSafeInteger(result.projects) || Number(result.projects) < 0) throw new Error("project remote save acknowledgement is invalid");
}

export async function persistAssignedSharedCustomers(deps: {
  readCustomers: () => Promise<readonly { slug: string }[]>;
  persist: (slug: string) => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  for (const customer of await deps.readCustomers()) {
    try { await deps.persist(customer.slug); }
    catch (error) { deps.log(`[project-autosave:${customer.slug}] ${String(error)}; local work retained`); }
  }
}

export function startProjectAutosave(deps: { save: () => Promise<void>; log: (message: string) => void }, intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await deps.save(); }
    catch (error) { deps.log(`[project-autosave] ${String(error)}; local work retained`); }
    finally { running = false; }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
