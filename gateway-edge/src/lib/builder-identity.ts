import {
  BUILDER_IDENTITY_ROUTE,
  parseBuilderIdentity,
  type BuilderIdentity,
  type ClaimedBuilderIdentity,
} from "@octogee/shared/types/builder-identity";
import { gatewayCredentialHeaders, internalFetch } from "./internal-fetch.js";

type Schedule = (callback: () => void, delayMs: number) => () => void;

export interface BuilderIdentityStore {
  current(): BuilderIdentity | null;
  start(): () => void;
}

export const BUILDER_IDENTITY_POLL_MS = 1_000;
export const BUILDER_IDENTITY_RETRY_MS = 5_000;

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
}

function settled(identity: BuilderIdentity): boolean {
  return identity.state === "claimed" || (identity.state === "unavailable" && identity.reason === "retired");
}

export function createBuilderIdentityStore(input: {
  read: () => Promise<BuilderIdentity>;
  log: (message: string) => void;
  schedule?: Schedule;
}): BuilderIdentityStore {
  const schedule = input.schedule ?? defaultSchedule;
  let identity: BuilderIdentity | null = null;
  return {
    current: () => identity,
    start() {
      let stopped = false;
      let cancel: (() => void) | null = null;
      const poll = async (): Promise<void> => {
        let delay = BUILDER_IDENTITY_POLL_MS;
        try {
          const next = await input.read();
          if (stopped) return;
          identity = next;
          if (settled(next)) return;
        } catch (error) {
          if (stopped) return;
          input.log(`[builder-identity] broker read failed: ${error instanceof Error ? error.message : String(error)}`);
          delay = BUILDER_IDENTITY_RETRY_MS;
        }
        cancel = schedule(() => { void poll(); }, delay);
      };
      void poll();
      return () => {
        stopped = true;
        cancel?.();
      };
    },
  };
}

export function brokerBuilderIdentityReader(env: NodeJS.ProcessEnv = process.env): () => Promise<BuilderIdentity> {
  const gatewayId = env.GATEWAY_ID?.trim();
  const base = (env.FLEET_BROKER_URL || env.OCTOGEE_API_URL)?.replace(/\/$/u, "");
  if (!gatewayId || !base) throw new Error("Builder identity requires GATEWAY_ID and FLEET_BROKER_URL");
  return async () => {
    const response = await internalFetch(`${base}${BUILDER_IDENTITY_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...await gatewayCredentialHeaders() },
      body: JSON.stringify({ gatewayId }),
    });
    if (!response.ok) throw new Error(`fleet broker Builder identity returned ${response.status}`);
    const body = await response.json() as { identity?: unknown };
    const identity = parseBuilderIdentity(body.identity, gatewayId);
    if (!identity) throw new Error("fleet broker returned a malformed Builder identity");
    return identity;
  };
}

let activeStore: BuilderIdentityStore | null = null;

export function installBuilderIdentityStore(store: BuilderIdentityStore): void {
  activeStore = store;
}

export function builderIdentity(): BuilderIdentity | null {
  return activeStore?.current() ?? null;
}

export function claimedBuilderIdentity(): ClaimedBuilderIdentity | null {
  const identity = builderIdentity();
  return identity?.state === "claimed" ? identity : null;
}
