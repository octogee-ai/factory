import type { DeploymentEnvironmentSettings } from "@octogee/core/deployment-environment";

export type PlatformMigrationActivationSource = "test-central" | "prod-central";
export type PlatformMigrationActivationTarget = "test-west" | "prod-west";

export interface PlatformMigrationActivationArgs {
  source: PlatformMigrationActivationSource;
  target: PlatformMigrationActivationTarget;
  migrationId: string;
  apply: boolean;
  confirmation: string | null;
}

type PlatformMigrationActivationIdentity = Pick<
  PlatformMigrationActivationArgs,
  "source" | "target" | "migrationId"
>;

type PlatformMigrationActivationReceiptExpectation =
  PlatformMigrationActivationIdentity & { revision: string };

export interface PlatformMigrationActivationService {
  service: "mattermost" | "gitea";
  kind: "Deployment" | "StatefulSet";
  name: string;
  replicas: number;
  readyReplicas: number;
  pods: number;
}

export interface PlatformMigrationActivationReceipt {
  schemaVersion: 1;
  kind: "platform-migration-activation-receipt";
  migrationId: string;
  source: PlatformMigrationActivationSource;
  target: PlatformMigrationActivationTarget;
  revision: string;
  completedAt: string;
  services: Array<Pick<PlatformMigrationActivationService, "service" | "kind" | "name">>;
  credentials: "migration-only-mattermost-and-target-gitea";
  secrets: "rematerialized-and-verified";
  verified: true;
}

export interface PlatformMigrationActivationDependencies {
  assertReceiptStorage(): Promise<void>;
  assertExactMergedMain(): Promise<string>;
  assertMigrationPreconditions(args: PlatformMigrationActivationArgs, revision: string): Promise<void>;
  readServices(settings: DeploymentEnvironmentSettings): Promise<PlatformMigrationActivationService[]>;
  scaleService(settings: DeploymentEnvironmentSettings, service: Pick<PlatformMigrationActivationService, "kind" | "name">, replicas: number): Promise<void>;
  waitForServicesReady(settings: DeploymentEnvironmentSettings, services: readonly PlatformMigrationActivationService[]): Promise<void>;
  waitForServicesStopped(settings: DeploymentEnvironmentSettings, services: readonly PlatformMigrationActivationService[]): Promise<void>;
  rotateMattermost(settings: DeploymentEnvironmentSettings): Promise<void>;
  resetGitea(settings: DeploymentEnvironmentSettings): Promise<void>;
  rematerializeSecrets(settings: DeploymentEnvironmentSettings): Promise<void>;
  verifySecrets(settings: DeploymentEnvironmentSettings): Promise<void>;
  readReceipt(uri: string): Promise<PlatformMigrationActivationReceipt | null>;
  writeReceipt(uri: string, receipt: PlatformMigrationActivationReceipt): Promise<void>;
  receiptUri(args: PlatformMigrationActivationIdentity): string;
  settingsForTarget(target: PlatformMigrationActivationTarget): DeploymentEnvironmentSettings;
}

const MIGRATION_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const PAIRS = new Set(["test-central:test-west", "prod-central:prod-west"]);
const KUBERNETES_NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertActivationReceiptMetadata(
  receipt: Record<string, unknown>,
  expected: PlatformMigrationActivationReceiptExpectation,
): void {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "platform-migration-activation-receipt" ||
    receipt.migrationId !== expected.migrationId ||
    receipt.source !== expected.source ||
    receipt.target !== expected.target ||
    receipt.revision !== expected.revision ||
    receipt.credentials !== "migration-only-mattermost-and-target-gitea" ||
    receipt.secrets !== "rematerialized-and-verified" ||
    receipt.verified !== true
  ) {
    throw new Error("activation receipt does not match the exact migration and revision");
  }
}

function activationReceiptServices(receipt: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(receipt.services) || receipt.services.length !== 2) {
    throw new Error("activation receipt does not prove the exact Mattermost and Gitea service set");
  }
  const services = receipt.services.map((candidate) => record(candidate));
  if (services.some((service) => service === null)) {
    throw new Error("activation receipt does not prove the exact Mattermost and Gitea service set");
  }
  return services as Record<string, unknown>[];
}

function assertExactActivationServiceSet(services: readonly Record<string, unknown>[]): void {
  const names = services.map((service) => service.service);
  if (new Set(names).size !== 2 || !names.includes("mattermost") || !names.includes("gitea")) {
    throw new Error("activation receipt does not prove the exact Mattermost and Gitea service set");
  }
}

function matchesActivationServiceName(service: Record<string, unknown>, name: string): boolean {
  return service.service === "mattermost"
    ? /(^|-)mattermost($|-)/.test(name)
    : /(^|-)gitea($|-)/.test(name);
}

function assertActivationServiceIdentity(service: Record<string, unknown>): void {
  const name = service.name;
  const validKind = service.kind === "Deployment" || service.kind === "StatefulSet";
  const validName = typeof name === "string" && KUBERNETES_NAME.test(name);
  if (!validKind || !validName || !matchesActivationServiceName(service, name as string)) {
    throw new Error("activation receipt service does not have a valid workload identity");
  }
}

