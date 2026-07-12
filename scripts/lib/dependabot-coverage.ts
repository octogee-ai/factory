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
  const content = line.trimStart().replace(/^-[ \t]*/, "");
  const prefix = `${key}:`;
  if (!content.startsWith(prefix)) return undefined;
  const value = content.slice(prefix.length).trim();
  const comment = value.indexOf(" #");
  return unquote(comment === -1 ? value : value.slice(0, comment));
}

function indentation(line: string): number {
  let length = 0;
  while (line[length] === " ") length += 1;
  return length;
}

function yamlKey(line: string): string | undefined {
  const content = line.trimStart().replace(/^-[ \t]*/, "");
  const separator = content.indexOf(":");
  return separator === -1 ? undefined : content.slice(0, separator);
}

function stringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new Error(`Expected YAML string array, got ${value}`);
  return trimmed.slice(1, -1).split(",").map((entry) => unquote(entry)).filter(Boolean);
}

interface DependabotParseState {
  updates: DependabotUpdate[];
  current?: DependabotUpdate;
  currentIgnore?: DependabotIgnore;
  inIgnore: boolean;
}

function beginUpdate(state: DependabotParseState, ecosystem: string): void {
  if (state.current) state.updates.push(state.current);
  state.current = { ecosystem, directory: "", ignores: [] };
  state.currentIgnore = undefined;
  state.inIgnore = false;
}

function parseScheduleLine(current: DependabotUpdate, line: string, indent: number): void {
  if (indent < 6) return;
  for (const key of ["interval", "day", "time", "timezone"] as const) {
    const value = scalar(line, key);
    if (value) current[key] = value;
  }
}

function parseIgnoreLine(state: DependabotParseState, line: string): void {
  const dependencyName = scalar(line, "dependency-name");
  if (dependencyName) {
    state.currentIgnore = { dependencyName, updateTypes: [] };
    state.current?.ignores.push(state.currentIgnore);
  }
  const updateTypes = scalar(line, "update-types");
  if (updateTypes && state.currentIgnore) {
    state.currentIgnore.updateTypes = stringArray(updateTypes);
  }
}

function parseUpdateLine(state: DependabotParseState, line: string): void {
  const current = state.current;
  if (!current) return;
  const indent = indentation(line);
  const key = yamlKey(line);
  if (indent <= 4 && key === "ignore") {
    state.inIgnore = true;
    return;
  }
  if (indent <= 4 && key && !["directory", "schedule"].includes(key)) {
    state.inIgnore = false;
    state.currentIgnore = undefined;
  }
  const directory = scalar(line, "directory");
  if (directory && indent === 4) current.directory = directory;
  if (state.inIgnore) parseIgnoreLine(state, line);
  else parseScheduleLine(current, line, indent);
}

export function parseDependabotConfig(source: string): DependabotUpdate[] {
  const state: DependabotParseState = { updates: [], inIgnore: false };
  for (const line of source.split(/\r?\n/)) {
    const ecosystem = scalar(line, "package-ecosystem");
    if (ecosystem) beginUpdate(state, ecosystem);
    else parseUpdateLine(state, line);
  }
  if (state.current) state.updates.push(state.current);
  const updates = state.updates;
  for (const update of updates) {
    if (!update.directory) throw new Error(`Dependabot ${update.ecosystem} update has no directory`);
  }
  return updates;
}

function dependencyDirectory(reference: DependencyReferenceIdentity): string {
  const directory = path.posix.dirname(reference.path);
  return directory === "." ? "/" : `/${directory}`;
}

interface DependabotAuditInput {
  inventory: DependencyInventory;
  updates: DependabotUpdate[];
  exceptions: DependencyException[];
  now?: Date;
}

function exactExceptions(
  input: DependabotAuditInput,
  reference: DependencyReferenceIdentity,
  kind: "compatibility" | "coverage",
): DependencyException[] {
  return input.exceptions.filter((exception) =>
    exception.kind === kind &&
    (kind !== "coverage" || exception.manager === "dependabot") &&
    exception.references?.some((candidate) => matchesExactReference(reference, candidate)),
  );
}

function auditReference(
  input: DependabotAuditInput,
  npmUpdates: DependabotUpdate[],
  reference: DependencyReferenceIdentity,
  errors: string[],
  managedReferences: DependencyReferenceIdentity[],
): void {
  const matchingUpdates = npmUpdates.filter(
    (update) => update.directory === dependencyDirectory(reference),
  );
  const matchingExceptions = exactExceptions(input, reference, "coverage");
  if (matchingUpdates.length > 1) {
    errors.push(`${reference.path}: duplicate Dependabot npm entries`);
  }
  if (matchingUpdates.length === 1) managedReferences.push(reference);
  else if (matchingExceptions.length !== 1) {
    errors.push(`npm-lockfile ${reference.path}: no Dependabot entry or exact exception`);
  }
}

function auditIgnore(
  input: DependabotAuditInput,
  update: DependabotUpdate,
  ignore: DependabotIgnore,
  errors: string[],
): void {
  const references = input.inventory.references.filter((reference) =>
    reference.referenceKind === "npm" &&
    dependencyDirectory(reference) === update.directory &&
    reference.packageName === ignore.dependencyName,
  );
  if (references.length === 0) {
    errors.push(`${update.directory}:${ignore.dependencyName}: ignore matches no direct dependency`);
  }
  for (const reference of references) {
    const matching = exactExceptions(input, reference, "compatibility");
    if (matching.length !== 1) {
      errors.push(
        `${reference.path}:${reference.packageName}: expected one exact compatibility exception, found ${matching.length}`,
      );
    }
  }
}

export function auditDependabotCoverage(input: DependabotAuditInput): {
  errors: string[];
  managedReferences: DependencyReferenceIdentity[];
} {
  const errors: string[] = [];
  const managedReferences: DependencyReferenceIdentity[] = [];
  const npmUpdates = input.updates.filter(({ ecosystem }) => ecosystem === "npm");
  const scheduleException = input.exceptions.some((exception) =>
    exception.kind === "coverage" && exception.manager === "dependabot" &&
    exception.policyGaps?.some((gap) => gap.includes("weekly")),
  );
  for (const reference of input.inventory.references.filter(({ referenceKind }) =>
    referenceKind === "npm" || referenceKind === "npm-lockfile")) {
    auditReference(input, npmUpdates, reference, errors, managedReferences);
  }
  for (const update of npmUpdates) {
    if (update.interval !== "daily" && !scheduleException) {
      errors.push(`${update.directory}: npm discovery is ${update.interval ?? "unset"}, not weekday`);
    }
    for (const ignore of update.ignores) auditIgnore(input, update, ignore, errors);
  }
  return { errors, managedReferences };
}
