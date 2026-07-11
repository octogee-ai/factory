import path from "node:path";
import {
  type DependencyException,
  type DependencyInventory,
  type DependencyReferenceIdentity,
  matchesExactReference,
} from "./dependency-inventory.js";

export interface DependabotIgnore {
  dependencyName: string;
  updateTypes: string[];
}

export interface DependabotUpdate {
  ecosystem: string;
  directory: string;
  interval?: string;
  day?: string;
  time?: string;
  timezone?: string;
  ignores: DependabotIgnore[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function scalar(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(.+?)\\s*$`));
  return match ? unquote(match[1].replace(/\s+#.*$/, "")) : undefined;
}

function stringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new Error(`Expected YAML string array, got ${value}`);
  return trimmed.slice(1, -1).split(",").map((entry) => unquote(entry)).filter(Boolean);
}

export function parseDependabotConfig(source: string): DependabotUpdate[] {
  const updates: DependabotUpdate[] = [];
  let current: DependabotUpdate | undefined;
  let inIgnore = false;
  let currentIgnore: DependabotIgnore | undefined;
  for (const line of source.split(/\r?\n/)) {
    const ecosystem = scalar(line, "package-ecosystem");
    if (ecosystem) {
      if (current) updates.push(current);
      current = { ecosystem, directory: "", ignores: [] };
      inIgnore = false;
      currentIgnore = undefined;
      continue;
    }
    if (!current) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= 4 && /^\s*ignore:\s*$/.test(line)) {
      inIgnore = true;
      continue;
    }
    if (indent <= 4 && /^\s*[A-Za-z-]+:/.test(line) && !/^\s*(directory|schedule):/.test(line)) {
      inIgnore = false;
      currentIgnore = undefined;
    }
    const directory = scalar(line, "directory");
    if (directory && indent === 4) current.directory = directory;
    for (const key of ["interval", "day", "time", "timezone"] as const) {
      const value = scalar(line, key);
      if (value && indent >= 6 && !inIgnore) current[key] = value;
    }
    if (inIgnore) {
      const dependencyName = scalar(line, "dependency-name");
      if (dependencyName) {
        currentIgnore = { dependencyName, updateTypes: [] };
        current.ignores.push(currentIgnore);
      }
      const updateTypes = scalar(line, "update-types");
      if (updateTypes && currentIgnore) currentIgnore.updateTypes = stringArray(updateTypes);
    }
  }
  if (current) updates.push(current);
  for (const update of updates) {
    if (!update.directory) throw new Error(`Dependabot ${update.ecosystem} update has no directory`);
  }
  return updates;
}

function dependencyDirectory(reference: DependencyReferenceIdentity): string {
  const directory = path.posix.dirname(reference.path);
  return directory === "." ? "/" : `/${directory}`;
}

export function auditDependabotCoverage(input: {
  inventory: DependencyInventory;
  updates: DependabotUpdate[];
  exceptions: DependencyException[];
  now?: Date;
}): { errors: string[]; managedReferences: DependencyReferenceIdentity[] } {
  const errors: string[] = [];
  const managedReferences: DependencyReferenceIdentity[] = [];
  const npmUpdates = input.updates.filter(({ ecosystem }) => ecosystem === "npm");
  const scheduleException = input.exceptions.some((exception) =>
    exception.kind === "coverage" && exception.manager === "dependabot" &&
    exception.policyGaps?.some((gap) => gap.includes("weekly")),
  );
  for (const reference of input.inventory.references.filter(({ referenceKind }) =>
    referenceKind === "npm" || referenceKind === "npm-lockfile")) {
    const directory = dependencyDirectory(reference);
    const matchingUpdates = npmUpdates.filter((update) => update.directory === directory);
    const matchingExceptions = input.exceptions.filter((exception) =>
      exception.kind === "coverage" && exception.manager === "dependabot" &&
      exception.references?.some((candidate) => matchesExactReference(reference, candidate)),
    );
    if (matchingUpdates.length > 1) errors.push(`${reference.path}: duplicate Dependabot npm entries`);
    if (matchingUpdates.length === 1) managedReferences.push(reference);
    else if (matchingExceptions.length !== 1) errors.push(`npm-lockfile ${reference.path}: no Dependabot entry or exact exception`);
  }
  for (const update of npmUpdates) {
    if (update.interval !== "daily" && !scheduleException) {
      errors.push(`${update.directory}: npm discovery is ${update.interval ?? "unset"}, not weekday`);
    }
    for (const ignore of update.ignores) {
      const ignoredReferences = input.inventory.references.filter((reference) =>
        reference.referenceKind === "npm" && dependencyDirectory(reference) === update.directory &&
        reference.packageName === ignore.dependencyName,
      );
      if (ignoredReferences.length === 0) {
        errors.push(`${update.directory}:${ignore.dependencyName}: ignore matches no direct dependency`);
      }
      for (const reference of ignoredReferences) {
        const matching = input.exceptions.filter((exception) =>
          exception.kind === "compatibility" && exception.references?.some((candidate) => matchesExactReference(reference, candidate)),
        );
        if (matching.length !== 1) {
          errors.push(`${reference.path}:${reference.packageName}: expected one exact compatibility exception, found ${matching.length}`);
        }
      }
    }
  }
  return { errors, managedReferences };
}
