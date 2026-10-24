import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IMPORT_ACTIVATION_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import { parseAgentId } from "@octogee/shared/types/identity";
import { mattermostAccountEndpointsForTarget } from "@octogee/shared/types/openclaw-mattermost-accounts";
import {
  applyConfigPatch,
  customerAgentRosterPatch,
  customerConfigAgentRosterReplacePaths,
  filterOutCustomerBindings,
  orderBuilderGatewayRoster,
  replaceCustomerAgentsInFullAgentList,
  staleProjectAgentAccountNulls,
  upsertAgentInFullAgentList,
  type ConfigCache,
} from "./apply-config-patch.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { rebindPlatformEmbeddingRefs } from "./platform-embedding-refs.js";
import {
  reconcileBuilderAgentEntry,
  reconcileCustomerAgentEntry,
  type GatewayConfigClass,
} from "./system-config-invariants.js";

export const MIGRATION_ACTIVATION_DIR = ".octogee-migration-activation";
export const MIGRATION_ACTIVATION_FILE = "activation.json";
export const MIGRATION_ACTIVATION_MAX_BYTES = 256 * 1024 ** 2;
const IDENTITY_MAX_BYTES = 4 * 1024 ** 2;

export interface MigrationSourceIdentityCustody {
  migrationId: string;
  uid: string;
  gatewayId: string;
  podUid: string;
  epoch: number;
}

interface SourceWorkspaceIdentity {
  agentId: string;
  content: string | null;
  sha256: string | null;
}

interface SourceWorkspaceIdentities extends MigrationSourceIdentityCustody {
  files: SourceWorkspaceIdentity[];
}

export interface MigrationActivationManifestProjectAgent {
  agentId: string;
  accountId: string;
  agent: Record<string, unknown>;
  mattermostAccount: Record<string, unknown>;
  bindings: unknown[];
}

export interface MigrationActivationManifest {
  version: 2;
  slug: string;
  appliedFingerprint: string;
  agentId: string;
  accountId: string;
  agent: Record<string, unknown>;
  mattermostAccount: Record<string, unknown>;
  bindings: unknown[];
  projectAgents: MigrationActivationManifestProjectAgent[];
  sourceWorkspaceIdentities?: SourceWorkspaceIdentities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function activationAgentForTarget(
  manifestAgent: Record<string, unknown>,
  currentAgent: Record<string, unknown> | undefined,
  targetUsesKeyedEntries: boolean,
): Record<string, unknown> {
  const selected: Record<string, unknown> = currentAgent && hasOwn(currentAgent, "model")
    ? { ...manifestAgent, model: currentAgent.model }
    : { ...manifestAgent };
  delete selected.default;
  if (currentAgent?.default === true) selected.default = true;
  const agent = selected;
  if (targetUsesKeyedEntries || !hasOwn(agent, "memory")) return agent;

  const memory = agent.memory;
  if (!isRecord(memory) || !isRecord(memory.search)) {
    throw new Error("stable target cannot represent beta agent memory without memory.search");
  }
  const unsupportedMemoryFields = Object.keys(memory).filter((key) => key !== "search");
  if (unsupportedMemoryFields.length > 0) {
    throw new Error(
      `stable target cannot represent beta agent memory fields: ${unsupportedMemoryFields.join(", ")}`,
    );
  }
  const stableAgent = { ...agent };
  delete stableAgent.memory;
  return { ...stableAgent, memorySearch: memory.search };
}

function currentActivationAgent(
  current: unknown,
  agentId: string,
): Record<string, unknown> | undefined {
  const agents = (current as { agents?: Record<string, unknown> } | undefined)?.agents;
  const entries = agents?.entries;
  if (isRecord(entries)) {
    const entry = entries[agentId];
    return isRecord(entry) ? { ...entry, id: agentId } : undefined;
  }
  const list = agents?.list;
  return Array.isArray(list)
    ? list.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === agentId)
    : undefined;
}

function rosterAgentId(agent: Record<string, unknown>): string {
  if (typeof agent.id !== "string" || agent.id.length === 0) {
    throw new Error("activation roster agent requires a non-empty id");
  }
  return agent.id;
}

