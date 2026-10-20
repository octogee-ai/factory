export interface StartAfterSurgeReadinessOptions {
  released: () => Promise<boolean>;
  start: () => () => void;
  schedule?: (callback: () => void) => () => void;
  log: (message: string) => void;
}

export type ReadySiblingObservation =
  | { kind: "sibling"; podUid: string | null }
  | { kind: "self" }
  | { kind: "none"; reason: string };

export interface ObserveReadySiblingOptions {
  healthUrl: string;
  ownPodUid: string;
  fetchImpl?: typeof fetch;
}

export interface StartSurgeReadinessSelfReleaseOptions {
  released: () => Promise<boolean>;
  observe: () => Promise<ReadySiblingObservation>;
  release: () => Promise<void>;
  holdReason?: () => Promise<string | null>;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  now?: () => number;
  log: (message: string) => void;
}

const NEVER_SEEN_SIBLING_ABSENCE_OBSERVATIONS = 3;
const SELF_RELEASE_CHECK_INTERVAL_MS = 1_000;
const SELF_RELEASE_RETRY_CAP_MS = 30_000;
export const SEEN_SIBLING_ABSENCE_MS = 60_000;

// This cap only recovers a pod that never observed a sibling. Once a sibling was
// observed, a disappearance is a hard cutover after the absence window unless a
// controller reservation says a handoff is still in flight.
export const SURGE_READINESS_HOLD_DEADLINE_MS = 60 * 60_000;
const HOLD_PROGRESS_LOG_MS = 60_000;

interface SurgeReadinessSelfReleaseState {
  startedAt: number;
  sawSibling: boolean;
  absenceObservations: number;
  siblingAbsentSince: number | null;
  lastProgressLogAt: number;
  pendingProgress: string | null;
  blocker: string | null;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
}

export function selfReleaseRetryDelayMs(failedReleases: number): number {
  return Math.min(SELF_RELEASE_RETRY_CAP_MS, SELF_RELEASE_CHECK_INTERVAL_MS * 2 ** failedReleases);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function observeReadySibling(
  opts: ObserveReadySiblingOptions,
): Promise<ReadySiblingObservation> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(opts.healthUrl, {
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    return { kind: "none", reason: errorMessage(error) };
  }
  if (!response.ok) {
    throw new Error(`Ready sibling health returned HTTP ${response.status}`);
  }
  const body = await response.json() as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Ready sibling health returned an invalid body");
  }
  const podUid = (body as Record<string, unknown>).podUid;
  if (podUid === undefined || podUid === null) {
    return { kind: "sibling", podUid: null };
  }
  if (typeof podUid !== "string" || podUid.length === 0) {
    throw new Error("Ready sibling health returned an invalid podUid");
  }
  return podUid === opts.ownPodUid
    ? { kind: "self" }
    : { kind: "sibling", podUid };
}

function resetAbsence(state: SurgeReadinessSelfReleaseState): void {
  state.absenceObservations = 0;
  state.siblingAbsentSince = null;
}

function describeObservation(observation: ReadySiblingObservation): string {
  if (observation.kind === "sibling") {
    return `Ready sibling podUid=${observation.podUid ?? "legacy"}`;
  }
  if (observation.kind === "self") return "stable Service resolves to this pod";
  return `no Ready sibling: ${observation.reason}`;
}

function noteHoldProgress(
  state: SurgeReadinessSelfReleaseState,
  observation: ReadySiblingObservation,
  at: number,
): void {
  if (at - state.lastProgressLogAt < HOLD_PROGRESS_LOG_MS) return;
  state.lastProgressLogAt = at;
  state.pendingProgress =
    `[surge-handoff] still holding readiness after ` +
    `${Math.round((at - state.startedAt) / 1_000)}s — ${describeObservation(observation)}`;
}

function logPendingHoldProgress(
  state: SurgeReadinessSelfReleaseState,
  log: (message: string) => void,
): void {
  if (state.pendingProgress === null) return;
  log(state.pendingProgress + (state.blocker ? `; ${state.blocker}` : ""));
  state.pendingProgress = null;
}

function holdDeadlineReason(
  state: SurgeReadinessSelfReleaseState,
  at: number,
  detail: string,
): string | null {
  return at - state.startedAt >= SURGE_READINESS_HOLD_DEADLINE_MS
    ? `readiness hold hit its ${Math.round(SURGE_READINESS_HOLD_DEADLINE_MS / 60_000)}m cap ` +
      `without a handoff release — ${detail}`
    : null;
}

function selfReleaseReason(
  state: SurgeReadinessSelfReleaseState,
  observation: ReadySiblingObservation,
  at: number,
  log: (message: string) => void,
): string | null {
  if (observation.kind === "sibling") {
    if (!state.sawSibling) {
      log(`[surge-handoff] Ready sibling observed podUid=${observation.podUid ?? "legacy"}`);
    }
    state.sawSibling = true;
    resetAbsence(state);
    return null;
  }
  if (observation.kind === "self") {
    resetAbsence(state);
    log("[surge-handoff] stable Service resolved to this pod before marker release");
    return null;
  }
  if (state.sawSibling) {
    if (state.siblingAbsentSince === null) {
      state.siblingAbsentSince = at;
      log(`[surge-handoff] Ready sibling disappeared: ${observation.reason}`);
    }
    noteHoldProgress(state, observation, at);
    return at - state.siblingAbsentSince >= SEEN_SIBLING_ABSENCE_MS
      ? "Ready sibling remained absent for 60s"
      : null;
  }
  const capped = holdDeadlineReason(state, at, describeObservation(observation));
  if (capped) return capped;
  noteHoldProgress(state, observation, at);
  state.absenceObservations += 1;
  if (state.absenceObservations === 1) {
    log(`[surge-handoff] no Ready sibling observed: ${observation.reason}`);
  }
  return state.absenceObservations >= NEVER_SEEN_SIBLING_ABSENCE_OBSERVATIONS
    ? "never observed a Ready sibling"
    : null;
}

