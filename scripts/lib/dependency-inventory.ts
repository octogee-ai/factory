import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { deploymentTargetsForEnvironment } from "@octogee/core/deployment-environment";

export interface DependencyReferenceIdentity {
  referenceKind: string;
  path: string;
  key: string;
  packageName: string;
  currentValue: string;
}

export interface DependencyExclusion {
  referenceKind: string;
  path: string;
  key: string;
  rawValue: string;
  reason: "internal-artifact-registry" | "local-reference" | "dynamic-reference";
}

export interface DependencyInventory {
  references: DependencyReferenceIdentity[];
  exclusions: DependencyExclusion[];
}

export interface DependencyOwnershipRule {
  referenceKind: string;
  manager: "dependabot" | "renovate";
  pathPatterns: string[];
}

export interface ExceptionEvidence {
  kind: string;
  uri: string;
  observedAt: string;
  sha256?: string;
}

export interface DependencyException {
  id: string;
  kind: string;
  expiresAt: string;
  references?: DependencyReferenceIdentity[];
  reference?: DependencyReferenceIdentity;
  manager?: "dependabot" | "renovate";
  policyGaps?: string[];
  evidence?: ExceptionEvidence[];
  [key: string]: unknown;
}

interface ValidationResult {
  errors: string[];
}

export interface ExceptionValidationResult extends ValidationResult {
  exceptions: DependencyException[];
  coverageExceptions: DependencyException[];
}

export interface CoverageValidationResult extends ValidationResult {
  ownership: DependencyOwnershipRule[];
  probe?: {
    phase: string;
    directory: string;
    packageName: string;
    introducedByPrUrl: string;
    expiresAt: string;
  };
}

type DependencyProbe = NonNullable<CoverageValidationResult["probe"]>;

