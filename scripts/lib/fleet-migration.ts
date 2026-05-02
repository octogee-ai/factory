/**
 * Fleet migration state machine — pure functions.
 *
 * Drives a customer's mount from `fromGatewayId` to `toGatewayId` via
 * gateway-side RPCs. Pure so it's exhaustively testable without spinning
 * up infrastructure. Phase 2 wires this to real HTTP calls; Phase 1 (the
 * `fleet migrate-customer --plan` CLI verb) renders the plan it produces
 * for human review.
 *
 * Migration ordering (single forward pass, no concurrency):
 *
 *   1. quiesce-source        Tell GW-A to stop accepting new prompts. In-flight
 *                            runs settle to disk before snapshot. Required so
 *                            the export captures the actual conversation
 *                            transcript (OpenClaw appends to JSONL on message
 *                            *complete*; mid-flight tool calls would be lost).
 *
 *   2. transfer-state        Stream `~/.openclaw/agents/{slug}` from GW-A to
 *                            GW-B. Combines /export and /import into one
 *                            atomic step from the state machine's view.
 *
 *   3. cutover-firestore     Flip `users/{uid}.provisioning.openclaw.gatewayId`
 *                            from→to. chat-proxy reroutes the WS upstream on
 *                            the next reconnect. The customer briefly sees
 *                            ~2-3s of "connecting…" but the conversation
 *                            history is intact.
 *
 *   4. unmount-source        Release GW-A's customer record. Removes from
 *                            `gateways/{from}.mountedCustomers` and unloads
 *                            the agent on disk.
 *
 * Each phase has an explicit pre-cutover / post-cutover safety boundary.
 * Pre-cutover: source still owns the customer; abort = un-quiesce, no data
 * lost. Post-cutover: target owns; abort means reversing the Firestore flip
 * AND unmounting the target (which still has the freshly-imported state).
 *
 * Anti-corruption: if the rollback path itself fails post-cutover, the
 * customer is on the target with no Firestore evidence. That's
 * recoverable with a follow-up `add-customer` to the target — not
 * silent data loss.
 */

// ── Types ───────────────────────────────────────────────────────────────────

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

/**
 * Step the orchestrator should execute next. Each variant carries exactly
 * the data the caller needs to make the RPC / Firestore write — no hidden
 * lookups, no globals.
 */
export type MigrationStep =
  | { action: "quiesce-source"; gateway: string; slug: string }
  | { action: "transfer-state"; from: string; to: string; slug: string }
  | { action: "cutover-firestore"; uid: string; from: string; to: string }
  | { action: "unmount-source"; gateway: string; slug: string }
  | { action: "complete" };

// ── Forward path ────────────────────────────────────────────────────────────

/**
 * Returns the next step to execute given the current observed state.
 *
 * Caller pattern:
 *   let state = { phase: "initial", ... }
 *   while (true) {
 *     const step = nextMigrationStep(state)
 *     if (step.action === "complete") break
 *     await executeStep(step)
 *     state = { ...state, phase: advancePhase(state.phase) }
 *   }
 */
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

/**
 * Full plan from initial → done. Used by the `--plan` CLI verb so ops can
 * preview a migration before any RPCs fire.
 */
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

// ── Rollback path ───────────────────────────────────────────────────────────

/**
 * Steps required to roll back from the given state to a safe resting state
 * (customer mounted on the original source). The "safe state" depends on
 * how far we got:
 *
 *   - Pre-cutover (initial / source-quiesced / state-transferred):
 *     source still owns. Just un-quiesce. Target may have a partial state
 *     dir from a failed import — caller can prune it lazily; doesn't block.
 *
 *   - Post-cutover (cutover-done):
 *     target owns. Reverse the Firestore flip (so source owns again), then
 *     unmount target. Source still has the customer's data dir intact
 *     (we never delete it until source-unmounted), so the customer can
 *     resume on source without re-cloning from Gitea.
 *
 *   - source-unmounted / done:
 *     source's data dir is gone. Cannot roll back without re-bootstrap.
 *     Throw — caller should never invoke rollback this late.
 *
 * Returns an ordered list of steps. Caller executes them in order; if any
 * step itself fails, that's a runbook situation (see surrounding code).
 */
export function rollbackPlan(state: MigrationState): MigrationStep[] {
  switch (state.phase) {
    case "initial":
      // Nothing to undo; source still owns and was never quiesced.
      return [];
    case "source-quiesced":
    case "state-transferred":
      // Source is still mounted with its data dir intact. Un-quiesce by
      // re-firing the controller's pick-next on the source gateway — the
      // source gateway will notice no work to do and resume servicing.
      // Modeled as a quiesce-source action targeted at source again; the
      // caller distinguishes "rollback" from "forward" by the phase the
      // state was in when rollbackPlan was called.
      //
      // (We deliberately don't add a separate `unquiesce` action variant.
      // The gateway-side `/quiesce` RPC takes a {paused: bool} flag in
      // its real implementation; toggling is the same RPC.)
      return [
        { action: "quiesce-source", gateway: state.fromGatewayId, slug: state.slug },
      ];
    case "cutover-done":
      // Target owns. Reverse: cutover-firestore back to source, then
      // unmount target (which still has the freshly imported state).
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

// ── Pretty-printing ─────────────────────────────────────────────────────────

/** One-line human description of a step. Used by `--plan` to render a list. */
export function describeStep(step: MigrationStep): string {
  switch (step.action) {
    case "quiesce-source":
      return `quiesce ${step.slug} on ${step.gateway} (stop accepting new prompts; let in-flight runs settle)`;
    case "transfer-state":
      return `stream ~/.openclaw/agents/${step.slug} from ${step.from} → ${step.to}`;
    case "cutover-firestore":
      return `Firestore: users/{uid=${step.uid}}.provisioning.openclaw.gatewayId = ${step.to} (was ${step.from})`;
    case "unmount-source":
      return `unmount ${step.slug} on ${step.gateway} (release agent + data dir)`;
    case "complete":
      return "(done)";
  }
}