export function activationManifestTarPath(slug: string): string {
  return path.join(MIGRATION_ACTIVATION_DIR, slug, MIGRATION_ACTIVATION_FILE);
}

function activationManifestDiskPath(openclawDir: string, slug: string): string {
  return path.join(openclawDir, activationManifestTarPath(slug));
}

function expectedAgentId(slug: string): string {
  return `octogee-${slug}-coach`;
}

function expectedAccountId(slug: string): string {
  return `${slug}-coach`;
}

function expectedProjectAccountId(slug: string, agentId: string): string | null {
  const parsed = parseAgentId(agentId);
  if (parsed.kind !== "project" || parsed.username !== slug) return null;
  return `${slug}-proj-${parsed.project}`;
}

function validateManifestAgent(
  value: Record<string, unknown>,
  slug: string,
  expectedId: string,
  expectedAccount: string,
): MigrationActivationManifestProjectAgent {
  const agent = value.agent;
  const mattermostAccount = value.mattermostAccount;
  const bindings = value.bindings;
  if (value.agentId !== expectedId || value.accountId !== expectedAccount) {
    throw new Error(`[migration-activation:${slug}] activation manifest id mismatch`);
  }
  if (!isRecord(agent) || agent.id !== expectedId) {
    throw new Error(`[migration-activation:${slug}] activation manifest agent missing or mismatched`);
  }
  if (
    !isRecord(mattermostAccount)
    || typeof mattermostAccount.botToken !== "string"
    || mattermostAccount.botToken.length === 0
  ) {
    throw new Error(`[migration-activation:${slug}] activation manifest mattermost account is missing botToken`);
  }
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error(`[migration-activation:${slug}] activation manifest has no channel bindings`);
  }
  if (!bindings.every((binding) => {
    if (!isRecord(binding) || binding.agentId !== expectedId || !isRecord(binding.match)) {
      return false;
    }
    return binding.match.channel === "mattermost" &&
      binding.match.accountId === expectedAccount;
  })) {
    throw new Error(`[migration-activation:${slug}] activation manifest contains foreign binding scope`);
  }
  const stableBinding = {
    agentId: expectedId,
    match: { channel: "mattermost", accountId: expectedAccount },
  };
  const normalizedBindings = bindings.some((binding) => isAccountBinding(binding))
    ? bindings
    : [stableBinding, ...bindings];
  return {
    agentId: expectedId,
    accountId: expectedAccount,
    agent,
    mattermostAccount,
    bindings: normalizedBindings,
  };
}

function validateManifestShape(
  value: unknown,
  slug: string,
): MigrationActivationManifest {
  if (!isRecord(value)) {
    throw new Error(`[migration-activation:${slug}] activation manifest is not an object`);
  }
  const agentId = expectedAgentId(slug);
  const accountId = expectedAccountId(slug);
  if (value.slug !== slug || value.version !== 2) {
    throw new Error(`[migration-activation:${slug}] activation manifest version/slug mismatch`);
  }
  const appliedFingerprint = value.appliedFingerprint;
  if (typeof appliedFingerprint !== "string" || appliedFingerprint.length === 0) {
    throw new Error(`[migration-activation:${slug}] activation manifest version/slug mismatch`);
  }
  const workspace = validateManifestAgent(value, slug, agentId, accountId);
  const rawProjects = value.projectAgents;
  if (rawProjects !== undefined && !Array.isArray(rawProjects)) {
    throw new Error(`[migration-activation:${slug}] activation manifest project agents are invalid`);
  }
  const projectAgents = (rawProjects ?? []).map((project) => {
    if (!isRecord(project) || typeof project.agentId !== "string") {
      throw new Error(`[migration-activation:${slug}] activation manifest project agent is invalid`);
    }
    const projectAccountId = expectedProjectAccountId(slug, project.agentId);
    if (!projectAccountId) {
      throw new Error(`[migration-activation:${slug}] activation manifest project agent id mismatch`);
    }
    return validateManifestAgent(project, slug, project.agentId, projectAccountId);
  });
  const ids = new Set<string>();
  const accounts = new Set<string>();
  for (const entry of [workspace, ...projectAgents]) {
    if (ids.has(entry.agentId) || accounts.has(entry.accountId)) {
      throw new Error(`[migration-activation:${slug}] activation manifest contains duplicate agent/account`);
    }
    ids.add(entry.agentId);
    accounts.add(entry.accountId);
  }
  return {
    version: 2,
    slug,
    appliedFingerprint,
    ...workspace,
    projectAgents,
    ...(value.sourceWorkspaceIdentities === undefined ? {} : {
      sourceWorkspaceIdentities: validateSourceWorkspaceIdentities(value.sourceWorkspaceIdentities, [workspace, ...projectAgents]),
    }),
  };
}

