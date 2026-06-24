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
  const jobs = new Set<JobKey>();
  const reasons: string[] = [];
  let everything = false;

  for (const path of changedPaths) {
    if (isGlobal(path)) {
      everything = true;
      reasons.push(`global:${path}`);
      continue;
    }
    if (isInert(path)) {
      reasons.push(`inert:${path}`);
      continue;
    }
    const owner = ownerOf(path);
    if (owner) {
      for (const j of owner.jobs) jobs.add(j);
    } else {
      everything = true;
      reasons.push(`unmapped:${path}`);
    }
    for (const edge of EDGES) {
      if (path.startsWith(edge.when)) {
        for (const j of edge.jobs) jobs.add(j);
        reasons.push(`edge:${edge.when}`);
      }
    }
  }

  if (everything) {
    return { jobs: [...ALL_JOBS], everything: true, reasons };
  }
  return { jobs: [...jobs].sort(), everything: false, reasons };
}

export interface GhaOutputs {
  any: boolean;
  test_matrix: UnitPackage[];
  run_app: boolean;
  run_firestore_rules: boolean;
  run_customer_lifecycle_emulator: boolean;
  run_functions_emulator: boolean;
  run_gateway_edge_emulator: boolean;
}

export function toGhaOutputs(result: ScopeResult): GhaOutputs {
  const has = (j: JobKey) => result.jobs.includes(j);
  return {
    any: result.jobs.length > 0,
    test_matrix: UNIT_PACKAGES.filter((p) => has(p.name)),
    run_app: has("app"),
    run_firestore_rules: has("firestore-rules"),
    run_customer_lifecycle_emulator: has("customer-lifecycle-emulator"),
    run_functions_emulator: has("functions-emulator"),
    run_gateway_edge_emulator: has("gateway-edge-emulator"),
  };
}

// $GITHUB_OUTPUT key=value lines; test_matrix is single-line JSON for fromJSON().
export function serializeGhaOutputs(out: GhaOutputs): string {
  return [
    `any=${out.any}`,
    `test_matrix=${JSON.stringify(out.test_matrix)}`,
    `run_app=${out.run_app}`,
    `run_firestore_rules=${out.run_firestore_rules}`,
    `run_customer_lifecycle_emulator=${out.run_customer_lifecycle_emulator}`,
    `run_functions_emulator=${out.run_functions_emulator}`,
    `run_gateway_edge_emulator=${out.run_gateway_edge_emulator}`,
  ].join("\n");
}
