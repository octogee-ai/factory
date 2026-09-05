import type { Firestore } from "firebase-admin/firestore";
import { GLM_GATEWAYS_COLLECTION, homeCheckpointOutstanding, type GatewayVmHomeState } from "@octogee/shared/types/glm";

export const HOME_CHECKPOINT_TIMEOUT_MS = 15 * 60_000;
export const HOME_CHECKPOINT_POLL_MS = 10_000;

export type HomeCheckpointWaitResult =
  | { outcome: "completed"; completedAt: number }
  | { outcome: "timeout" }
  | { outcome: "cancelled" };

export interface HomeCheckpointWaitDeps {
  readHomeCheckpointCompletedAt: (gatewayId: string) => Promise<number | null>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs?: number;
  pollMs?: number;
}

export async function awaitHomeCheckpoint(
  deps: HomeCheckpointWaitDeps,
  input: { gatewayId: string; requestedAt: number; cancellationRequested?: () => Promise<boolean> },
): Promise<HomeCheckpointWaitResult> {
  const timeoutMs = deps.timeoutMs ?? HOME_CHECKPOINT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? HOME_CHECKPOINT_POLL_MS;
  while (true) {
    const completedAt = await deps.readHomeCheckpointCompletedAt(input.gatewayId);
    if (completedAt !== null && completedAt >= input.requestedAt) return { outcome: "completed", completedAt };
    if (await input.cancellationRequested?.()) return { outcome: "cancelled" };
    if (deps.now() - input.requestedAt >= timeoutMs) return { outcome: "timeout" };
    await deps.wait(pollMs);
  }
}

type HomeDb = Pick<Firestore, "collection">;

export function readVmHome(data: Record<string, unknown> | undefined): Partial<GatewayVmHomeState> | undefined {
  const home = data?.vmHome;
  return home && typeof home === "object" ? (home as Partial<GatewayVmHomeState>) : undefined;
}

export function homeCheckpointCompletedAt(home: Partial<GatewayVmHomeState> | undefined): number | null {
  const completedAt = home?.lastCheckpoint?.completedAt;
  return typeof completedAt === "number" ? completedAt : null;
}

export async function requestHomeCheckpoint(db: HomeDb, gatewayId: string, requestedAt: number): Promise<void> {
  await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).set({ vmHome: { checkpointRequestedAt: requestedAt } }, { merge: true });
}

export async function readHomeCheckpointCompletedAt(db: HomeDb, gatewayId: string): Promise<number | null> {
  const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  const home = readVmHome(snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
  return homeCheckpointOutstanding(home) ? null : homeCheckpointCompletedAt(home);
}
