type Builder = { uid: string; slug: string };
type Gateway = { gatewayClass: "shared" | "builder"; ownerUid: string | null; builderSlug: string | null };

export type PrepareMigrationAgentStores = (gatewayId: string, slug: string) => Promise<void>;

export function createMigrationAgentStorePreparer(deps: {
  readGateway(gatewayId: string): Promise<Gateway | null>;
  readBuilder(slug: string): Promise<Builder>;
  ensureCredentials(gatewayId: string): Promise<void>;
  transferOwnership(builder: Builder, target: "shared" | "builder"): Promise<void>;
}): PrepareMigrationAgentStores {
  return async (gatewayId, slug) => {
    const gateway = await deps.readGateway(gatewayId);
    if (!gateway) throw new Error(`Agent-store handoff requires the desired Gateway ${gatewayId}`);
    const builder = await deps.readBuilder(slug);
    if (!builder.uid || builder.slug !== slug) throw new Error("Agent-store handoff Builder identity changed");
    if (gateway.gatewayClass === "builder" && (gateway.ownerUid !== builder.uid || gateway.builderSlug !== slug)) {
      throw new Error(`Agent-store handoff owner differs on Gateway ${gatewayId}`);
    }
    if (gateway.gatewayClass === "shared" && (gateway.ownerUid || gateway.builderSlug)) {
      throw new Error(`Shared Gateway ${gatewayId} has a Builder identity`);
    }
    await deps.ensureCredentials(gatewayId);
    await deps.transferOwnership(builder, gateway.gatewayClass);
  };
}