function recordBlocker(
  state: SurgeReadinessSelfReleaseState,
  blocker: string,
  log: (message: string) => void,
  logEvery: boolean,
  message: string,
): void {
  if (logEvery || state.blocker !== blocker) log(message);
  state.blocker = blocker;
}

async function releaseSurgeReadinessLocally(
  opts: StartSurgeReadinessSelfReleaseOptions,
  state: SurgeReadinessSelfReleaseState,
  reason: string,
): Promise<boolean> {
  try {
    await opts.release();
    opts.log(`[surge-handoff] self-released: ${reason}`);
    return true;
  } catch (error) {
    const message = errorMessage(error);
    recordBlocker(state, `last self-release failed: ${message}`, opts.log, true,
      `[surge-handoff] marker self-release failed: ${message}`);
    return false;
  }
}

type SelfReleaseHold = "free" | "held" | "unknown";

async function selfReleaseHold(
  opts: StartSurgeReadinessSelfReleaseOptions,
  state: SurgeReadinessSelfReleaseState,
): Promise<SelfReleaseHold> {
  let held: string | null;
  try {
    held = await opts.holdReason?.() ?? null;
  } catch (error) {
    const message = errorMessage(error);
    recordBlocker(state, `self-release check failed: ${message}`, opts.log, false,
      `[surge-handoff] self-release check failed: ${message}`);
    return "unknown";
  }
  if (held === null) {
    state.blocker = null;
    return "free";
  }
  recordBlocker(state, `self-release held: ${held}`, opts.log, false,
    `[surge-handoff] self-release held: ${held}`);
  return "held";
}

export function startSurgeReadinessSelfRelease(
  opts: StartSurgeReadinessSelfReleaseOptions,
): () => void {
  const schedule = opts.schedule ?? defaultSchedule;
  const now = opts.now ?? Date.now;
  let stopped = false;
  let finished = false;
  let checking = false;
  let failures = 0;
  let cancelCheck: (() => void) | null = null;
  const startedAt = now();
  const state: SurgeReadinessSelfReleaseState = {
    startedAt,
    sawSibling: false,
    absenceObservations: 0,
    siblingAbsentSince: null,
    lastProgressLogAt: startedAt,
    pendingProgress: null,
    blocker: null,
  };

  const releaseUnlessHeld = async (reason: string): Promise<void> => {
    const hold = await selfReleaseHold(opts, state);
    if (hold === "held") return;
    if (hold === "unknown") {
      failures += 1;
      return;
    }
    finished = await releaseSurgeReadinessLocally(opts, state, reason);
    failures = finished ? 0 : failures + 1;
  };

  const check = async (): Promise<void> => {
    if (stopped || finished || checking) return;
    checking = true;
    try {
      if (await opts.released()) {
        finished = true;
        return;
      }
      const observation = await opts.observe();
      const reason = selfReleaseReason(state, observation, now(), opts.log);
      if (reason !== null) await releaseUnlessHeld(reason);
      else if (state.pendingProgress !== null) await selfReleaseHold(opts, state);
      if (!finished) logPendingHoldProgress(state, opts.log);
    } catch (error) {
      resetAbsence(state);
      const message = errorMessage(error);
      opts.log(`[surge-handoff] self-release check failed: ${message}`);
      if (!state.sawSibling) {
        const capped = holdDeadlineReason(state, now(), `probe failing: ${message}`);
        if (capped) {
          finished = await releaseSurgeReadinessLocally(opts, state, capped);
          failures = finished ? 0 : failures + 1;
        }
      }
    } finally {
      checking = false;
    }
    if (!stopped && !finished) {
      cancelCheck = schedule(() => void check(), selfReleaseRetryDelayMs(failures));
    }
  };

  void check();
  return () => {
    stopped = true;
    cancelCheck?.();
  };
}

export function startAfterSurgeReadiness(
  opts: StartAfterSurgeReadinessOptions,
): () => void {
  const schedule = opts.schedule ?? defaultSchedule;
  let stopped = false;
  let checking = false;
  let cancelCheck: (() => void) | null = null;
  let stopStarted: (() => void) | null = null;

  const check = async (): Promise<void> => {
    if (stopped || checking || stopStarted) return;
    checking = true;
    try {
      if (await opts.released()) {
        if (!stopped) stopStarted = opts.start();
        return;
      }
    } catch (error) {
      opts.log(
        `[surge-handoff] readiness marker check failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      checking = false;
    }
    if (!stopped && !stopStarted) {
      cancelCheck = schedule(() => void check(), SELF_RELEASE_CHECK_INTERVAL_MS);
    }
  };

  void check();
  return () => {
    stopped = true;
    cancelCheck?.();
    stopStarted?.();
  };
}
