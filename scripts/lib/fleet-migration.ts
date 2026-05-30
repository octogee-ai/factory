

export type MigrationPhase =
  | "initial"
  | "source-quiesced"
  | "state-transferred"
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

export type MigrationStep =
  | { action: "quiesce-source"; gateway: string; slug: string }
  | { action: "transfer-state"; from: string; to: string; slug: string }
  | { action: "cutover-firestore"; uid: string; from: string; to: string }
  | { action: "unmount-source"; gateway: string; slug: string }
  | { action: "complete" };

export function nextMigrationStep(state: MigrationState): MigrationStep {
  switch (state.phase) {
    case "initial":
      return {
        action: "quiesce-source",
        gateway: state.fromGatewayId,
        slug: state.slug,
      };
    case "source-quiesced":
      return {
        action: "transfer-state",
        from: state.fromGatewayId,
        to: state.toGatewayId,
        slug: state.slug,
      };
    case "state-transferred":
      return {
        action: "cutover-firestore",
        uid: state.uid,
        from: state.fromGatewayId,
        to: state.toGatewayId,
      };
    case "cutover-done":
      return {
        action: "unmount-source",
        gateway: state.fromGatewayId,
        slug: state.slug,
      };
    case "source-unmounted":
    case "done":
      return { action: "complete" };
  }
}

const PHASE_ORDER: readonly MigrationPhase[] = [
  "initial",
  "source-quiesced",
  "state-transferred",
  "cutover-done",
  "source-unmounted",
  "done",
];

export function advancePhase(p: MigrationPhase): MigrationPhase {
  const i = PHASE_ORDER.indexOf(p);
  if (i === -1) {
    throw new Error(`Unknown phase: ${p}`);
  }
  return PHASE_ORDER[Math.min(i + 1, PHASE_ORDER.length - 1)];
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
    case "source-quiesced":
    case "state-transferred":

return [
        { action: "quiesce-source", gateway: state.fromGatewayId, slug: state.slug },
      ];
    case "cutover-done":

return [
        {
          action: "cutover-firestore",
          uid: state.uid,
          from: state.toGatewayId, // current owner
          to: state.fromGatewayId, // restore source
        },
        { action: "unmount-source", gateway: state.toGatewayId, slug: state.slug },
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
    case "transfer-state":
      return `push ~/.openclaw/agents/${step.slug} directly from ${step.from} → ${step.to}`;
    case "cutover-firestore":
      return `Firestore: users/{uid=${step.uid}}.provisioning.openclaw.gatewayId = ${step.to} (was ${step.from}) + gatewayProfile mirror`;
    case "unmount-source":
      return `unmount ${step.slug} on ${step.gateway} (release agent + data dir)`;
    case "complete":
      return "(done)";
  }
}