export function assertPlatformMigrationActivationReceipt(
  value: unknown,
  expected: PlatformMigrationActivationReceiptExpectation,
): asserts value is PlatformMigrationActivationReceipt {
  const receipt = record(value);
  if (receipt === null) {
    throw new Error("activation receipt does not match the exact migration and revision");
  }
  assertActivationReceiptMetadata(receipt, expected);
  const services = activationReceiptServices(receipt);
  assertExactActivationServiceSet(services);
  services.forEach(assertActivationServiceIdentity);
}

function value(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const matches = args.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) throw new Error(`argument appears more than once: --${name}=`);
  return matches.length === 1 ? matches[0]!.slice(prefix.length) : null;
}

export function platformMigrationActivationConfirmation(source: PlatformMigrationActivationSource, target: PlatformMigrationActivationTarget, migrationId: string): string {
  return `octogee/platform-migration-activation/${source}/${target}/${migrationId}`;
}

export function parsePlatformMigrationActivationArgs(argv: readonly string[]): PlatformMigrationActivationArgs {
  const unknown = argv.filter((argument) => argument !== "--apply" && !/^--(?:source|target|migration-id|confirm)=/.test(argument));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  const source = value(argv, "source");
  const target = value(argv, "target");
  const migrationId = value(argv, "migration-id");
  if ((source !== "test-central" && source !== "prod-central") || (target !== "test-west" && target !== "prod-west") || !PAIRS.has(`${source}:${target}`)) {
    throw new Error("only supports test-central -> test-west or prod-central -> prod-west");
  }
  if (!migrationId || !MIGRATION_ID.test(migrationId)) throw new Error("migration id must contain 3-80 lowercase letters, digits, or hyphens");
  const apply = argv.includes("--apply");
  const confirmation = value(argv, "confirm");
  const expected = platformMigrationActivationConfirmation(source, target, migrationId);
  if (apply && confirmation !== expected) throw new Error(`apply requires --confirm=${expected}`);
  return { source, target, migrationId, apply, confirmation };
}

function assertServices(services: readonly PlatformMigrationActivationService[]): void {
  if (services.length !== 2 || new Set(services.map((service) => service.service)).size !== 2) throw new Error("activation requires exactly one Mattermost and one Gitea service");
  for (const service of services) {
    if ((service.replicas !== 0 && service.replicas !== 1) || !Number.isSafeInteger(service.readyReplicas) || !Number.isSafeInteger(service.pods)) {
      throw new Error(`activation service state is unsafe: ${service.kind}/${service.name}`);
    }
    if (service.replicas === 0 && (service.readyReplicas !== 0 || service.pods !== 0)) throw new Error(`stopped activation service still has pods: ${service.kind}/${service.name}`);
    if (service.replicas === 1 && (service.readyReplicas !== 1 || service.pods !== 1)) throw new Error(`running activation service is not Ready: ${service.kind}/${service.name}`);
  }
}

export async function executePlatformMigrationActivation(args: PlatformMigrationActivationArgs, dependencies: PlatformMigrationActivationDependencies): Promise<{ receipt: string; status: "complete" | "dry-run" }> {
  await dependencies.assertReceiptStorage();
  const revision = await dependencies.assertExactMergedMain();
  await dependencies.assertMigrationPreconditions(args, revision);
  const receiptUri = dependencies.receiptUri(args);
  const existing = await dependencies.readReceipt(receiptUri);
  if (existing !== null) {
    assertPlatformMigrationActivationReceipt(existing, { ...args, revision });
    return { receipt: receiptUri, status: "complete" };
  }
  const settings = dependencies.settingsForTarget(args.target);
  const services = await dependencies.readServices(settings);
  assertServices(services);
  if (!args.apply) return { receipt: receiptUri, status: "dry-run" };
  const activationReceipt: PlatformMigrationActivationReceipt = {
    schemaVersion: 1, kind: "platform-migration-activation-receipt", migrationId: args.migrationId, source: args.source, target: args.target, revision,
    completedAt: new Date().toISOString(), services: services.map(({ service, kind, name }) => ({ service, kind, name })),
    credentials: "migration-only-mattermost-and-target-gitea", secrets: "rematerialized-and-verified", verified: true,
  };
  try {
    for (const service of services) if (service.replicas === 0) await dependencies.scaleService(settings, service, 1);
    await dependencies.waitForServicesReady(settings, services);
    await dependencies.rotateMattermost(settings);
    await dependencies.resetGitea(settings);
    await dependencies.rematerializeSecrets(settings);
    await dependencies.verifySecrets(settings);
    try {
      await dependencies.writeReceipt(receiptUri, activationReceipt);
    } catch (error) {
      const committed = await dependencies.readReceipt(receiptUri);
      if (committed === null) throw error;
      assertPlatformMigrationActivationReceipt(committed, { ...args, revision });
      return { receipt: receiptUri, status: "complete" };
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const service of services) {
      try { await dependencies.scaleService(settings, service, 0); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    try { await dependencies.waitForServicesStopped(settings, services); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "activation failed and target service rollback was not proven");
    throw error;
  }
  return { receipt: receiptUri, status: "complete" };
}
