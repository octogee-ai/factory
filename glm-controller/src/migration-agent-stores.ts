type Builder = { uid: string; slug: string };
type Gateway = { gatewayClass: "shared" | "builder"; ownerUid: string | null; builderSlug: string | null };

export interface AgentStoreHandoffAuthority {
  expectedBuilderUid: string;
  assertCurrent(): Promise<void>;
}

export type PrepareMigrationAgentStores = (gatewayId: string, slug: string, authority?: AgentStoreHandoffAuthority) => Promise<void>;

function assertBuilderIdentity(builder: Builder, slug: string, expectedUid?: string): void {
  if (!builder.uid || builder.slug !== slug || expectedUid !== undefined && builder.uid !== expectedUid) {
    throw new Error("Agent-store handoff Builder identity changed");
  }
}

function assertGatewayOwner(gateway: Gateway, gatewayId: string, builder: Builder): void {
  if (gateway.gatewayClass === "builder" && (gateway.ownerUid !== builder.uid || gateway.builderSlug !== builder.slug)) {
    throw new Error(`Agent-store handoff owner differs on Gateway ${gatewayId}`);
  }
  if (gateway.gatewayClass === "shared" && (gateway.ownerUid || gateway.builderSlug)) {
    throw new Error(`Shared Gateway ${gatewayId} has a Builder identity`);
  }
}

function assertGatewayUnchanged(current: Gateway | null, expected: Gateway): void {
  if (!current || current.gatewayClass !== expected.gatewayClass ||
      current.ownerUid !== expected.ownerUid || current.builderSlug !== expected.builderSlug) {
    throw new Error("Agent-store handoff Gateway identity changed during credential preparation");
  }
}

function isPostgresHandoffTimeout(error: unknown): boolean {
  const pg = error as { code?: unknown; message?: unknown };
  return pg?.code === "55P03" || pg?.code === "57014" && typeof pg.message === "string" && /statement timeout/i.test(pg.message);
}

export function createMigrationAgentStorePreparer(deps: {
  readGateway(gatewayId: string): Promise<Gateway | null>;
  readBuilder(slug: string): Promise<Builder>;
  ensureCredentials(gatewayId: string): Promise<void>;
  transferOwnership(builder: Builder, target: "shared" | "builder", assertCurrent?: () => Promise<void>): Promise<void>;
}): PrepareMigrationAgentStores {
  return async (gatewayId, slug, authority) => {
    if (authority && !authority.expectedBuilderUid) throw new Error("Agent-store handoff requires the claimed Builder identity");
    await authority?.assertCurrent();
    const gateway = await deps.readGateway(gatewayId);
    if (!gateway) throw new Error(`Agent-store handoff requires the desired Gateway ${gatewayId}`);
    const builder = await deps.readBuilder(slug);
    assertBuilderIdentity(builder, slug, authority?.expectedBuilderUid);
    assertGatewayOwner(gateway, gatewayId, builder);
    await authority?.assertCurrent();
    await deps.ensureCredentials(gatewayId);
    if (authority) {
      const currentGateway = await deps.readGateway(gatewayId);
      const currentBuilder = await deps.readBuilder(slug);
      assertGatewayUnchanged(currentGateway, gateway);
      assertBuilderIdentity(currentBuilder, slug, builder.uid);
      await authority.assertCurrent();
    }
    try {
      if (authority) await deps.transferOwnership(builder, gateway.gatewayClass, authority.assertCurrent);
      else await deps.transferOwnership(builder, gateway.gatewayClass);
    } catch (error) {
      if (isPostgresHandoffTimeout(error)) {
        throw new Error(`agent-store handoff timeout: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      throw error;
    }
    await authority?.assertCurrent();
  };
}
