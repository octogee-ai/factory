import net from "node:net";
import type { Duplex } from "node:stream";
import { GATEWAY_EGRESS_SOCKS_HOST, GATEWAY_EGRESS_SOCKS_PORT, type GatewayEgressMode, type GatewayVmEgressState } from "@octogee/shared/types/glm";
import type { BrowserModeSync } from "./browser-mode.js";
import { EGRESS_CLOSE_NOT_SELECTED, SOCKS_REPLY } from "./protocol.js";
import { createNat64Discovery, resolveEgressTarget, systemLookup, vettedLookup, type AddressLookup } from "./denylist.js";
import { createSocks5Server, EgressDialError, type EgressDialer, type Socks5Server } from "./socks5.js";
import { createEgressTunnelHost, type EgressTunnelHost, type TunnelSocket } from "./tunnel-host.js";

export type EgressShellState = "connected" | "disconnected";

export type EgressListenerState = "listening" | "off" | "closed-pending-mode";

export interface EgressStatus {
  mode: GatewayEgressMode;
  shell: EgressShellState;
  listener: EgressListenerState;
  updatedAt: number | null;
  streams: number;
}

export interface EgressStore {
  read(): Promise<GatewayVmEgressState | null>;
  write(mode: GatewayEgressMode): Promise<GatewayVmEgressState>;
}

export interface EgressBootOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => void;
}

export interface ComputerEgressService {
  status(): EgressStatus;
  setMode(mode: GatewayEgressMode): Promise<EgressStatus>;
  load(): Promise<void>;
  boot(options?: EgressBootOptions): Promise<{ host: string; port: number }>;
  attachShell(socket: TunnelSocket): void;
  dial: EgressDialer;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
  onChange(listener: (status: EgressStatus) => void): () => void;
}

export interface ComputerEgressServiceOptions {
  store: EgressStore;
  listen?: { host: string; port: number };
  directDial?: EgressDialer;
  tunnel?: EgressTunnelHost;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  browser?: BrowserModeSync;
}

function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal, aborted: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export function createDirectDialer(lookup?: AddressLookup): EgressDialer {
  const nat64 = createNat64Discovery(lookup ?? systemLookup);
  const aborted = () => new EgressDialError(SOCKS_REPLY.hostUnreachable, "dial aborted");
  return async (host, port, signal) => {
    const target = await untilAborted(nat64().then((prefixes) => resolveEgressTarget(host, lookup, prefixes)), signal, aborted);
    if (signal.aborted) throw aborted();
    if (!target.allowed) throw new EgressDialError(SOCKS_REPLY.notAllowedByRuleset, `refused ${host}: ${target.reason}`);
    return new Promise<Duplex>((resolve, reject) => {
      const socket = net.connect({ host: unbracketed(host), port, lookup: vettedLookup(target.addresses), autoSelectFamily: true });
      const settle = () => { socket.off("error", fail); signal.removeEventListener("abort", abort); };
      const fail = (error: Error) => { settle(); socket.destroy(); reject(error); };
      const abort = () => fail(aborted());
      socket.once("error", fail);
      signal.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => { settle(); resolve(socket); });
    });
  };
}

export const directDialer: EgressDialer = createDirectDialer();

interface BootControl {
  settled(): boolean;
  onSleep(wake: () => void): void;
}

async function loadWithRetry(load: () => Promise<void>, options: EgressBootOptions, control: BootControl, log: (message: string, meta?: Record<string, unknown>) => void): Promise<void> {
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const schedule = options.schedule ?? ((callback, delayMs) => { setTimeout(callback, delayMs).unref(); });
  let attempt = 0;
  while (!control.settled()) {
    attempt += 1;
    try {
      await load();
      return;
    } catch (error) {
      if (control.settled()) return;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 10));
      log("computer egress mode could not be loaded; egress listener still closed, Chromium has no egress until it loads", { attempt, retryInMs: delayMs, error: error instanceof Error ? error.message : String(error) });
      await new Promise<void>((resolve) => { control.onSleep(resolve); schedule(resolve, delayMs); });
    }
  }
}

const WS_TRY_AGAIN_LATER = 1013;

