export const RETIRED_COMPUTER_BINDING_DENIAL_REASON = "retired computer bindings may only reach final-checkpoint routes";
export const BUILDER_RUNTIME_STATE_RECOVERY_TIERS = ["minute", "hour", "day"];
export function sharedContextCheckpointObjectPath(slug, checkpoint, archive) {
    return `customers/${slug}/computer-home/shared-context/${checkpoint.name}/${checkpoint.generation}/${archive.archiveId}/${archive.contextSha256}.tar.gz`;
}