function validateSourceIdentityCustody(value: unknown): asserts value is MigrationSourceIdentityCustody {
  if (!isRecord(value) || !["migrationId", "uid", "gatewayId", "podUid"].every(key =>
    typeof value[key] === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value[key] as string)) ||
    !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 0) {
    throw new Error("Source workspace identity custody is invalid");
  }
}

function identityBytes(file: SourceWorkspaceIdentity): Buffer | null {
  if (file.content === null && file.sha256 === null) return null;
  if (typeof file.content !== "string" || file.content.length > Math.ceil(IDENTITY_MAX_BYTES / 3) * 4 ||
      typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
    throw new Error("Source workspace identity capture is invalid");
  }
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.length > IDENTITY_MAX_BYTES || bytes.toString("base64") !== file.content ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    throw new Error("Source workspace identity capture changed");
  }
  return bytes;
}

function validateSourceWorkspaceIdentities(value: unknown, agents: readonly { agentId: string }[]): SourceWorkspaceIdentities {
  validateSourceIdentityCustody(value);
  const raw = value as unknown as Record<string, unknown>;
  if (!Array.isArray(raw.files) || raw.files.length !== agents.length || raw.files.length > 16_384) {
    throw new Error("Source workspace identity coverage is invalid");
  }
  const expected = new Set(agents.map(agent => agent.agentId));
  const files = raw.files.map(file => {
    if (!isRecord(file) || typeof file.agentId !== "string" || !expected.delete(file.agentId)) {
      throw new Error("Source workspace identity agent is invalid");
    }
    const captured = { agentId: file.agentId, content: file.content, sha256: file.sha256 } as SourceWorkspaceIdentity;
    identityBytes(captured);
    return captured;
  });
  return { migrationId: value.migrationId, uid: value.uid, gatewayId: value.gatewayId,
    podUid: value.podUid, epoch: value.epoch, files };
}

export function assertSourceIdentityCustody(expected: MigrationSourceIdentityCustody, actual: MigrationSourceIdentityCustody): void {
  validateSourceIdentityCustody(expected);
  validateSourceIdentityCustody(actual);
  if (["migrationId", "uid", "gatewayId", "podUid", "epoch"].some(key =>
    expected[key as keyof MigrationSourceIdentityCustody] !== actual[key as keyof MigrationSourceIdentityCustody])) {
    throw new Error("Source workspace identity custody changed");
  }
}

