export function nextMigrationStep(state) {
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
            return {
                action: "restore-target",
                gateway: state.toGatewayId,
                uid: state.uid,
                slug: state.slug,
            };
        case "target-restored":
            return {
                action: "sync-state",
                mode: "pre",
                from: state.fromGatewayId,
                to: state.toGatewayId,
                slug: state.slug,
            };
        case "pre-synced":
            return {
                action: "quiesce-source",
                gateway: state.fromGatewayId,
                slug: state.slug,
            };
        case "source-quiesced":
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
const PHASE_ORDER = [
    "initial",
    "keys-synced",
    "target-restored",
    "pre-synced",
    "source-quiesced",
    "final-synced",
    "target-verified",
    "cutover-done",
    "source-unmounted",
    "done",
];
export function advancePhase(p) {
    const i = PHASE_ORDER.indexOf(p);
    if (i === -1) {
        throw new Error(`Unknown phase: ${p}`);
    }
    return PHASE_ORDER[Math.min(i + 1, PHASE_ORDER.length - 1)];
}
export function fullPlan(state) {
    const steps = [];
    let cursor = state;
    for (let safety = 0; safety < 10; safety++) {
        const step = nextMigrationStep(cursor);
        if (step.action === "complete")
            break;
        steps.push(step);
        cursor = { ...cursor, phase: advancePhase(cursor.phase) };
    }
    return steps;
}
export function rollbackPlan(state) {
    switch (state.phase) {
        case "initial":
            return [];
        case "keys-synced":
        case "target-restored":
        case "pre-synced":
        case "source-quiesced":
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
            throw new Error(`Cannot rollback from phase '${state.phase}': source data is unmounted/destroyed.`);
    }
}
export function describeStep(step) {
    switch (step.action) {
        case "quiesce-source":
            return `quiesce ${step.slug} on ${step.gateway} (stop accepting new prompts; let in-flight runs settle)`;
        case "restore-target":
            return `restore durable state for ${step.slug} onto ${step.gateway} before live sync`;
        case "sync-state":
            if (step.mode === "keys") {
                return `seed per-customer SSH key for ${step.slug} directly from ${step.from} → ${step.to}`;
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
