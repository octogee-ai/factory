

export type MigrationPhase =
  | "initial"
  | "keys-synced"
  | "pre-synced"
  | "source-quiesced"
  | "source-flushed"
  | "final-synced"
  | "target-verified"
  | "cutover-done"
  | "source-unmounted"
  | "done";

export interface MigrationState {
  phase: MigrationPhase;
  slug: string;
  uid: string;
  fromGatewayId: string;
  toGatewayId: string;
}

export type MigrationSyncMode = "keys" | "pre" | "final";

export type MigrationStep =
  | { action: "quiesce-source"; gateway: string; slug: string }
  | { action: "flush-source"; gateway: string; slug: string }
  | { action: "sync-state"; mode: MigrationSyncMode; from: string; to: string; slug: string }
  | { action: "verify-target"; gateway: string; slug: string }
  | { action: "cutover-firestore"; uid: string; from: string; to: string }
  | { action: "unmount-gateway"; role: "source" | "target"; gateway: string; slug: string }
  | { action: "complete" };

export function nextMigrationStep(state: MigrationState): MigrationStep {
  switch (state.phase) {
    case "initial":
      return {
        action: "sync-state",
        mode: "keys",
        from: state.fromGatewayId,
        to: state.toGatewayId,
        slug: state.slug,
      };
    case "keys-synced":
      return { action: "sync-state", mode: "pre", from: state.fromGatewayId, to: state.toGatewayId, slug: state.slug };
    case "pre-synced":
      return {
        action: "quiesce-source",
        gateway: state.fromGatewayId,
        slug: state.slug,
      };
    case "source-quiesced":
      return {
        action: "flush-source",
        gateway: state.fromGatewayId,
        slug: state.slug,
      };
    case "source-flushed":
      return {
        action: "sync-state",
        mode: "final",
        from: state.fromGatewayId,
        to: state.toGatewayId,
        slug: state.slug,
      };
    case "final-synced":
      return {
        action: "verify-target",
        gateway: state.toGatewayId,
        slug: state.slug,
      };
    case "target-verified":
      return {
        action: "cutover-firestore",
        uid: state.uid,
        from: state.fromGatewayId,
        to: state.toGatewayId,
      };
    case "cutover-done":
      return {
        action: "unmount-gateway",
        role: "source",
        gateway: state.fromGatewayId,
        slug: state.slug,
      };
    case "source-unmounted":
    case "done":
      return { action: "complete" };
  }
}

export function advancePhase(p: MigrationPhase): MigrationPhase {
  switch (p) {
    case "initial":
      return "keys-synced";
    case "keys-synced":
      return "pre-synced";
    case "pre-synced":
      return "source-quiesced";
    case "source-quiesced":
      return "source-flushed";
    case "source-flushed":
      return "final-synced";
    case "final-synced":
      return "target-verified";
    case "target-verified":
      return "cutover-done";
    case "cutover-done":
      return "source-unmounted";
    case "source-unmounted":
      return "done";
    case "done":
      return "done";
    default:
      throw new Error(`Unknown phase: ${p satisfies never}`);
  }
}

export function fullPlan(state: MigrationState): MigrationStep[] {
  const steps: MigrationStep[] = [];
  let cursor = state;
  for (let safety = 0; safety < 10; safety++) {
    const step = nextMigrationStep(cursor);
    if (step.action === "complete") break;
    steps.push(step);
    cursor = { ...cursor, phase: advancePhase(cursor.phase) };
  }
  return steps;
}

export function rollbackPlan(state: MigrationState): MigrationStep[] {
  switch (state.phase) {
    case "initial":
      return [];
    case "keys-synced":
    case "pre-synced":
    case "source-quiesced":
    case "source-flushed":
    case "final-synced":
    case "target-verified":
      return [
        {
          action: "unmount-gateway",
          role: "target",
          gateway: state.toGatewayId,
          slug: state.slug,
        },
      ];
    case "cutover-done":
      return [
        {
          action: "cutover-firestore",
          uid: state.uid,
          from: state.toGatewayId, // current owner
          to: state.fromGatewayId, // restore source
        },
        {
          action: "unmount-gateway",
          role: "target",
          gateway: state.toGatewayId,
          slug: state.slug,
        },
      ];
    case "source-unmounted":
    case "done":
      throw new Error(
        `Cannot rollback from phase '${state.phase}': source data is unmounted/destroyed.`,
      );
  }
}

export function describeStep(step: MigrationStep): string {
  switch (step.action) {
    case "quiesce-source":
      return `quiesce ${step.slug} on ${step.gateway} (stop accepting new prompts; let in-flight runs settle)`;
    case "flush-source":
      return `flush durable state for ${step.slug} on ${step.gateway} after quiescence`;
    case "sync-state":
      if (step.mode === "keys") {
        return `seed per-user SSH key for ${step.slug} directly from ${step.from} → ${step.to}`;
      }
      return `${step.mode === "pre" ? "pre-sync" : "final-sync"} local state for ${step.slug} directly from ${step.from} → ${step.to}`;
    case "verify-target":
      return `verify ${step.slug} is mounted and channel-ready on ${step.gateway} before cutover`;
    case "cutover-firestore":
      return `Firestore: users/{uid=${step.uid}}.provisioning.openclaw.gatewayId = ${step.to} (was ${step.from}) + gatewayProfile mirror`;
    case "unmount-gateway":
      return `unmount ${step.role} copy of ${step.slug} on ${step.gateway} (release agent + data dir)`;
    case "complete":
      return "(done)";
  }
}
