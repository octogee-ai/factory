import { FenceMismatchError, type AdmitUserInput, type PlatformStateStore } from "@octogee/core/platform-state";

export interface UserAdmissionRequest extends Pick<AdmitUserInput, "slug" | "persona"> {
  readonly uid: string;
}

export interface UserAdmissionSource {
  listPending(): Promise<readonly UserAdmissionRequest[]>;
  markAdmitted(uid: string): Promise<void>;
  subscribe(wake: () => void): () => void;
}

export type UserAdmissionSourceFactory = (log: (message: string) => void) => UserAdmissionSource;

export interface UserAdmissionDeps {
  readonly store: PlatformStateStore;
  readonly source: UserAdmissionSource;
  readonly log: (message: string) => void;
}

export interface UserAdmissionPass {
  readonly admitted: readonly string[];
  readonly duplicates: readonly string[];
  readonly failed: readonly string[];
}

type AdmissionOutcome = "admitted" | "duplicate";
type Subscribe = (wake: () => void) => () => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDuplicateAdmission(error: unknown): boolean {
  if (!(error instanceof FenceMismatchError)) return false;
  const { expected } = error;
  return typeof expected === "object" && expected !== null && "provisioningStatus" in expected;
}

async function admit(deps: UserAdmissionDeps, request: UserAdmissionRequest): Promise<AdmissionOutcome> {
  try {
    await deps.store.users.records.admit(request.uid, {
      slug: request.slug,
      persona: request.persona,
      provisioningStartedAt: { serverNow: true },
    });
    return "admitted";
  } catch (error) {
    if (isDuplicateAdmission(error)) return "duplicate";
    throw error;
  }
}

export async function reconcileUserAdmissions(deps: UserAdmissionDeps): Promise<UserAdmissionPass> {
  const admitted: string[] = [];
  const duplicates: string[] = [];
  const failed: string[] = [];
  let pending: readonly UserAdmissionRequest[];
  try {
    pending = await deps.source.listPending();
  } catch (error) {
    deps.log(`[user-admission] ⚠ could not read pending admissions: ${errorMessage(error)}`);
    return { admitted, duplicates, failed };
  }
  for (const request of pending) {
    let outcome: AdmissionOutcome;
    try {
      outcome = await admit(deps, request);
    } catch (error) {
      deps.log(`[user-admission] ⚠ could not admit ${request.uid}: ${errorMessage(error)}; retrying on the next pass`);
      failed.push(request.uid);
      continue;
    }
    try {
      await deps.source.markAdmitted(request.uid);
    } catch (error) {
      deps.log(
        `[user-admission] ⚠ admitted ${request.uid} but could not apply the recorded decision: ${errorMessage(error)}; retrying on the next pass`,
      );
      failed.push(request.uid);
      continue;
    }
    if (outcome === "admitted") {
      deps.log(`[user-admission] admitted ${request.uid}`);
      admitted.push(request.uid);
    } else {
      duplicates.push(request.uid);
    }
  }
  return { admitted, duplicates, failed };
}

export function placementPassOptions<Deps, Result>(input: {
  readonly admission: UserAdmissionDeps | null;
  readonly runPlacementPass: (deps: Deps) => Promise<Result>;
  readonly subscribeUnassigned?: Subscribe | undefined;
}): { runPass: (deps: Deps) => Promise<Result>; subscribe?: Subscribe | undefined } {
  const { admission, runPlacementPass, subscribeUnassigned } = input;
  if (admission === null) return { runPass: runPlacementPass, subscribe: subscribeUnassigned };
  return {
    runPass: async (deps) => {
      await reconcileUserAdmissions(admission);
      return runPlacementPass(deps);
    },
    subscribe: (wake) => {
      const stops = [admission.source.subscribe(wake), subscribeUnassigned?.(wake)];
      return () => {
        for (const stop of stops) stop?.();
      };
    },
  };
}
