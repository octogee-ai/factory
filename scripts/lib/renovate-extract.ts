import type { DependencyReferenceIdentity } from "./dependency-inventory.js";

export const RENOVATE_IMAGE = "renovate/renovate:43.259.0@sha256:f9a2ea77df854f3ceb94833b7345715a024bed4f33995d7c957db2707e9275c5";

export function buildRenovateExtractInvocation(repoRoot: string, uid: number): { command: string; args: string[] } {
  return {
    command: "docker",
    args: [
      "run", "--rm", "--pull=never", "--user", `${uid}:0`,
      "-e", "LOG_LEVEL=debug", "-e", "LOG_FORMAT=json",
      "-e", "RENOVATE_CONFIG_FILE=/repo/.github/renovate.json5",
      "-v", `${repoRoot}:/repo`, "-w", "/repo", RENOVATE_IMAGE,
      "--platform=local", "--dry-run=extract",
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageFileGroups(value: unknown, groups: Array<{ manager: string; packageFile: string; deps: unknown[] }>): void {
  if (Array.isArray(value)) {
    for (const entry of value) packageFileGroups(entry, groups);
    return;
  }
  if (!isRecord(value)) return;
  if (isRecord(value.packageFiles)) {
    for (const [manager, entries] of Object.entries(value.packageFiles)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (isRecord(entry) && typeof entry.packageFile === "string" && Array.isArray(entry.deps)) {
          groups.push({ manager, packageFile: entry.packageFile, deps: entry.deps });
        }
      }
    }
    return;
  }
  if (typeof value.packageFile === "string" && Array.isArray(value.deps)) {
    groups.push({ manager: "unknown", packageFile: value.packageFile, deps: value.deps });
    return;
  }
  for (const child of Object.values(value)) packageFileGroups(child, groups);
}

function referenceKind(manager: string): string {
  if (manager === "dockerfile") return "dockerfile";
  if (manager === "github-actions") return "github-action";
  if (manager === "helmv3") return "helm-chart";
  if (["helm-values", "kubernetes", "docker-compose", "cloudbuild"].includes(manager)) return "container-image";
  if (manager.startsWith("terraform")) return "terraform-provider";
  return manager;
}

export function parseRenovateExtractOutput(source: string): DependencyReferenceIdentity[] {
  const groups: Array<{ manager: string; packageFile: string; deps: unknown[] }> = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Renovate output line ${index + 1} is not JSON: ${String(error)}`);
    }
    packageFileGroups(parsed, groups);
  }
  const references: DependencyReferenceIdentity[] = [];
  const seenGroups = new Set<string>();
  for (const group of groups) {
    const signature = `${group.manager}:${group.packageFile}:${JSON.stringify(group.deps)}`;
    if (seenGroups.has(signature)) continue;
    seenGroups.add(signature);
    for (const [index, raw] of group.deps.entries()) {
      if (!isRecord(raw)) continue;
      const packageName = raw.depName ?? raw.packageName;
      const currentValue = raw.currentValue ?? raw.currentVersion;
      if (typeof packageName !== "string" || typeof currentValue !== "string") continue;
      const managerData = isRecord(raw.managerData) ? raw.managerData : {};
      const explicitKey = typeof raw.octogeeKey === "string" ? raw.octogeeKey : undefined;
      const kind = referenceKind(group.manager);
      const key = explicitKey ?? (kind === "dockerfile" ? `from:${String(managerData.lineNumber ?? index)}` : `${kind}:${index}`);
      references.push({ referenceKind: kind, path: group.packageFile, key, packageName, currentValue });
    }
  }
  const unique = new Map(references.map((reference) => [
    [reference.referenceKind, reference.path, reference.key, reference.packageName, reference.currentValue].join(":"),
    reference,
  ]));
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