async function withIdentityWorkspace<T>(stateDir: string, slug: string, agent: { agentId: string; agent: Record<string, unknown> }, use: (location: string, assertCurrent: () => Promise<void>) => Promise<T>): Promise<T> {
  const parsed = parseAgentId(agent.agentId);
  if (parsed.kind === "unknown" || parsed.username !== slug) throw new Error("Source workspace identity agent is foreign");
  const parts = ["customers", slug, ...(parsed.kind === "project" ? ["projects", parsed.project] : [])];
  const workspace = path.join(stateDir, ...parts);
  if (agent.agent.workspace !== workspace || await fs.realpath(stateDir) !== stateDir) throw new Error("Source workspace identity path is not canonical");
  const handles: fs.FileHandle[] = [];
  const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  try {
    handles.push(await fs.open(stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const part of parts) handles.push(await fs.open(`${fdRoot}/${handles.at(-1)!.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const directory = handles.at(-1)!;
    const identity = await directory.stat();
    const assertCurrent = async () => {
      const current = await fs.lstat(workspace);
      if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino || await fs.realpath(workspace) !== workspace) {
        throw new Error("Source workspace identity directory changed");
      }
    };
    await assertCurrent();
    const result = await use(`${fdRoot}/${directory.fd}/IDENTITY.md`, assertCurrent);
    await assertCurrent();
    return result;
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

async function readSourceIdentity(location: string): Promise<Buffer | null> {
  let file: fs.FileHandle;
  try { file = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > IDENTITY_MAX_BYTES) throw new Error("Source workspace identity file is unsafe or exceeds Native's limit");
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await file.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Source workspace identity changed while captured");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

export async function captureSourceWorkspaceIdentities(manifest: MigrationActivationManifest, stateDir: string, custody: MigrationSourceIdentityCustody): Promise<MigrationActivationManifest> {
  validateSourceIdentityCustody(custody);
  const agents = manifestAgents(manifest);
  if (agents.length > 16_384) throw new Error("Source workspace identity coverage exceeds transfer limit");
  if (manifest.sourceWorkspaceIdentities) {
    const captured = validateSourceWorkspaceIdentities(manifest.sourceWorkspaceIdentities, manifestAgents(manifest));
    assertSourceIdentityCustody(captured, custody);
    for (const agent of manifestAgents(manifest)) await withIdentityWorkspace(stateDir, manifest.slug, agent, async location => { await readSourceIdentity(location); });
    return manifest;
  }
  const files: SourceWorkspaceIdentity[] = [];
  let bytesCaptured = Buffer.byteLength(JSON.stringify(manifest));
  for (const agent of agents) await withIdentityWorkspace(stateDir, manifest.slug, agent, async location => {
    const bytes = await readSourceIdentity(location);
    const file = { agentId: agent.agentId, content: bytes?.toString("base64") ?? null,
      sha256: bytes === null ? null : createHash("sha256").update(bytes).digest("hex") };
    bytesCaptured += Buffer.byteLength(JSON.stringify(file));
    if (bytesCaptured > MIGRATION_ACTIVATION_MAX_BYTES) throw new Error("Source activation manifest exceeds transfer limit");
    files.push(file);
  });
  const captured = { ...manifest, sourceWorkspaceIdentities: { ...custody, files } };
  if (Buffer.byteLength(JSON.stringify(captured)) > MIGRATION_ACTIVATION_MAX_BYTES) throw new Error("Source activation manifest exceeds transfer limit");
  return captured;
}

export async function restoreSourceWorkspaceIdentities(manifest: MigrationActivationManifest, stateDir: string, custody: MigrationSourceIdentityCustody, assertCurrent: () => Promise<void>): Promise<void> {
  const captured = validateSourceWorkspaceIdentities(manifest.sourceWorkspaceIdentities, manifestAgents(manifest));
  assertSourceIdentityCustody(captured, custody);
  const files = new Map(captured.files.map(file => [file.agentId, file]));
  for (const agent of manifestAgents(manifest)) await withIdentityWorkspace(stateDir, manifest.slug, agent, async (location, assertDirectory) => {
    const bytes = identityBytes(files.get(agent.agentId)!);
    const current = await readSourceIdentity(location);
    if (current === null && bytes === null || current !== null && bytes !== null && current.equals(bytes)) return;
    const temporary = `${location}.${randomUUID()}.tmp`;
    try {
      if (bytes !== null) {
        const file = await fs.open(temporary, "wx", 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      }
      await assertCurrent();
      await assertDirectory();
      if (bytes === null) await fs.unlink(location);
      else await fs.rename(temporary, location);
      const directory = await fs.open(path.dirname(location), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await fs.rm(temporary, { force: true }); }
  });
}

function sourceAgents(parsed: {
  agents?: { list?: unknown[]; entries?: Record<string, unknown> };
}): Record<string, unknown>[] {
  const entries = parsed.agents?.entries;
  if (isRecord(entries)) {
    return Object.entries(entries)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([id, agent]) => ({ ...agent, id }));
  }
  const list = parsed.agents?.list;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

interface SourceManifestAgentInput {
  agent: Record<string, unknown> | undefined;
  accountId: string;
  bindings: unknown[];
  opts: {
    botToken?: string;
    resolveBotToken?: (accountId: string) => Promise<string | undefined>;
  };
  sourceAccount: unknown;
  isWorkspace: boolean;
}

async function sourceManifestAgent(
  input: SourceManifestAgentInput,
): Promise<Record<string, unknown>> {
  let token: unknown;
  if (input.opts.resolveBotToken) {
    token = await input.opts.resolveBotToken(input.accountId);
  } else if (input.isWorkspace && input.opts.botToken !== undefined) {
    token = input.opts.botToken;
  } else if (isRecord(input.sourceAccount)) {
    token = input.sourceAccount.botToken;
  }
  return {
    agentId: input.agent?.id,
    accountId: input.accountId,
    agent: input.agent,
    mattermostAccount: isRecord(input.sourceAccount)
      ? { ...input.sourceAccount, botToken: token }
      : input.sourceAccount,
    bindings: input.bindings,
  };
}

export async function extractOpenClawActivationManifest(
  configPath: string,
  slug: string,
  opts: {
    appliedFingerprint: string;
    botToken?: string;
    resolveBotToken?: (accountId: string) => Promise<string | undefined>;
  },
): Promise<MigrationActivationManifest> {
  const raw = await fs.readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    agents?: { list?: unknown[]; entries?: Record<string, unknown> };
    channels?: { mattermost?: { accounts?: Record<string, unknown> } };
    bindings?: unknown[];
  };
  const agentId = expectedAgentId(slug);
  const accountId = expectedAccountId(slug);
  const agents = sourceAgents(parsed);
  const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : [];
  const workspace = await sourceManifestAgent({
    agent: agents.find((agent) => agent.id === agentId),
    accountId,
    bindings: bindings.filter((binding) => isRecord(binding) && binding.agentId === agentId),
    opts,
    sourceAccount: parsed.channels?.mattermost?.accounts?.[accountId],
    isWorkspace: true,
  });
  const projectAgents = await Promise.all(
    agents
      .filter((agent) => typeof agent.id === "string" && expectedProjectAccountId(slug, agent.id))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
      .map(async (agent) => {
        const projectAccountId = expectedProjectAccountId(slug, agent.id as string)!;
        return sourceManifestAgent({
          agent,
          accountId: projectAccountId,
          bindings: bindings.filter((binding) => isRecord(binding) && binding.agentId === agent.id),
          opts,
          sourceAccount: parsed.channels?.mattermost?.accounts?.[projectAccountId],
          isWorkspace: false,
        });
      }),
  );
  return validateManifestShape(
    {
      version: 2,
      slug,
      appliedFingerprint: opts.appliedFingerprint,
      ...workspace,
      projectAgents,
    },
    slug,
  );
}

function manifestAgents(
  manifest: MigrationActivationManifest,
): MigrationActivationManifestProjectAgent[] {
  const { projectAgents, ...workspace } = manifest;
  return [workspace, ...projectAgents];
}

function mattermostBindingKey(value: unknown): string | null {
  if (!isRecord(value) || typeof value.agentId !== "string") return null;
  const match = value.match;
  if (
    !isRecord(match) ||
    match.channel !== "mattermost" ||
    typeof match.accountId !== "string"
  ) {
    return null;
  }
  if (match.peer === undefined) {
    return `${match.accountId}\u0000${value.agentId}\u0000account`;
  }
  if (
    !isRecord(match.peer) ||
    typeof match.peer.kind !== "string" ||
    typeof match.peer.id !== "string"
  ) {
    return `${match.accountId}\u0000${value.agentId}\u0000malformed`;
  }
  return `${match.accountId}\u0000${value.agentId}\u0000${match.peer.kind}\u0000${match.peer.id}`;
}

function isAccountBinding(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.match)) return false;
  return value.match.channel === "mattermost" &&
    typeof value.match.accountId === "string" &&
    value.match.peer === undefined;
}

function accountBindingsNeedingActivation(
  current: readonly unknown[],
  desired: readonly unknown[],
): string[] {
  const desiredAccountIds = new Set(desired.flatMap((binding) => {
    if (!isAccountBinding(binding)) return [];
    return [(binding as { match: { accountId: string } }).match.accountId];
  }));
  const existing = new Set(current.flatMap((binding) => {
    const key = mattermostBindingKey(binding);
    return key ? [key] : [];
  }));
  const desiredKeys = new Set(desired.flatMap((binding) => {
    const key = mattermostBindingKey(binding);
    return key ? [key] : [];
  }));
  const affected = new Set<string>();
  for (const binding of desired) {
    if (!isAccountBinding(binding)) continue;
    const key = mattermostBindingKey(binding)!;
    const accountId = (binding as { match: { accountId: string } }).match.accountId;
    if (!existing.has(key)) affected.add(accountId);
  }
  for (const binding of current) {
    const key = mattermostBindingKey(binding);
    if (!key) continue;
    const accountId = key.slice(0, key.indexOf("\u0000"));
    if (desiredAccountIds.has(accountId) && !desiredKeys.has(key)) {
      affected.add(accountId);
    }
  }
  return [...affected].sort();
}

/**
 * Every agent id the activation installs. The caller compares it against the
 * target's live roster: residue the manifest does not carry has to leave by
 * `agents.delete` before the patch, because 2026.7.2 refuses a config write
 * that drops roster entries.
 */
export function activationManifestAgentIds(
  manifest: MigrationActivationManifest,
): string[] {
  return manifestAgents(manifest).map((entry) => entry.agentId);
}

export async function writeActivationManifest(
  rootDir: string,
  manifest: MigrationActivationManifest,
): Promise<{ cwd: string; path: string }> {
  const contents = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(contents) > MIGRATION_ACTIVATION_MAX_BYTES) throw new Error("Source activation manifest exceeds transfer limit");
  const relPath = activationManifestTarPath(manifest.slug);
  const fullPath = path.join(rootDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 });
  const temporary = `${fullPath}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try { await file.writeFile(contents, "utf-8"); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporary, fullPath);
    const directory = await fs.open(path.dirname(fullPath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
  return { cwd: rootDir, path: relPath };
}

export async function readActivationManifest(
  openclawDir: string,
  slug: string,
): Promise<MigrationActivationManifest> {
  const manifestPath = activationManifestDiskPath(openclawDir, slug);
  if ((await fs.stat(manifestPath)).size > MIGRATION_ACTIVATION_MAX_BYTES) throw new Error("Source activation manifest exceeds transfer limit");
  const raw = await fs.readFile(manifestPath, "utf-8");
  return validateManifestShape(JSON.parse(raw), slug);
}

export async function removeActivationManifest(
  openclawDir: string,
  slug: string,
): Promise<void> {
  const manifestDir = path.join(openclawDir, MIGRATION_ACTIVATION_DIR, slug);
  await fs.rm(manifestDir, { recursive: true, force: true });
}

type OwnerCommandsPatch = (current: unknown) => { ownerAllowFrom: string[] } | undefined;

function ownerCommandsSection(
  ownerCommandsPatch: OwnerCommandsPatch | undefined,
  current: unknown,
): { commands?: { ownerAllowFrom: string[] } } {
  const commands = ownerCommandsPatch?.(current);
  return commands ? { commands } : {};
}

export async function applyOpenClawActivationManifest(
  manifest: MigrationActivationManifest,
  opts: {
    rpc: GatewayRpcClient;
    cache?: ConfigCache;
    signal?: AbortSignal;
    log: (msg: string) => void;
    gatewayClass?: GatewayConfigClass;
    onRoutingActivationRequired?: (accountIds: readonly string[]) => void;
    authInheritanceAnchor?: {
      agentId: string;
      agent: Record<string, unknown>;
    };
    ownerCommandsPatch?: OwnerCommandsPatch;
  },
): Promise<{
  elapsedMs: number;
  routingActivationRequired: boolean;
  restartExistingAccountIds: string[];
  configNoop: boolean;
}> {
  const authInheritanceAnchor = opts.authInheritanceAnchor;
  const reconcileAgent = opts.gatewayClass === "builder"
    ? reconcileBuilderAgentEntry
    : reconcileCustomerAgentEntry;
  if (
    authInheritanceAnchor &&
    rosterAgentId(authInheritanceAnchor.agent) !== authInheritanceAnchor.agentId
  ) {
    throw new Error("activation auth inheritance anchor id mismatch");
  }
  const normalizedAuthInheritanceAnchor = authInheritanceAnchor && {
    ...authInheritanceAnchor,
    agent: reconcileAgent(
      authInheritanceAnchor.agentId,
      authInheritanceAnchor.agent,
    ),
  };
  const startedAt = Date.now();
  let routingActivationRequired = false;
  let restartExistingAccountIds: string[] = [];
  const configPatch = await applyConfigPatch(
    {
      buildPatch: (current) => {
        const cfg = current as {
          bindings?: unknown[];
        };
        const currentBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
        const agents = (current as { agents?: Record<string, unknown> } | undefined)?.agents;
        const targetUsesKeyedEntries = isRecord(agents?.entries);
        const activationAgents = manifestAgents(manifest).map((entry) => ({
          ...entry,
          agent: reconcileAgent(
            entry.agentId,
            activationAgentForTarget(
              entry.agent,
              currentActivationAgent(current, entry.agentId),
              targetUsesKeyedEntries,
            ),
          ),
        }));
        const currentAccounts = (current as {
          channels?: { mattermost?: { accounts?: Record<string, unknown> } };
        } | undefined)?.channels?.mattermost?.accounts ?? {};
        const missingAccountIds = accountBindingsNeedingActivation(
          currentBindings,
          activationAgents.flatMap((entry) => entry.bindings),
        );
        restartExistingAccountIds = missingAccountIds
          .filter((accountId) => isRecord(currentAccounts[accountId]))
          .sort();
        if (missingAccountIds.length > 0 && !routingActivationRequired) {
          opts.onRoutingActivationRequired?.(missingAccountIds);
          routingActivationRequired = true;
        }
        const rosterAgents = normalizedAuthInheritanceAnchor
          ? [normalizedAuthInheritanceAnchor.agent, ...activationAgents.map((entry) => entry.agent)]
          : activationAgents.map((entry) => entry.agent);
        const nextAgents = targetUsesKeyedEntries
          ? rosterAgents
          : rosterAgents.reduce(
            (agentList, agent) => upsertAgentInFullAgentList(
              { agents: { list: agentList } },
              rosterAgentId(agent),
              agent,
            ),
            replaceCustomerAgentsInFullAgentList(current, manifest.slug, []),
          );
        const orderedAgents = normalizedAuthInheritanceAnchor
          ? orderBuilderGatewayRoster(
            nextAgents,
            manifest.agentId,
            normalizedAuthInheritanceAnchor.agentId,
          )
          : nextAgents;
        const rosterPatch = customerAgentRosterPatch(
          current,
          manifest.slug,
          rebindPlatformEmbeddingRefs(orderedAgents),
        );
        return {
          ...ownerCommandsSection(opts.ownerCommandsPatch, current),
          // openclaw rejects a multi-agent roster that declares no ownership.
          agents: {
            ...rosterPatch,
            ownership: "explicit",
            ...(normalizedAuthInheritanceAnchor
              ? {
                defaults: {
                  authInheritance: { agentId: normalizedAuthInheritanceAnchor.agentId },
                },
              }
              : {}),
          },
          bindings: [
            ...filterOutCustomerBindings(currentBindings, manifest.slug),
            ...activationAgents.flatMap((entry) => entry.bindings),
          ],
          channels: {
            mattermost: {
              accounts: {
                ...staleProjectAgentAccountNulls(
                  current,
                  manifest.slug,
                  activationAgents.map((entry) => entry.accountId),
                ),
                ...mattermostAccountEndpointsForTarget(current, Object.fromEntries(
                  activationAgents.map((entry) => [entry.accountId, entry.mattermostAccount]),
                ), opts.gatewayClass !== "builder"),
              },
            },
          },
        };
      },
      buildReplacePaths: (current) => customerConfigAgentRosterReplacePaths(
        current,
        manifest.slug,
        normalizedAuthInheritanceAnchor ? [normalizedAuthInheritanceAnchor.agentId] : [],
      ),
      logPrefix: `[import:${manifest.slug}]`,
    },
    {
      rpc: opts.rpc,
      cache: opts.cache,
      signal: opts.signal,
      log: opts.log,
      totalDeadlineMs: IMPORT_ACTIVATION_PATCH_DEADLINE_MS,
    },
  );
  return {
    elapsedMs: Date.now() - startedAt,
    routingActivationRequired,
    restartExistingAccountIds,
    configNoop: configPatch.noop === true,
  };
}
