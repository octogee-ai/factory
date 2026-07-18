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
  schedule?: (callback: () => void) => () => void;
  now?: () => number;
  log: (message: string) => void;
}

const NEVER_SEEN_SIBLING_ABSENCE_OBSERVATIONS = 3;
const SEEN_SIBLING_ABSENCE_MS = 60_000;

interface SurgeReadinessSelfReleaseState {
  sawSibling: boolean;
  absenceObservations: number;
  siblingAbsentSince: number | null;
}

function defaultSchedule(callback: () => void): () => void {
  const timer = setTimeout(callback, 1_000);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
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

function shouldSelfRelease(
  state: SurgeReadinessSelfReleaseState,
  observation: ReadySiblingObservation,
  now: () => number,
  log: (message: string) => void,
): boolean {
  if (observation.kind === "sibling") {
    if (!state.sawSibling) {
      log(`[surge-handoff] Ready sibling observed podUid=${observation.podUid ?? "legacy"}`);
    }
    state.sawSibling = true;
    resetAbsence(state);
    return false;
  }
  if (observation.kind === "self") {
    resetAbsence(state);
    log("[surge-handoff] stable Service resolved to this pod before marker release");
    return false;
  }
  if (!state.sawSibling) {
    state.absenceObservations += 1;
    if (state.absenceObservations === 1) {
      log(`[surge-handoff] no Ready sibling observed: ${observation.reason}`);
    }
    return state.absenceObservations >= NEVER_SEEN_SIBLING_ABSENCE_OBSERVATIONS;
  }
  if (state.siblingAbsentSince === null) {
    state.siblingAbsentSince = now();
    log(`[surge-handoff] Ready sibling disappeared: ${observation.reason}`);
  }
  return now() - state.siblingAbsentSince >= SEEN_SIBLING_ABSENCE_MS;
}

async function releaseSurgeReadinessLocally(
  opts: StartSurgeReadinessSelfReleaseOptions,
  sawSibling: boolean,
): Promise<boolean> {
  try {
    await opts.release();
    opts.log(
      sawSibling
        ? "[surge-handoff] self-released after Ready sibling remained absent for 60s"
        : "[surge-handoff] self-released without ever observing a Ready sibling",
    );
    return true;
  } catch (error) {
    opts.log(`[surge-handoff] marker self-release failed: ${errorMessage(error)}`);
    return false;
  }
}

export function startSurgeReadinessSelfRelease(
  opts: StartSurgeReadinessSelfReleaseOptions,
): () => void {
  const schedule = opts.schedule ?? defaultSchedule;
  const now = opts.now ?? Date.now;
  let stopped = false;
  let finished = false;
  let checking = false;
  let cancelCheck: (() => void) | null = null;
  const state: SurgeReadinessSelfReleaseState = {
    sawSibling: false,
    absenceObservations: 0,
    siblingAbsentSince: null,
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
      if (shouldSelfRelease(state, observation, now, opts.log)) {
        finished = await releaseSurgeReadinessLocally(opts, state.sawSibling);
      }
    } catch (error) {
      resetAbsence(state);
      opts.log(`[surge-handoff] self-release check failed: ${errorMessage(error)}`);
    } finally {
      checking = false;
    }
    if (!stopped && !finished) cancelCheck = schedule(() => void check());
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
    if (!stopped && !stopStarted) cancelCheck = schedule(() => void check());
  };

  void check();
  return () => {
    stopped = true;
    cancelCheck?.();
    stopStarted?.();
  };
}
