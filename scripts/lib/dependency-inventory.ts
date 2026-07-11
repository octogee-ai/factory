import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

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

const skippedDirectories = new Set([
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

function isInternalImage(value: string): boolean {
  return value.startsWith("us-central1-docker.pkg.dev/octogee/octogee/") ||
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
  references: DependencyReferenceIdentity[],
  exclusions: DependencyExclusion[],
  referenceKind: string,
  relativePath: string,
  key: string,
  rawValue: string,
): void {
  const value = stripQuotes(rawValue).replace(/\s+#.*$/, "").trim();
  const reason = classifyReference(value);
  if (reason) {
    exclusions.push({ referenceKind, path: relativePath, key, rawValue: value, reason });
    return;
  }
  const identity = imageIdentity(value);
  references.push({ referenceKind, path: relativePath, key, ...identity });
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
      pushImage(references, exclusions, "dockerfile", relativePath, `from:${index}`, match[1]);
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

function scanTerraform(root: string, files: string[], references: DependencyReferenceIdentity[]): void {
  for (const file of files.filter((candidate) => path.extname(candidate) === ".tf")) {
    const relativePath = posixPath(path.relative(root, file));
    const source = readFileSync(file, "utf8");
    const requiredPattern = /required_providers\s*\{/g;
    for (const required of source.matchAll(requiredPattern)) {
      const opening = (required.index ?? 0) + required[0].lastIndexOf("{");
      const block = balancedBlock(source, opening);
      const providerPattern = /([A-Za-z0-9_-]+)\s*=\s*\{/g;
      for (const provider of block.matchAll(providerPattern)) {
        const providerOpening = (provider.index ?? 0) + provider[0].lastIndexOf("{");
        const providerBlock = balancedBlock(block, providerOpening);
        const providerSource = providerBlock.match(/\bsource\s*=\s*["']([^"']+)["']/)?.[1];
        if (!providerSource) continue;
        const version = providerBlock.match(/\bversion\s*=\s*["']([^"']+)["']/)?.[1] ?? "unconstrained";
        references.push({
          referenceKind: "terraform-provider",
          path: relativePath,
          key: `provider:${provider[1]}`,
          packageName: providerSource,
          currentValue: version,
        });
      }
    }
    const modulePattern = /module\s+["']([^"']+)["']\s*\{/g;
    for (const moduleMatch of source.matchAll(modulePattern)) {
      const opening = (moduleMatch.index ?? 0) + moduleMatch[0].lastIndexOf("{");
      let block: string;
      try {
        block = balancedBlock(source, opening);
      } catch (error) {
        throw new Error(`${relativePath}:module:${moduleMatch[1]}: ${String(error)}`);
      }
      const moduleSource = block.match(/\bsource\s*=\s*["']([^"']+)["']/)?.[1];
      if (!moduleSource || moduleSource.startsWith(".")) continue;
      const version = block.match(/\bversion\s*=\s*["']([^"']+)["']/)?.[1] ??
        new URLSearchParams(moduleSource.split("?")[1] ?? "").get("ref") ?? "unpinned";
      references.push({
        referenceKind: "terraform-module",
        path: relativePath,
        key: `module:${moduleMatch[1]}`,
        packageName: moduleSource.split("?")[0],
        currentValue: version,
      });
    }
  }
}

function scanHelmCharts(root: string, files: string[], references: DependencyReferenceIdentity[], exclusions: DependencyExclusion[]): void {
  for (const file of files.filter((candidate) => path.basename(candidate) === "Chart.yaml")) {
    const relativePath = posixPath(path.relative(root, file));
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const name = lines[index].match(/^\s*-\s*name:\s*["']?([^"'#\s]+)["']?/i)?.[1];
      if (!name) continue;
      const block = lines.slice(index, index + 8).join("\n");
      const version = block.match(/^\s+version:\s*["']?([^"'#\s]+)["']?/m)?.[1];
      const repository = block.match(/^\s+repository:\s*["']?([^"'#\s]+)["']?/m)?.[1];
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

function scanYaml(root: string, files: string[], references: DependencyReferenceIdentity[], exclusions: DependencyExclusion[]): void {
  const yamlFiles = files.filter((file) => [".yml", ".yaml"].includes(path.extname(file)));
  for (const file of yamlFiles) {
    const relativePath = posixPath(path.relative(root, file));
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    let imageIndex = 0;
    let actionIndex = 0;
    for (const line of lines) {
      const uses = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^"'#\s]+)["']?/i)?.[1];
      if (uses && !uses.startsWith("./")) {
        const at = uses.lastIndexOf("@");
        if (at > 0) {
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
      const image = line.match(/^\s*(?:-\s*)?image:\s*["']?([^"'#\s]+)["']?/i)?.[1];
      if (image) {
        pushImage(references, exclusions, "container-image", relativePath, `image:${imageIndex}`, image);
        imageIndex += 1;
      }
      if (path.basename(file).startsWith("cloudbuild")) {
        const builder = line.match(/^\s*-\s*name:\s*["']([^"']+)["']/i)?.[1];
        if (builder) {
          pushImage(references, exclusions, "container-image", relativePath, `image:${imageIndex}`, builder);
          imageIndex += 1;
        }
      }
    }
    if (path.basename(file).startsWith("values")) {
      for (let index = 0; index < lines.length; index += 1) {
        const repository = lines[index].match(/^\s*repository:\s*["']?([^"'#\s]+)["']?/i)?.[1];
        if (!repository) continue;
        const nearby = lines.slice(index + 1, index + 6).join("\n");
        const tag = nearby.match(/^\s*tag:\s*["']?([^"'#\s]*)["']?/m)?.[1] || "latest";
        const digest = nearby.match(/^\s*digest:\s*["']?([^"'#\s]+)["']?/m)?.[1];
        pushImage(
          references,
          exclusions,
          "container-image",
          relativePath,
          `repository:${index}`,
          `${repository}:${tag}${digest ? `@${digest}` : ""}`,
        );
      }
    }
  }
}

function scanAnnotations(root: string, files: string[], references: DependencyReferenceIdentity[]): void {
  const pattern = /octogee:dependency\s+kind=([^\s]+)\s+key=([^\s]+)\s+packageName=([^\s]+)\s+currentValue=([^\s]+)/g;
  for (const file of files.filter((candidate) => textExtensions.has(path.extname(candidate)))) {
    const relativePath = posixPath(path.relative(root, file));
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

export function validateExceptionFile(value: unknown, now = new Date()): ExceptionValidationResult {
  const errors: string[] = [];
  const exceptions: DependencyException[] = [];
  const coverageExceptions: DependencyException[] = [];
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.exceptions)) {
    return { errors: ["dependency exceptions must have schemaVersion 1 and an exceptions array"], exceptions, coverageExceptions };
  }
  const coverageOwners = new Map<string, string>();
  const ids = new Set<string>();
  for (const raw of value.exceptions) {
    if (!isRecord(raw)) {
      errors.push("exception is not an object");
      continue;
    }
    const exception = raw as DependencyException;
    exceptions.push(exception);
    if (typeof exception.id !== "string" || ids.has(exception.id)) errors.push(`duplicate or missing exception id ${String(exception.id)}`);
    else ids.add(exception.id);
    for (const field of ["owner", "reason", "openedAt", "reviewAfter", "expiresAt", "removalWorkstream", "removalTest"]) {
      if (typeof exception[field] !== "string" || exception[field].length === 0) errors.push(`${exception.id}: missing ${field}`);
    }
    const expiresAt = Date.parse(exception.expiresAt);
    if (Number.isNaN(expiresAt)) errors.push(`${exception.id}: invalid expiresAt`);
    else if (expiresAt <= now.getTime()) errors.push(`${exception.id}: expired at ${exception.expiresAt}`);
    const references = exception.references ?? (exception.reference ? [exception.reference] : []);
    if (references.length === 0 || references.some((reference) => !validReference(reference))) {
      errors.push(`${exception.id}: exact references are required`);
    }
    const local = new Set<string>();
    for (const reference of references.filter(validReference)) {
      const id = dependencyReferenceId(reference);
      if (local.has(id)) errors.push(`${exception.id}: duplicate reference ${id}`);
      local.add(id);
      if (exception.kind === "coverage") {
        const previous = coverageOwners.get(id);
        if (previous) errors.push(`${exception.id}: coverage overlaps ${previous} for ${id}`);
        coverageOwners.set(id, exception.id);
      }
    }
    if (["coverage", "immutability", "compatibility"].includes(exception.kind)) {
      if (!Array.isArray(exception.evidence) || exception.evidence.length === 0 || !exception.evidence.every(validEvidence)) {
        errors.push(`${exception.id}: valid evidence is required`);
      }
    }
    if (exception.kind === "coverage") coverageExceptions.push(exception);
  }
  return { errors, exceptions, coverageExceptions };
}

export function validateCoverageFile(value: unknown, now = new Date()): CoverageValidationResult {
  const errors: string[] = [];
  const ownership: DependencyOwnershipRule[] = [];
  if (!isRecord(value) || value.schemaVersion !== 1) return { errors: ["dependency coverage schemaVersion must be 1"], ownership };
  const renovate = value.renovate;
  if (!isRecord(renovate) || renovate.image !== "renovate/renovate" || renovate.version !== "43.259.0" ||
      renovate.digest !== "sha256:f9a2ea77df854f3ceb94833b7345715a024bed4f33995d7c957db2707e9275c5" ||
      renovate.config !== ".github/renovate.json5") {
    errors.push("Renovate local extraction pin is not exact");
  }
  const dependabot = value.dependabot;
  let probe: CoverageValidationResult["probe"];
  if (!isRecord(dependabot) || dependabot.config !== ".github/dependabot.yml" || !isRecord(dependabot.npmProbe)) {
    errors.push("Dependabot config and npmProbe are required");
  } else {
    const rawProbe = dependabot.npmProbe;
    if (rawProbe.phase !== "default-branch-pending") errors.push("R1a requires one default-branch-pending probe");
    for (const field of ["directory", "packageName", "introducedByPrUrl", "expiresAt"]) {
      if (typeof rawProbe[field] !== "string" || rawProbe[field].length === 0) errors.push(`npmProbe.${field} is required`);
    }
    if (typeof rawProbe.introducedByPrUrl === "string" && rawProbe.introducedByPrUrl.includes("PENDING")) {
      errors.push("npmProbe.introducedByPrUrl is still PENDING");
    }
    const expiry = Date.parse(String(rawProbe.expiresAt));
    if (Number.isNaN(expiry) || expiry <= now.getTime() || expiry - now.getTime() > 72 * 60 * 60 * 1000) {
      errors.push("npmProbe expiry must be in the next 72 hours");
    }
    probe = rawProbe as unknown as NonNullable<CoverageValidationResult["probe"]>;
  }
  if (!Array.isArray(value.ownership)) errors.push("ownership must be an array");
  else {
    for (const rawRule of value.ownership) {
      if (!isRecord(rawRule) || typeof rawRule.referenceKind !== "string" ||
          !["dependabot", "renovate"].includes(String(rawRule.manager)) ||
          !Array.isArray(rawRule.pathPatterns) || rawRule.pathPatterns.length === 0 ||
          !rawRule.pathPatterns.every((pattern) => typeof pattern === "string" && pattern.length > 0)) {
        errors.push("malformed ownership rule");
      } else {
        ownership.push(rawRule as unknown as DependencyOwnershipRule);
      }
    }
  }
  return { errors, ownership, probe };
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === "**") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function auditDependencyCoverage(input: {
  inventory: DependencyInventory;
  ownership: DependencyOwnershipRule[];
  dependabotReferences: DependencyReferenceIdentity[];
  renovateReferences: DependencyReferenceIdentity[];
  exceptions: DependencyException[];
  now?: Date;
}): ValidationResult {
  const errors: string[] = [];
  const dependabot = new Set(input.dependabotReferences.map(dependencyReferenceId));
  const renovate = new Set(input.renovateReferences.map(dependencyReferenceId));
  const exceptions = input.exceptions.flatMap((exception) => (exception.references ?? []).map((reference) => ({ exception, reference })));
  const inventoryIds = new Set(input.inventory.references.map(dependencyReferenceId));
  for (const reference of input.inventory.references) {
    const id = dependencyReferenceId(reference);
    const rules = input.ownership.filter((rule) =>
      (rule.referenceKind === "*" || rule.referenceKind === reference.referenceKind) &&
      rule.pathPatterns.some((pattern) => globMatches(pattern, reference.path)),
    );
    if (rules.length !== 1) {
      errors.push(`${id}: expected exactly one ownership rule, found ${rules.length}`);
      continue;
    }
    const extractedBy = [dependabot.has(id) ? "dependabot" : undefined, renovate.has(id) ? "renovate" : undefined].filter(Boolean);
    if (extractedBy.length > 1) errors.push(`${id}: overlapping bot ownership`);
    const matching = exceptions.filter(({ reference: candidate }) => matchesExactReference(reference, candidate));
    if (extractedBy.length === 1) {
      if (extractedBy[0] !== rules[0].manager) {
        errors.push(`${id}: wrong manager ${String(extractedBy[0])}; expected ${rules[0].manager}`);
      }
      if (matching.length > 0) errors.push(`${id}: both manager extraction and coverage exception apply`);
    } else if (extractedBy.length === 0 && matching.length !== 1) {
      errors.push(`${id}: expected manager extraction or one exact coverage exception, found ${matching.length}`);
    }
  }
  for (const { exception, reference } of exceptions) {
    const id = dependencyReferenceId(reference);
    if (!inventoryIds.has(id)) errors.push(`${exception.id}: stale or broad reference ${id}`);
  }
  return { errors };
}