const skippedDirectories = new Set([
  ".claude",
  ".git",
  ".astro",
  ".firebase",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const textExtensions = new Set([
  "",
  ".json",
  ".json5",
  ".md",
  ".mjs",
  ".sh",
  ".tf",
  ".tpl",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

function posixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (skippedDirectories.has(entry.name)) continue;
        const relative = posixPath(path.relative(root, absolute));
        if (relative === "tests/fixtures/dependency-inventory") continue;
        walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  };
  walk(root);
  return files.sort();
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripInlineComment(value: string): string {
  const comment = value.indexOf(" #");
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

function yamlScalar(line: string, key: string): string | undefined {
  const content = line.trimStart().replace(/^-[ \t]*/, "");
  const prefix = `${key}:`;
  if (!content.startsWith(prefix)) return undefined;
  const value = stripInlineComment(content.slice(prefix.length));
  if (!value) return undefined;
  const unquoted = stripQuotes(value);
  const whitespace = unquoted.search(/\s/);
  return whitespace === -1 ? unquoted : unquoted.slice(0, whitespace);
}

function firstYamlScalar(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const value = yamlScalar(line, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

const INTERNAL_ARTIFACT_REGISTRY_PREFIXES = [...new Set(
  (["prod", "test", "build-week"] as const).flatMap((environment) =>
    deploymentTargetsForEnvironment(environment).map(
      (target) => `${target.artifactRegistryRepository}/`,
    ),
  ),
)];

function isInternalImage(value: string): boolean {
  return INTERNAL_ARTIFACT_REGISTRY_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
    value.includes("gcr.io/$PROJECT_ID/") || value.includes("${_REGION}-docker.pkg.dev/$PROJECT_ID/");
}

function classifyReference(value: string): DependencyExclusion["reason"] | undefined {
  if (/^(file|link|workspace):/.test(value) || value.startsWith("./") || value.startsWith("../")) {
    return "local-reference";
  }
  if (isInternalImage(value)) return "internal-artifact-registry";
  if (/[${]{1,2}/.test(value) || value.includes("{{")) return "dynamic-reference";
  return undefined;
}

function imageIdentity(value: string): { packageName: string; currentValue: string } {
  const withoutScheme = value.replace(/^docker:\/\//, "");
  const digestIndex = withoutScheme.indexOf("@sha256:");
  if (digestIndex >= 0) {
    return {
      packageName: withoutScheme.slice(0, digestIndex),
      currentValue: withoutScheme.slice(digestIndex + 1),
    };
  }
  const slash = withoutScheme.lastIndexOf("/");
  const colon = withoutScheme.lastIndexOf(":");
  if (colon > slash) {
    return {
      packageName: withoutScheme.slice(0, colon),
      currentValue: withoutScheme.slice(colon + 1),
    };
  }
  return { packageName: withoutScheme, currentValue: "latest" };
}

function pushImage(
  sink: Pick<DependencyInventory, "references" | "exclusions">,
  referenceKind: string,
  relativePath: string,
  key: string,
  rawValue: string,
): void {
  const value = stripInlineComment(stripQuotes(rawValue));
  const reason = classifyReference(value);
  if (reason) {
    sink.exclusions.push({ referenceKind, path: relativePath, key, rawValue: value, reason });
    return;
  }
  const identity = imageIdentity(value);
  sink.references.push({ referenceKind, path: relativePath, key, ...identity });
}

function scanNpm(
  root: string,
  files: string[],
  references: DependencyReferenceIdentity[],
  exclusions: DependencyExclusion[],
): void {
  for (const lockFile of files.filter((file) => path.basename(file) === "package-lock.json")) {
    const packageFile = path.join(path.dirname(lockFile), "package.json");
    let packageSource: string;
    let packageJson: Record<string, unknown>;
    try {
      packageSource = readFileSync(packageFile, "utf8");
      packageJson = JSON.parse(packageSource) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Cannot inventory ${posixPath(path.relative(root, lockFile))}: ${String(error)}`);
    }
    const lockSource = readFileSync(lockFile, "utf8");
    const relativePackage = posixPath(path.relative(root, packageFile));
    const relativeLock = posixPath(path.relative(root, lockFile));
    references.push({
      referenceKind: "npm-lockfile",
      path: relativeLock,
      key: "lockfile",
      packageName: String(packageJson.name ?? relativePackage),
      currentValue: sha256(`${packageSource}\0${lockSource}`),
    });
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const declarations = packageJson[field];
      if (!declarations || typeof declarations !== "object" || Array.isArray(declarations)) continue;
      for (const [packageName, rawValue] of Object.entries(declarations as Record<string, unknown>)) {
        if (typeof rawValue !== "string") throw new Error(`${relativePackage}:${field}.${packageName} is not a string`);
        const reason = classifyReference(rawValue);
        if (reason) {
          exclusions.push({
            referenceKind: "npm",
            path: relativePackage,
            key: `${field}.${packageName}`,
            rawValue,
            reason,
          });
        } else {
          references.push({
            referenceKind: "npm",
            path: relativePackage,
            key: `${field}.${packageName}`,
            packageName,
            currentValue: rawValue,
          });
        }
      }
    }
  }
}

function scanDockerfiles(
  root: string,
  files: string[],
  references: DependencyReferenceIdentity[],
  exclusions: DependencyExclusion[],
): void {
  for (const file of files.filter((candidate) => path.basename(candidate).startsWith("Dockerfile"))) {
    const relativePath = posixPath(path.relative(root, file));
    let index = 0;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*FROM(?:\s+--\S+)*\s+(\S+)/i);
      if (!match) continue;
      pushImage({ references, exclusions }, "dockerfile", relativePath, `from:${index}`, match[1]);
      index += 1;
    }
  }
}

function balancedBlock(source: string, openingBrace: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (char === '"') quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(openingBrace + 1, index);
  }
  throw new Error("Unbalanced configuration block");
}

function hclQuotedAttribute(source: string, key: string): string | undefined {
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key)) continue;
    const assignment = trimmed.slice(key.length).trimStart();
    if (!assignment.startsWith("=")) continue;
    const value = assignment.slice(1).trimStart();
    const quote = value[0];
    if (quote !== '"' && quote !== "'") continue;
    const end = value.indexOf(quote, 1);
    if (end > 0) return value.slice(1, end);
  }
  return undefined;
}

function hclBraceDelta(line: string): number {
  let delta = 0;
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote && line[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") delta += 1;
    else if (char === "}") delta -= 1;
  }
  return delta;
}

function topLevelHclAssignment(line: string, offset: number): { name: string; opening: number } | undefined {
  const leading = line.length - line.trimStart().length;
  const content = line.slice(leading);
  let nameEnd = 0;
  while (/[A-Za-z0-9_-]/.test(content[nameEnd] ?? "")) nameEnd += 1;
  if (nameEnd === 0) return undefined;
  let cursor = nameEnd;
  while (content[cursor] === " " || content[cursor] === "\t") cursor += 1;
  if (content[cursor] !== "=") return undefined;
  cursor += 1;
  while (content[cursor] === " " || content[cursor] === "\t") cursor += 1;
  if (content[cursor] !== "{") return undefined;
  return { name: content.slice(0, nameEnd), opening: offset + leading + cursor };
}

function topLevelHclAssignments(source: string): Array<{ name: string; opening: number }> {
  const assignments: Array<{ name: string; opening: number }> = [];
  let depth = 0;
  let offset = 0;
  for (const line of source.split("\n")) {
    if (depth === 0) {
      const assignment = topLevelHclAssignment(line, offset);
      if (assignment) assignments.push(assignment);
    }
    depth += hclBraceDelta(line);
    offset += line.length + 1;
  }
  return assignments;
}

function scanTerraformProviders(
  relativePath: string,
  source: string,
  references: DependencyReferenceIdentity[],
): void {
  for (const required of source.matchAll(/required_providers\s*\{/g)) {
    const opening = (required.index ?? 0) + required[0].lastIndexOf("{");
    const block = balancedBlock(source, opening);
    for (const provider of topLevelHclAssignments(block)) {
      const providerBlock = balancedBlock(block, provider.opening);
      const providerSource = hclQuotedAttribute(providerBlock, "source");
      if (!providerSource) continue;
      references.push({
        referenceKind: "terraform-provider",
        path: relativePath,
        key: `provider:${providerSource.split("/").at(-1)}`,
        packageName: providerSource,
        currentValue: hclQuotedAttribute(providerBlock, "version") ?? "unconstrained",
      });
    }
  }
}

function scanTerraformModules(
  relativePath: string,
  source: string,
  references: DependencyReferenceIdentity[],
): void {
  for (const moduleMatch of source.matchAll(/module\s+["']([^"']+)["']\s*\{/g)) {
    const opening = (moduleMatch.index ?? 0) + moduleMatch[0].lastIndexOf("{");
    let block: string;
    try {
      block = balancedBlock(source, opening);
    } catch (error) {
      throw new Error(`${relativePath}:module:${moduleMatch[1]}: ${String(error)}`);
    }
    const moduleSource = hclQuotedAttribute(block, "source");
    if (!moduleSource || moduleSource.startsWith(".")) continue;
    const ref = new URLSearchParams(moduleSource.split("?")[1] ?? "").get("ref");
    references.push({
      referenceKind: "terraform-module",
      path: relativePath,
      key: `module:${moduleMatch[1]}`,
      packageName: moduleSource.split("?")[0],
      currentValue: hclQuotedAttribute(block, "version") ?? ref ?? "unpinned",
    });
  }
}

function scanTerraform(root: string, files: string[], references: DependencyReferenceIdentity[]): void {
  for (const file of files.filter((candidate) => path.extname(candidate) === ".tf")) {
    const relativePath = posixPath(path.relative(root, file));
    const source = readFileSync(file, "utf8");
    scanTerraformProviders(relativePath, source, references);
    scanTerraformModules(relativePath, source, references);
  }
}

function scanHelmCharts(root: string, files: string[], references: DependencyReferenceIdentity[], exclusions: DependencyExclusion[]): void {
  for (const file of files.filter((candidate) => path.basename(candidate) === "Chart.yaml")) {
    const relativePath = posixPath(path.relative(root, file));
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trimStart().startsWith("-")) continue;
      const name = yamlScalar(lines[index], "name");
      if (!name) continue;
      const block = lines.slice(index, index + 8);
      const version = firstYamlScalar(block, "version");
      const repository = firstYamlScalar(block, "repository");
      if (!version || !repository) continue;
      const reason = classifyReference(repository);
      if (reason) {
        exclusions.push({ referenceKind: "helm-chart", path: relativePath, key: `dependency:${name}`, rawValue: repository, reason });
      } else {
        references.push({ referenceKind: "helm-chart", path: relativePath, key: `dependency:${name}`, packageName: name, currentValue: version });
      }
    }
  }
}

interface Counter {
  value: number;
}

function scanGithubActions(
  relativePath: string,
  lines: string[],
  references: DependencyReferenceIdentity[],
): void {
  let actionIndex = 0;
  for (const line of lines) {
    const uses = yamlScalar(line, "uses");
    if (!uses || uses.startsWith("./")) continue;
    const at = uses.lastIndexOf("@");
    if (at <= 0) continue;
    references.push({
      referenceKind: "github-action",
      path: relativePath,
      key: `uses:${actionIndex}`,
      packageName: uses.slice(0, at),
      currentValue: uses.slice(at + 1),
    });
    actionIndex += 1;
  }
}

function scanLiteralImages(
  relativePath: string,
  lines: string[],
  sink: Pick<DependencyInventory, "references" | "exclusions">,
  imageIndex: Counter,
): void {
  for (const line of lines) {
    const image = yamlScalar(line, "image");
    if (!image) continue;
    pushImage(sink, "container-image", relativePath, `image:${imageIndex.value}`, image);
    imageIndex.value += 1;
  }
}

function scanCloudBuildImages(
  relativePath: string,
  lines: string[],
  sink: Pick<DependencyInventory, "references" | "exclusions">,
  imageIndex: Counter,
): void {
  for (const line of lines) {
    if (!line.trimStart().startsWith("-")) continue;
    const builder = yamlScalar(line, "name");
    if (!builder) continue;
    pushImage(sink, "container-image", relativePath, `image:${imageIndex.value}`, builder);
    imageIndex.value += 1;
  }
}

function scanValuesImages(
  relativePath: string,
  lines: string[],
  sink: Pick<DependencyInventory, "references" | "exclusions">,
): void {
  for (let index = 0; index < lines.length; index += 1) {
    const repository = yamlScalar(lines[index], "repository");
    if (!repository) continue;
    const nearby = lines.slice(index + 1, index + 6);
    const tag = firstYamlScalar(nearby, "tag") || "latest";
    const digest = firstYamlScalar(nearby, "digest");
    const digestSuffix = digest ? `@${digest}` : "";
    pushImage(
      sink,
      "container-image",
      relativePath,
      `repository:${index}`,
      `${repository}:${tag}${digestSuffix}`,
    );
  }
}

function scanYaml(root: string, files: string[], references: DependencyReferenceIdentity[], exclusions: DependencyExclusion[]): void {
  for (const file of files.filter((candidate) => [".yml", ".yaml"].includes(path.extname(candidate)))) {
    const relativePath = posixPath(path.relative(root, file));
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const sink = { references, exclusions };
    const imageIndex = { value: 0 };
    scanGithubActions(relativePath, lines, references);
    scanLiteralImages(relativePath, lines, sink, imageIndex);
    if (path.basename(file).startsWith("cloudbuild")) {
      scanCloudBuildImages(relativePath, lines, sink, imageIndex);
    }
    if (path.basename(file).startsWith("values")) scanValuesImages(relativePath, lines, sink);
  }
}

function scanAnnotations(root: string, files: string[], references: DependencyReferenceIdentity[]): void {
  const pattern = /octogee:dependency\s+kind=([^\s]+)\s+key=([^\s]+)\s+packageName=([^\s]+)\s+currentValue=([^\s]+)/g;
  for (const file of files.filter((candidate) => textExtensions.has(path.extname(candidate)))) {
    const relativePath = posixPath(path.relative(root, file));
    if (relativePath === ".github/renovate.json5") continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      references.push({
        referenceKind: match[1],
        path: relativePath,
        key: match[2],
        packageName: match[3],
        currentValue: match[4],
      });
    }
  }
}

export function dependencyReferenceId(reference: DependencyReferenceIdentity): string {
  return JSON.stringify([
    reference.referenceKind,
    reference.path,
    reference.key,
    reference.packageName,
    reference.currentValue,
  ]);
}

export function matchesExactReference(left: DependencyReferenceIdentity, right: DependencyReferenceIdentity): boolean {
  return dependencyReferenceId(left) === dependencyReferenceId(right);
}

export function inventoryRepository(root: string): DependencyInventory {
  const files = walkFiles(root);
  const references: DependencyReferenceIdentity[] = [];
  const exclusions: DependencyExclusion[] = [];
  scanNpm(root, files, references, exclusions);
  scanDockerfiles(root, files, references, exclusions);
  scanTerraform(root, files, references);
  scanHelmCharts(root, files, references, exclusions);
  scanYaml(root, files, references, exclusions);
  scanAnnotations(root, files, references);
  const unique = new Map(references.map((reference) => [dependencyReferenceId(reference), reference]));
  return {
    references: [...unique.values()].sort((left, right) => dependencyReferenceId(left).localeCompare(dependencyReferenceId(right))),
    exclusions: exclusions.sort((left, right) => `${left.path}:${left.key}`.localeCompare(`${right.path}:${right.key}`)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validReference(value: unknown): value is DependencyReferenceIdentity {
  if (!isRecord(value)) return false;
  return ["referenceKind", "path", "key", "packageName", "currentValue"]
    .every((field) => typeof value[field] === "string" && value[field].length > 0);
}

function validEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.kind === "string" && typeof value.uri === "string" && /^https?:\/\/|^gs:\/\//.test(value.uri) &&
    typeof value.observedAt === "string" && !Number.isNaN(Date.parse(value.observedAt));
}

interface ExceptionValidationContext extends ExceptionValidationResult {
  coverageOwners: Map<string, string>;
  ids: Set<string>;
  now: Date;
}

const REQUIRED_EXCEPTION_FIELDS = [
  "owner",
  "reason",
  "openedAt",
  "reviewAfter",
  "expiresAt",
  "removalWorkstream",
  "removalTest",
] as const;

function validateExceptionFields(
  exception: DependencyException,
  context: ExceptionValidationContext,
): void {
  if (typeof exception.id !== "string" || context.ids.has(exception.id)) {
    context.errors.push(`duplicate or missing exception id ${String(exception.id)}`);
  } else {
    context.ids.add(exception.id);
  }
  for (const field of REQUIRED_EXCEPTION_FIELDS) {
    if (typeof exception[field] !== "string" || exception[field].length === 0) {
      context.errors.push(`${exception.id}: missing ${field}`);
    }
  }
  const expiresAt = Date.parse(exception.expiresAt);
  if (Number.isNaN(expiresAt)) context.errors.push(`${exception.id}: invalid expiresAt`);
  else if (expiresAt <= context.now.getTime()) {
    context.errors.push(`${exception.id}: expired at ${exception.expiresAt}`);
  }
}

function exceptionReferences(
  exception: DependencyException,
  errors: string[],
): DependencyReferenceIdentity[] {
  const raw = normalizedExceptionReferences(exception);
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((reference) => !validReference(reference))) {
    errors.push(`${exception.id}: exact references are required`);
  }
  return Array.isArray(raw) ? raw.filter(validReference) : [];
}

function normalizedExceptionReferences(exception: DependencyException): DependencyReferenceIdentity[] {
  return exception.references ?? (exception.reference ? [exception.reference] : []);
}

function validateExceptionReferences(
  exception: DependencyException,
  references: DependencyReferenceIdentity[],
  context: ExceptionValidationContext,
): void {
  const local = new Set<string>();
  for (const reference of references) {
    const id = dependencyReferenceId(reference);
    if (local.has(id)) context.errors.push(`${exception.id}: duplicate reference ${id}`);
    local.add(id);
    if (exception.kind !== "coverage") continue;
    const previous = context.coverageOwners.get(id);
    if (previous) context.errors.push(`${exception.id}: coverage overlaps ${previous} for ${id}`);
    context.coverageOwners.set(id, exception.id);
  }
}

function validateExceptionEvidence(
  exception: DependencyException,
  errors: string[],
): void {
  if (!["coverage", "immutability", "compatibility"].includes(exception.kind)) return;
  if (!Array.isArray(exception.evidence) ||
      exception.evidence.length === 0 ||
      !exception.evidence.every(validEvidence)) {
    errors.push(`${exception.id}: valid evidence is required`);
  }
}

function validateExceptionRecord(raw: unknown, context: ExceptionValidationContext): void {
  if (!isRecord(raw)) {
    context.errors.push("exception is not an object");
    return;
  }
  const exception = raw as DependencyException;
  context.exceptions.push(exception);
  validateExceptionFields(exception, context);
  validateExceptionReferences(exception, exceptionReferences(exception, context.errors), context);
  validateExceptionEvidence(exception, context.errors);
  if (exception.kind === "coverage") context.coverageExceptions.push(exception);
}

export function validateExceptionFile(value: unknown, now = new Date()): ExceptionValidationResult {
  const empty: ExceptionValidationResult = { errors: [], exceptions: [], coverageExceptions: [] };
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.exceptions)) {
    empty.errors.push("dependency exceptions must have schemaVersion 1 and an exceptions array");
    return empty;
  }
  const context: ExceptionValidationContext = {
    ...empty,
    coverageOwners: new Map(),
    ids: new Set(),
    now,
  };
  for (const raw of value.exceptions) validateExceptionRecord(raw, context);
  return {
    errors: context.errors,
    exceptions: context.exceptions,
    coverageExceptions: context.coverageExceptions,
  };
}

function validateRenovatePin(value: unknown, errors: string[]): void {
  if (!isRecord(value) ||
      value.image !== "renovate/renovate" ||
      value.version !== "43.259.0" ||
      value.digest !== "sha256:f9a2ea77df854f3ceb94833b7345715a024bed4f33995d7c957db2707e9275c5" ||
      value.config !== ".github/renovate.json5") {
    errors.push("Renovate local extraction pin is not exact");
  }
}

const REQUIRED_PROBE_FIELDS = ["directory", "packageName", "introducedByPrUrl", "expiresAt"] as const;
const PROBE_TTL_MS = 72 * 60 * 60 * 1000;

function validateProbeFields(value: Record<string, unknown>, errors: string[]): void {
  if (value.phase !== "default-branch-pending") {
    errors.push("R1a requires one default-branch-pending probe");
  }
  for (const field of REQUIRED_PROBE_FIELDS) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      errors.push(`npmProbe.${field} is required`);
    }
  }
  if (typeof value.introducedByPrUrl === "string" && value.introducedByPrUrl.includes("PENDING")) {
    errors.push("npmProbe.introducedByPrUrl is still PENDING");
  }
}

function validateProbeExpiry(value: Record<string, unknown>, now: Date, errors: string[]): void {
  const expiry = Date.parse(String(value.expiresAt));
  const remaining = expiry - now.getTime();
  if (Number.isNaN(expiry) || remaining <= 0 || remaining > PROBE_TTL_MS) {
    errors.push("npmProbe expiry must be in the next 72 hours");
  }
}

function parseDependabotProbe(value: unknown, now: Date, errors: string[]): DependencyProbe | undefined {
  if (!isRecord(value) || value.config !== ".github/dependabot.yml" || !isRecord(value.npmProbe)) {
    errors.push("Dependabot config and npmProbe are required");
    return undefined;
  }
  validateProbeFields(value.npmProbe, errors);
  validateProbeExpiry(value.npmProbe, now, errors);
  return value.npmProbe as unknown as DependencyProbe;
}

function isOwnershipRule(value: unknown): value is DependencyOwnershipRule {
  return isRecord(value) &&
    typeof value.referenceKind === "string" &&
    ["dependabot", "renovate"].includes(String(value.manager)) &&
    Array.isArray(value.pathPatterns) &&
    value.pathPatterns.length > 0 &&
    value.pathPatterns.every((pattern) => typeof pattern === "string" && pattern.length > 0);
}

function parseOwnership(value: unknown, errors: string[]): DependencyOwnershipRule[] {
  if (!Array.isArray(value)) {
    errors.push("ownership must be an array");
    return [];
  }
  const ownership: DependencyOwnershipRule[] = [];
  for (const rule of value) {
    if (isOwnershipRule(rule)) ownership.push(rule);
    else errors.push("malformed ownership rule");
  }
  return ownership;
}

export function validateCoverageFile(value: unknown, now = new Date()): CoverageValidationResult {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return { errors: ["dependency coverage schemaVersion must be 1"], ownership: [] };
  }
  const errors: string[] = [];
  validateRenovatePin(value.renovate, errors);
  const probe = parseDependabotProbe(value.dependabot, now, errors);
  const ownership = parseOwnership(value.ownership, errors);
  return { errors, ownership, probe };
}

function segmentMatches(pattern: string, value: string): boolean {
  let reachable = new Array<boolean>(value.length + 1).fill(false);
  reachable[0] = true;
  for (const character of pattern) {
    const next = new Array<boolean>(value.length + 1).fill(false);
    if (character === "*") next[0] = reachable[0];
    for (let index = 1; index <= value.length; index += 1) {
      next[index] = character === "*"
        ? next[index - 1] || reachable[index]
        : reachable[index - 1] && character === value[index - 1];
    }
    reachable = next;
  }
  return reachable[value.length];
}

function globMatches(pattern: string, value: string): boolean {
  const patterns = pattern.split("/");
  const values = value.split("/");
  const reachable = Array.from(
    { length: patterns.length + 1 },
    () => new Array<boolean>(values.length + 1).fill(false),
  );
  reachable[0][0] = true;
  for (let patternIndex = 1; patternIndex <= patterns.length; patternIndex += 1) {
    const segment = patterns[patternIndex - 1];
    if (segment === "**") reachable[patternIndex][0] = reachable[patternIndex - 1][0];
    for (let valueIndex = 1; valueIndex <= values.length; valueIndex += 1) {
      reachable[patternIndex][valueIndex] = segment === "**"
        ? reachable[patternIndex - 1][valueIndex] || reachable[patternIndex][valueIndex - 1]
        : reachable[patternIndex - 1][valueIndex - 1] && segmentMatches(segment, values[valueIndex - 1]);
    }
  }
  return reachable[patterns.length][values.length];
}

interface CoverageAuditInput {
  inventory: DependencyInventory;
  ownership: DependencyOwnershipRule[];
  dependabotReferences: DependencyReferenceIdentity[];
  renovateReferences: DependencyReferenceIdentity[];
  exceptions: DependencyException[];
  now?: Date;
}

interface ExceptionReference {
  exception: DependencyException;
  reference: DependencyReferenceIdentity;
}

interface CoverageAuditContext {
  input: CoverageAuditInput;
  errors: string[];
  dependabot: Set<string>;
  renovate: Set<string>;
  exceptions: ExceptionReference[];
}

function ownershipRules(
  input: CoverageAuditInput,
  reference: DependencyReferenceIdentity,
): DependencyOwnershipRule[] {
  return input.ownership.filter((rule) =>
    (rule.referenceKind === "*" || rule.referenceKind === reference.referenceKind) &&
    rule.pathPatterns.some((pattern) => globMatches(pattern, reference.path)),
  );
}

function extractedManagers(context: CoverageAuditContext, id: string): Array<"dependabot" | "renovate"> {
  const managers: Array<"dependabot" | "renovate"> = [];
  if (context.dependabot.has(id)) managers.push("dependabot");
  if (context.renovate.has(id)) managers.push("renovate");
  return managers;
}

function matchingExceptions(
  context: CoverageAuditContext,
  reference: DependencyReferenceIdentity,
): ExceptionReference[] {
  return context.exceptions.filter(({ reference: candidate }) => matchesExactReference(reference, candidate));
}

function auditReference(context: CoverageAuditContext, reference: DependencyReferenceIdentity): void {
  const id = dependencyReferenceId(reference);
  const rules = ownershipRules(context.input, reference);
  if (rules.length !== 1) {
    context.errors.push(`${id}: expected exactly one ownership rule, found ${rules.length}`);
    return;
  }
  const managers = extractedManagers(context, id);
  if (managers.length > 1) {
    context.errors.push(`${id}: overlapping bot ownership`);
    return;
  }
  const exceptions = matchingExceptions(context, reference);
  if (managers.length === 0) {
    if (exceptions.length !== 1) {
      context.errors.push(`${id}: expected manager extraction or one exact coverage exception, found ${exceptions.length}`);
    }
    return;
  }
  if (managers[0] !== rules[0].manager) {
    context.errors.push(`${id}: wrong manager ${managers[0]}; expected ${rules[0].manager}`);
  }
  if (exceptions.length > 0) {
    context.errors.push(`${id}: both manager extraction and coverage exception apply`);
  }
}

function auditStaleExceptions(context: CoverageAuditContext): void {
  const inventoryIds = new Set(context.input.inventory.references.map(dependencyReferenceId));
  for (const { exception, reference } of context.exceptions) {
    const id = dependencyReferenceId(reference);
    if (!inventoryIds.has(id)) context.errors.push(`${exception.id}: stale or broad reference ${id}`);
  }
}

function exceptionReferencesForAudit(exceptions: DependencyException[]): ExceptionReference[] {
  return exceptions.flatMap((exception) =>
    normalizedExceptionReferences(exception).map((reference) => ({ exception, reference })),
  );
}

export function auditDependencyCoverage(input: CoverageAuditInput): ValidationResult {
  const context: CoverageAuditContext = {
    input,
    errors: [],
    dependabot: new Set(input.dependabotReferences.map(dependencyReferenceId)),
    renovate: new Set(input.renovateReferences.map(dependencyReferenceId)),
    exceptions: exceptionReferencesForAudit(input.exceptions),
  };
  for (const reference of input.inventory.references) {
    auditReference(context, reference);
  }
  auditStaleExceptions(context);
  return { errors: context.errors };
}
