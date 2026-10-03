import {
  ALL_JOBS,
  EDGES,
  GLOBAL_EXACT,
  GLOBAL_PREFIX,
  OWNERSHIP,
  UNIT_PACKAGES,
  isInert,
  type JobKey,
  type UnitPackage,
} from "./manifest.js";

export type { JobKey } from "./manifest.js";

export interface ScopeResult {
  jobs: JobKey[];
  everything: boolean;
  reasons: string[];
}

interface ScopeAccumulator {
  jobs: Set<JobKey>;
  reasons: string[];
  everything: boolean;
}

function isGlobal(path: string): boolean {
  if (GLOBAL_EXACT.has(path)) return true;
  return GLOBAL_PREFIX.some((pre) => path.startsWith(pre));
}

function ownerOf(path: string): (typeof OWNERSHIP)[number] | undefined {
  let best: (typeof OWNERSHIP)[number] | undefined;
  for (const o of OWNERSHIP) {
    if (path.startsWith(o.dir) && (!best || o.dir.length > best.dir.length)) {
      best = o;
    }
  }
  return best;
}

/**
 * The CI test jobs a diff must run. Pure. Fail-open: any repo-wide path or any
 * path no package owns escalates to the full set; an empty diff runs nothing.
 * The CLI passes `everything` itself when the diff base is unusable.
 */
export function resolveScope(changedPaths: string[]): ScopeResult {
  const acc: ScopeAccumulator = {
    jobs: new Set<JobKey>(),
    reasons: [],
    everything: false,
  };

  for (const path of changedPaths) {
    addPathScope(acc, path);
  }

  if (acc.everything) {
    return { jobs: [...ALL_JOBS], everything: true, reasons: acc.reasons };
  }
  return { jobs: [...acc.jobs].sort(), everything: false, reasons: acc.reasons };
}

function addPathScope(acc: ScopeAccumulator, path: string): void {
  if (markGlobalOrInert(acc, path)) {
    return;
  }

  addOwnerScope(acc, path);
  addEdgeScopes(acc, path);
}

function markGlobalOrInert(acc: ScopeAccumulator, path: string): boolean {
  if (isGlobal(path)) {
    acc.everything = true;
    acc.reasons.push(`global:${path}`);
    return true;
  }
  if (isInert(path)) {
    acc.reasons.push(`inert:${path}`);
    return true;
  }

  return false;
}

function addOwnerScope(acc: ScopeAccumulator, path: string): void {
  const owner = ownerOf(path);
  if (!owner) {
    acc.everything = true;
    acc.reasons.push(`unmapped:${path}`);
    return;
  }

  addJobs(acc.jobs, owner.jobs);
  acc.reasons.push(`owner:${owner.dir}`);
}

function addEdgeScopes(acc: ScopeAccumulator, path: string): void {
  for (const edge of EDGES) {
    if (!path.startsWith(edge.when)) continue;
    addJobs(acc.jobs, edge.jobs);
    acc.reasons.push(`edge:${edge.when}`);
  }
}

function addJobs(target: Set<JobKey>, jobs: readonly JobKey[]): void {
  for (const job of jobs) {
    target.add(job);
  }
}

export interface GhaOutputs {
  any: boolean;
  test_matrix: UnitPackage[];
  run_app: boolean;
  run_desktop_package: boolean;
  run_firestore_rules: boolean;
  run_customer_lifecycle_emulator: boolean;
  run_functions_emulator: boolean;
  run_gateway_edge_emulator: boolean;
  run_glm_controller_emulator: boolean;
  run_octogee_api_emulator: boolean;
}

export function toGhaOutputs(result: ScopeResult): GhaOutputs {
  const has = (j: JobKey) => result.jobs.includes(j);
  return {
    any: result.jobs.length > 0,
    test_matrix: UNIT_PACKAGES.filter((p) => has(p.name)),
    run_app: has("app"),
    run_desktop_package: has("desktop-package"),
    run_firestore_rules: has("firestore-rules"),
    run_customer_lifecycle_emulator: has("customer-lifecycle-emulator"),
    run_functions_emulator: has("functions-emulator"),
    run_gateway_edge_emulator: has("gateway-edge-emulator"),
    run_glm_controller_emulator: has("glm-controller-emulator"),
    run_octogee_api_emulator: has("octogee-api-emulator"),
  };
}

// $GITHUB_OUTPUT key=value lines; test_matrix is single-line JSON for fromJSON().
export function serializeGhaOutputs(out: GhaOutputs): string {
  return [
    `any=${out.any}`,
    `test_matrix=${JSON.stringify(out.test_matrix)}`,
    `run_app=${out.run_app}`,
    `run_desktop_package=${out.run_desktop_package}`,
    `run_firestore_rules=${out.run_firestore_rules}`,
    `run_customer_lifecycle_emulator=${out.run_customer_lifecycle_emulator}`,
    `run_functions_emulator=${out.run_functions_emulator}`,
    `run_gateway_edge_emulator=${out.run_gateway_edge_emulator}`,
    `run_glm_controller_emulator=${out.run_glm_controller_emulator}`,
    `run_octogee_api_emulator=${out.run_octogee_api_emulator}`,
  ].join("\n");
}
