import {
  dependencyReferenceId,
  type DependencyReferenceIdentity,
} from "./dependency-inventory.js";

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

interface PackageFileGroup {
  manager: string;
  packageFile: string;
  deps: unknown[];
}

function appendMappedGroups(value: Record<string, unknown>, groups: PackageFileGroup[]): boolean {
  if (!isRecord(value.packageFiles)) return false;
  for (const [manager, entries] of Object.entries(value.packageFiles)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.packageFile === "string" && Array.isArray(entry.deps)) {
        groups.push({ manager, packageFile: entry.packageFile, deps: entry.deps });
      }
    }
  }
  return true;
}

function appendDirectGroup(value: Record<string, unknown>, groups: PackageFileGroup[]): boolean {
  if (typeof value.packageFile !== "string" || !Array.isArray(value.deps)) return false;
  groups.push({ manager: "unknown", packageFile: value.packageFile, deps: value.deps });
  return true;
}

function packageFileGroups(value: unknown, groups: PackageFileGroup[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) packageFileGroups(entry, groups);
    return;
  }
  if (!isRecord(value)) return;
  if (appendMappedGroups(value, groups) || appendDirectGroup(value, groups)) return;
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

function parseOutputLines(source: string): unknown[] {
  const values: unknown[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`Renovate output line ${index + 1} is not JSON: ${String(error)}`);
    }
  }
  return values;
}

function dependencyReference(
  group: PackageFileGroup,
  raw: unknown,
  index: number,
): DependencyReferenceIdentity | undefined {
  if (!isRecord(raw)) return undefined;
  const packageName = raw.depName ?? raw.packageName;
  const currentValue = raw.currentValue ?? raw.currentVersion;
  if (typeof packageName !== "string" || typeof currentValue !== "string") return undefined;
  const managerData = isRecord(raw.managerData) ? raw.managerData : {};
  const explicitKey = typeof raw.octogeeKey === "string" ? raw.octogeeKey : undefined;
  const kind = referenceKind(group.manager);
  const fallbackKey = kind === "dockerfile"
    ? `from:${String(managerData.lineNumber ?? index)}`
    : `${kind}:${index}`;
  return {
    referenceKind: kind,
    path: group.packageFile,
    key: explicitKey ?? fallbackKey,
    packageName,
    currentValue,
  };
}

function referencesFromGroups(groups: PackageFileGroup[]): DependencyReferenceIdentity[] {
  const references: DependencyReferenceIdentity[] = [];
  const seenGroups = new Set<string>();
  for (const group of groups) {
    const signature = JSON.stringify([group.manager, group.packageFile, group.deps]);
    if (seenGroups.has(signature)) continue;
    seenGroups.add(signature);
    for (const [index, raw] of group.deps.entries()) {
      const reference = dependencyReference(group, raw, index);
      if (reference) references.push(reference);
    }
  }
  return references;
}

export function parseRenovateExtractOutput(source: string): DependencyReferenceIdentity[] {
  const groups: PackageFileGroup[] = [];
  for (const value of parseOutputLines(source)) packageFileGroups(value, groups);
  const unique = new Map(
    referencesFromGroups(groups).map((reference) => [dependencyReferenceId(reference), reference]),
  );
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