export function createComputerEgressService(options: ComputerEgressServiceOptions): ComputerEgressService {
  const log = options.log ?? (() => {});
  const tunnel = options.tunnel ?? createEgressTunnelHost({ log });
  const direct = options.directDial ?? directDialer;
  const address = options.listen ?? { host: GATEWAY_EGRESS_SOCKS_HOST, port: GATEWAY_EGRESS_SOCKS_PORT };
  const listeners = new Set<(status: EgressStatus) => void>();
  let mode: GatewayEgressMode = "cloud";
  let updatedAt: number | null = null;
  let server: Socks5Server | null = null;
  let pendingMode = false;
  let bootSettled = false;
  let wakeBoot: (() => void) | null = null;
  let bootDone: Promise<unknown> = Promise.resolve();
  let bootWrites: Promise<unknown> = Promise.resolve();
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  const applyStored = (stored: GatewayVmEgressState | null) => {
    if (stored) apply(stored);
    else log("computer egress mode defaults to cloud; nothing stored", {});
  };
  const readAndApply = async () => applyStored(await options.store.read());
  const bootRead = async () => {
    const stored = await options.store.read();
    if (!bootSettled) applyStored(stored);
  };
  const writeDuringBoot = (next: GatewayEgressMode): Promise<EgressStatus> => {
    const run = bootWrites.then(async () => {
      apply(await options.store.write(next));
      bootSettled = true;
      wakeBoot?.();
      await bootDone;
      return status();
    });
    bootWrites = run.then(() => undefined, () => undefined);
    return run;
  };

  const listenerState = (): EgressListenerState => {
    if (server?.listening) return "listening";
    return pendingMode ? "closed-pending-mode" : "off";
  };
  const status = (): EgressStatus => ({
    mode,
    shell: tunnel.connected() ? "connected" : "disconnected",
    listener: listenerState(),
    updatedAt,
    streams: tunnel.streamCount(),
  });
  const notify = () => { const current = status(); for (const listener of listeners) listener(current); };
  tunnel.onChange(notify);

  const dial: EgressDialer = (host, port, signal) => {
    if (mode === "cloud") return direct(host, port, signal);
    if (!tunnel.connected()) return Promise.reject(new EgressDialError(SOCKS_REPLY.generalFailure, "desktop egress is selected but no desktop is connected"));
    return tunnel.dial(host, port, signal);
  };

  const apply = (state: GatewayVmEgressState) => {
    const changed = state.mode !== mode;
    mode = state.mode;
    updatedAt = state.updatedAt;
    if (changed) {
      if (!pendingMode) options.browser?.apply(mode);
      if (mode === "cloud") tunnel.detach(EGRESS_CLOSE_NOT_SELECTED, "Cloud egress selected");
      const terminated = server?.terminateRelays() ?? 0;
      log("computer egress mode applied", { mode, terminatedRelays: terminated });
    }
    notify();
  };

  return {
    status,
    dial,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    attachShell(socket) {
      if (pendingMode) {
        log("computer egress asked a desktop to retry; the stored mode is still loading", {});
        socket.close(WS_TRY_AGAIN_LATER, "Desktop egress mode is still loading");
        return;
      }
      if (mode !== "desktop") {
        log("computer egress refused a desktop connection; desktop mode is not selected", { mode, pendingMode });
        socket.close(EGRESS_CLOSE_NOT_SELECTED, "Desktop egress is not selected");
        return;
      }
      tunnel.attach(socket);
    },
    setMode(next) {
      if (pendingMode) return writeDuringBoot(next);
      return enqueue(async () => {
        await bootWrites;
        apply(await options.store.write(next));
        return status();
      });
    },
    load() {
      return enqueue(readAndApply);
    },
    boot(bootOptions = {}) {
      pendingMode = true;
      notify();
      bootSettled = false;
      const run = enqueue(async () => {
        await loadWithRetry(bootRead, bootOptions, { settled: () => bootSettled, onSleep: (wake) => { wakeBoot = wake; } }, log);
        wakeBoot = null;
        pendingMode = false;
        options.browser?.apply(mode);
        return this.start();
      });
      bootDone = run.then(() => undefined, () => undefined);
      return run;
    },
    start() {
      const bound = (socks: net.Server) => { const info = socks.address() as net.AddressInfo; return { host: info.address, port: info.port }; };
      if (server) return Promise.resolve(bound(server));
      const socks = createSocks5Server({ dial, log });
      server = socks;
      return new Promise<{ host: string; port: number }>((resolve, reject) => {
        socks.once("error", (error) => { server = null; reject(error); });
        socks.listen(address.port, address.host, () => {
          const listening = bound(socks);
          log("computer egress SOCKS5 listener ready", listening);
          notify();
          resolve(listening);
        });
      });
    },
    stop() {
      const current = server;
      server = null;
      if (!current) return Promise.resolve();
      return new Promise<void>((resolve) => current.close(() => { notify(); resolve(); }));
    },
  };
}
