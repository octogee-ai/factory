import net, { type AddressInfo, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayEgressMode, GatewayVmEgressState } from "@octogee/shared/types/glm";
import { EGRESS_CLOSE_NOT_SELECTED, SOCKS_REPLY } from "./protocol.js";
import { createVmEgressService, createDirectDialer, type VmEgressService, type EgressStore } from "./service.js";
import { createSocks5Server } from "./socks5.js";
import { createEgressTunnelHost } from "./tunnel-host.js";

function memoryStore(initial: GatewayVmEgressState | null = null): EgressStore & { state: GatewayVmEgressState | null; writes: GatewayEgressMode[] } {
  const store = {
    state: initial,
    writes: [] as GatewayEgressMode[],
    async read() { return store.state; },
    async write(mode: GatewayEgressMode) { store.writes.push(mode); store.state = { mode, updatedAt: 9_000 }; return store.state; },
  };
  return store;
}

const services: VmEgressService[] = [];
const sockets: Socket[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(services.splice(0).map((service) => service.stop()));
});

describe("cloud-mode direct dialer", () => {
  it("resolves first and refuses a name that rebinds to the VM's loopback or private ranges", async () => {
    const lookup = vi.fn(async (host: string) => host === "rebind.example"
      ? [{ address: "127.0.0.1", family: 4 }]
      : [{ address: "203.0.113.10", family: 4 }, { address: "10.0.0.7", family: 4 }]);
    const dial = createDirectDialer(lookup);
    await expect(dial("rebind.example", 7777, new AbortController().signal)).rejects.toMatchObject({ reply: SOCKS_REPLY.notAllowedByRuleset });
    await expect(dial("half-private.example", 443, new AbortController().signal)).rejects.toMatchObject({ reply: SOCKS_REPLY.notAllowedByRuleset });
    await expect(dial("169.254.169.254", 80, new AbortController().signal)).rejects.toMatchObject({ reply: SOCKS_REPLY.notAllowedByRuleset });
    await expect(dial("[::1]", 9222, new AbortController().signal)).rejects.toMatchObject({ reply: SOCKS_REPLY.notAllowedByRuleset });
    expect(lookup.mock.calls.filter(([host]) => host !== "ipv4only.arpa")).toHaveLength(2);
  });

  it("hands Node every vetted answer without re-resolving, so a dual-stack name can fall back past an unreachable family", async () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const connect = vi.spyOn(net, "connect").mockImplementation((() => { setImmediate(() => socket.emit("connect")); return socket; }) as unknown as typeof net.connect);
    const dial = createDirectDialer(async () => [{ address: "2600:1901:0:b2c0::", family: 6 }, { address: "203.0.113.10", family: 4 }]);
    await dial("dual.example", 443, new AbortController().signal);
    const options = connect.mock.calls[0]![0] as unknown as net.TcpNetConnectOpts;
    expect(options).toMatchObject({ host: "dual.example", port: 443, autoSelectFamily: true });
    const lookup = options.lookup!;
    const all = await new Promise((resolve) => lookup("dual.example", { all: true }, (_error, addresses) => resolve(addresses)));
    expect(all).toEqual([{ address: "2600:1901:0:b2c0::", family: 6 }, { address: "203.0.113.10", family: 4 }]);
    const ipv4 = await new Promise((resolve) => lookup("dual.example", { family: 4 }, (_error, address, family) => resolve([address, family])));
    expect(ipv4).toEqual(["203.0.113.10", 4]);
  });

  it("refuses a name the network's NAT64 prefix would translate onto the local network", async () => {
    const lookup = vi.fn(async (host: string) => host === "ipv4only.arpa"
      ? [{ address: "192.0.0.170", family: 4 }, { address: "2600:1f00:64::c000:aa", family: 6 }]
      : [{ address: "2600:1f00:64::c0a8:101", family: 6 }]);
    const dial = createDirectDialer(lookup);
    await expect(dial("router.example", 80, new AbortController().signal)).rejects.toMatchObject({ reply: SOCKS_REPLY.notAllowedByRuleset, message: expect.stringContaining("NAT64-translated private") });
    expect(lookup).toHaveBeenCalledWith("ipv4only.arpa");
  });

  it("gives up a pending connect when the SOCKS deadline aborts it", async () => {
    const dial = createDirectDialer(async () => [{ address: "203.0.113.1", family: 4 }]);
    const controller = new AbortController();
    const pending = dial("blackhole.example", 443, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ reply: SOCKS_REPLY.hostUnreachable, message: "dial aborted" });
  });

  it("abandons a DNS lookup that never answers at the SOCKS deadline and closes the client as host unreachable", async () => {
    const server = createSocks5Server({ dial: createDirectDialer(() => new Promise(() => {})), dialTimeoutMs: 30 });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = net.connect((server.address() as AddressInfo).port, "127.0.0.1");
    sockets.push(client);
    await once(client, "connect");
    client.write(Buffer.from([5, 1, 0]));
    await once(client, "data");
    const closed = once(client, "close");
    client.write(Buffer.from([5, 1, 0, 3, 11, ...Buffer.from("stalled.dns"), 1, 187]));
    const [reply] = (await once(client, "data")) as [Buffer];
    expect(reply[1]).toBe(SOCKS_REPLY.hostUnreachable);
    await closed;
  });

  it("never connects when the lookup answers after the dial was aborted", async () => {
    let answer: ((records: Array<{ address: string; family: number }>) => void) | null = null;
    const connect = vi.spyOn(net, "connect");
    const dial = createDirectDialer(() => new Promise((resolve) => { answer = resolve; }));
    const controller = new AbortController();
    const pending = dial("late.example", 443, controller.signal);
    await vi.waitFor(() => expect(answer).not.toBeNull());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reply: SOCKS_REPLY.hostUnreachable, message: "dial aborted" });
    answer!([{ address: "203.0.113.1", family: 4 }]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("VM egress boot", () => {
  it("keeps the listener closed while the mode is unknown, retries the load with bounded backoff, and opens with the stored mode once a read succeeds", async () => {
    const store = memoryStore({ mode: "desktop", updatedAt: 1 });
    let failures = 2;
    const read = store.read.bind(store);
    store.read = async () => { if (failures > 0) { failures -= 1; throw new Error("broker 503"); } return read(); };
    const direct = vi.fn(async () => new PassThrough());
    const log = vi.fn();
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const service = createVmEgressService({ store, directDial: direct, tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 }, log });
    services.push(service);
    const changed = vi.fn();
    service.onChange(changed);
    const booting = service.boot({ baseDelayMs: 2_000, maxDelayMs: 60_000, schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }) });
    expect(service.status().listener).toBe("closed-pending-mode");
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ listener: "closed-pending-mode" }));
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    expect(scheduled[0]!.delayMs).toBe(2_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("egress listener still closed"), expect.objectContaining({ attempt: 1, retryInMs: 2_000, error: "broker 503" }));
    expect(service.status()).toMatchObject({ mode: "cloud", listener: "closed-pending-mode" });
    scheduled[0]!.callback();
    await vi.waitFor(() => expect(scheduled).toHaveLength(2));
    expect(scheduled[1]!.delayMs).toBe(4_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("egress listener still closed"), expect.objectContaining({ attempt: 2 }));
    scheduled[1]!.callback();
    const bound = await booting;
    expect(bound.host).toBe("127.0.0.1");
    expect(service.status()).toMatchObject({ mode: "desktop", listener: "listening" });
    await expect(service.dial("ifconfig.me", 443, new AbortController().signal)).rejects.toMatchObject({ reply: SOCKS_REPLY.generalFailure });
    expect(direct).not.toHaveBeenCalled();
  });

  it("lets an explicit mode change settle a pending boot, discarding the boot read that lands afterwards", async () => {
    const store = memoryStore({ mode: "desktop", updatedAt: 1 });
    let resolveRead: ((state: GatewayVmEgressState | null) => void) | null = null;
    store.read = () => new Promise((resolve) => { resolveRead = resolve; });
    const service = createVmEgressService({ store, directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 } });
    services.push(service);
    const booting = service.boot({ schedule: () => {} });
    await vi.waitFor(() => expect(resolveRead).not.toBeNull());
    expect(service.status().listener).toBe("closed-pending-mode");
    const changing = service.setMode("cloud");
    await vi.waitFor(() => expect(store.writes).toEqual(["cloud"]));
    resolveRead!({ mode: "desktop", updatedAt: 1 });
    expect(await changing).toMatchObject({ mode: "cloud", listener: "listening" });
    await booting;
    expect(service.status()).toMatchObject({ mode: "cloud", updatedAt: 9_000, listener: "listening" });
    expect(await service.setMode("desktop")).toMatchObject({ mode: "desktop", listener: "listening" });
    expect(store.writes).toEqual(["cloud", "desktop"]);
  });

  it("asks a desktop reconnecting during a restart's mode load to try again later, then admits it once desktop mode loads", async () => {
    const store = memoryStore({ mode: "desktop", updatedAt: 1 });
    let resolveRead: ((state: GatewayVmEgressState | null) => void) | null = null;
    store.read = () => new Promise((resolve) => { resolveRead = resolve; });
    const service = createVmEgressService({ store, directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 } });
    services.push(service);
    const booting = service.boot({ schedule: () => {} });
    await vi.waitFor(() => expect(resolveRead).not.toBeNull());
    const early = { readyState: 1, bufferedAmount: 0, send() {}, close: vi.fn(), on() { return this; } };
    service.attachShell(early);
    expect(early.close).toHaveBeenCalledWith(1013, "Desktop egress mode is still loading");
    resolveRead!({ mode: "desktop", updatedAt: 1 });
    await booting;
    const retried = { readyState: 1, bufferedAmount: 0, send() {}, close: vi.fn(), on() { return this; } };
    service.attachShell(retried);
    expect(retried.close).not.toHaveBeenCalled();
    expect(service.status().shell).toBe("connected");
  });

  it("keeps a mode change made during boot ahead of a later change even when the boot read finishes first", async () => {
    const store = memoryStore({ mode: "desktop", updatedAt: 1 });
    let resolveRead: ((state: GatewayVmEgressState | null) => void) | null = null;
    store.read = () => new Promise((resolve) => { resolveRead = resolve; });
    const write = store.write.bind(store);
    let releaseFirstWrite: (() => void) | null = null;
    store.write = (mode) => store.writes.length === 0 && !releaseFirstWrite
      ? new Promise((resolve, reject) => { releaseFirstWrite = () => { write(mode).then(resolve, reject); }; })
      : write(mode);
    const service = createVmEgressService({ store, directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 } });
    services.push(service);
    const booting = service.boot({ schedule: () => {} });
    await vi.waitFor(() => expect(resolveRead).not.toBeNull());
    const early = service.setMode("cloud");
    await vi.waitFor(() => expect(releaseFirstWrite).not.toBeNull());
    resolveRead!({ mode: "desktop", updatedAt: 1 });
    await booting;
    const later = service.setMode("desktop");
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstWrite!();
    await Promise.all([early, later]);
    expect(store.writes).toEqual(["cloud", "desktop"]);
    expect(service.status().mode).toBe("desktop");
  });

  it("never sleeps after a failed boot read when a mode change already settled the boot", async () => {
    const store = memoryStore();
    let rejectRead: ((error: Error) => void) | null = null;
    store.read = () => new Promise((_resolve, reject) => { rejectRead = reject; });
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const service = createVmEgressService({ store, directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 } });
    services.push(service);
    const booting = service.boot({ baseDelayMs: 60_000, schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }) });
    await vi.waitFor(() => expect(rejectRead).not.toBeNull());
    const changing = service.setMode("desktop");
    await vi.waitFor(() => expect(store.writes).toEqual(["desktop"]));
    rejectRead!(new Error("broker 503"));
    expect(await changing).toMatchObject({ mode: "desktop", listener: "listening" });
    await booting;
    expect(scheduled).toEqual([]);
  });

  it("recovers from a stored mode the broker keeps refusing once the user picks a mode, without waiting out the retry delay", async () => {
    const store = memoryStore();
    store.read = async () => { throw new Error("broker 409 egress_record_malformed"); };
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const service = createVmEgressService({ store, directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 } });
    services.push(service);
    const booting = service.boot({ baseDelayMs: 60_000, schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }) });
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    expect(await service.setMode("desktop")).toMatchObject({ mode: "desktop", listener: "listening" });
    await booting;
    expect(scheduled).toHaveLength(1);
    expect(store.writes).toEqual(["desktop"]);
  });

  it("applies concurrent mode changes in queue order even when the first store write is the slow one", async () => {
    const store = memoryStore();
    const settled: Array<(state: GatewayVmEgressState) => void> = [];
    store.write = (mode) => new Promise((resolve) => { settled.push((state) => { store.writes.push(mode); store.state = state; resolve(state); }); });
    const service = createVmEgressService({ store, directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost() });
    const first = service.setMode("desktop");
    const second = service.setMode("cloud");
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toHaveLength(1);
    settled[0]!({ mode: "desktop", updatedAt: 10 });
    expect((await first).mode).toBe("desktop");
    await vi.waitFor(() => expect(settled).toHaveLength(2));
    settled[1]!({ mode: "cloud", updatedAt: 11 });
    expect((await second).mode).toBe("cloud");
    expect(store.writes).toEqual(["desktop", "cloud"]);
    expect(service.status()).toMatchObject({ mode: "cloud", updatedAt: 11 });
  });

  it("keeps the previous mode and keeps serving later changes when a write fails mid-queue", async () => {
    const store = memoryStore({ mode: "desktop", updatedAt: 1 });
    let fail = true;
    let releaseNext: ((state: GatewayVmEgressState) => void) | null = null;
    store.write = (mode) => {
      if (fail) { fail = false; return Promise.reject(new Error("broker 503")); }
      return new Promise((resolve) => { releaseNext = (state) => { store.writes.push(mode); resolve(state); }; });
    };
    const service = createVmEgressService({ store, directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost() });
    await service.load();
    const failed = service.setMode("cloud");
    const next = service.setMode("cloud");
    await expect(failed).rejects.toThrow("broker 503");
    await vi.waitFor(() => expect(releaseNext).not.toBeNull());
    expect(service.status().mode).toBe("desktop");
    releaseNext!({ mode: "cloud", updatedAt: 12 });
    expect((await next).mode).toBe("cloud");
    expect(store.writes).toEqual(["cloud"]);
  });

  it("caps the retry delay at the configured maximum", async () => {
    const store = memoryStore();
    store.read = async () => { throw new Error("broker 503"); };
    const scheduled: number[] = [];
    const service = createVmEgressService({ store, directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 } });
    services.push(service);
    let fire: (() => void) | null = null;
    void service.boot({ baseDelayMs: 2_000, maxDelayMs: 9_000, schedule: (callback, delayMs) => { scheduled.push(delayMs); fire = callback; } });
    for (let i = 0; i < 4; i += 1) {
      await vi.waitFor(() => expect(scheduled).toHaveLength(i + 1));
      fire!();
    }
    await vi.waitFor(() => expect(scheduled).toHaveLength(5));
    expect(scheduled).toEqual([2_000, 4_000, 8_000, 9_000, 9_000]);
    expect(service.status().listener).toBe("closed-pending-mode");
  });
});

describe("VM egress service", () => {
  it("starts in cloud mode and dials directly, applies the stored mode on load, and persists before switching", async () => {
    const store = memoryStore();
    const direct = vi.fn(async () => new PassThrough());
    const tunnel = createEgressTunnelHost();
    const service = createVmEgressService({ store, directDial: direct, tunnel });
    expect(service.status()).toMatchObject({ mode: "cloud", shell: "disconnected", listener: "off", updatedAt: null });
    const signal = new AbortController().signal;
    await service.dial("ifconfig.me", 443, signal);
    expect(direct).toHaveBeenCalledWith("ifconfig.me", 443, signal);

    store.state = { mode: "desktop", updatedAt: 1_000 };
    await service.load();
    expect(service.status()).toMatchObject({ mode: "desktop", updatedAt: 1_000 });

    const changed = vi.fn();
    service.onChange(changed);
    await service.setMode("cloud");
    expect(store.writes).toEqual(["cloud"]);
    expect(service.status()).toMatchObject({ mode: "cloud", updatedAt: 9_000 });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ mode: "cloud" }));
  });

  it("keeps the current mode when the platform refuses to record a change", async () => {
    const store = memoryStore();
    store.write = async () => { throw new Error("broker 503"); };
    const service = createVmEgressService({ store, directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost() });
    await expect(service.setMode("desktop")).rejects.toThrow("broker 503");
    expect(service.status().mode).toBe("cloud");
  });

  it("fails closed in desktop mode until a desktop is attached, then dials through it", async () => {
    const direct = vi.fn(async () => new PassThrough());
    const tunnel = createEgressTunnelHost();
    const tunnelDial = vi.spyOn(tunnel, "dial").mockResolvedValue(new PassThrough());
    const service = createVmEgressService({ store: memoryStore(), directDial: direct, tunnel });
    await service.setMode("desktop");
    await expect(service.dial("ifconfig.me", 443, new AbortController().signal)).rejects.toMatchObject({ reply: SOCKS_REPLY.generalFailure });
    expect(direct).not.toHaveBeenCalled();
    expect(service.status().shell).toBe("disconnected");

    const changed = vi.fn();
    service.onChange(changed);
    vi.spyOn(tunnel, "connected").mockReturnValue(true);
    service.attachShell({ readyState: 1, bufferedAmount: 0, send() {}, close() {}, on() { return this; } });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ shell: "connected" }));
    const tunnelSignal = new AbortController().signal;
    await service.dial("ifconfig.me", 443, tunnelSignal);
    expect(tunnelDial).toHaveBeenCalledWith("ifconfig.me", 443, tunnelSignal);
    expect(direct).not.toHaveBeenCalled();
  });

  it("admits a desktop only while desktop mode is selected and closes it when cloud is chosen, so a stale desktop cannot reattach", async () => {
    const tunnel = createEgressTunnelHost();
    const service = createVmEgressService({ store: memoryStore(), directDial: async () => new PassThrough(), tunnel });
    const fakeShell = () => {
      const closeListeners: Array<() => void> = [];
      const close = vi.fn(() => { for (const listener of closeListeners) listener(); });
      const socket = {
        readyState: 1, bufferedAmount: 0, send() {}, close,
        on(event: string, listener: () => void) {
          if (event === "close") closeListeners.push(listener);
          return this;
        },
      } as unknown as Parameters<VmEgressService["attachShell"]>[0];
      return { socket, close };
    };

    const early = fakeShell();
    service.attachShell(early.socket);
    expect(early.close).toHaveBeenCalledWith(EGRESS_CLOSE_NOT_SELECTED, "Desktop egress is not selected");
    expect(service.status().shell).toBe("disconnected");

    await service.setMode("desktop");
    const chosen = fakeShell();
    service.attachShell(chosen.socket);
    expect(service.status().shell).toBe("connected");

    await service.setMode("cloud");
    expect(chosen.close).toHaveBeenCalledWith(EGRESS_CLOSE_NOT_SELECTED, "Cloud egress selected");
    const reconnect = fakeShell();
    service.attachShell(reconnect.socket);
    expect(reconnect.close).toHaveBeenCalledWith(EGRESS_CLOSE_NOT_SELECTED, "Desktop egress is not selected");
    expect(service.status().shell).toBe("disconnected");

    await service.setMode("desktop");
    await expect(service.dial("ifconfig.me", 443, new AbortController().signal)).rejects.toMatchObject({ reply: SOCKS_REPLY.generalFailure });
  });

  it("points the VM's browser at the loaded mode after boot and at every later change", async () => {
    const browser = { apply: vi.fn() };
    const service = createVmEgressService({ store: memoryStore({ mode: "desktop", updatedAt: 1 }), directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 }, browser });
    services.push(service);
    await service.boot({ schedule: () => {} });
    expect(browser.apply.mock.calls).toEqual([["desktop"]]);
    await service.setMode("cloud");
    await service.setMode("cloud");
    expect(browser.apply.mock.calls).toEqual([["desktop"], ["cloud"]]);
  });

  it("drops every open relay when the mode changes so Chromium re-dials through the selected route", async () => {
    const upstream = new PassThrough();
    const service = createVmEgressService({ store: memoryStore(), directDial: async () => upstream, tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 } });
    services.push(service);
    const bound = await service.start();
    const client = net.connect(bound.port, "127.0.0.1");
    sockets.push(client);
    await once(client, "connect");
    client.write(Buffer.from([5, 1, 0]));
    await once(client, "data");
    client.write(Buffer.from([5, 1, 0, 3, 11, ...Buffer.from("ifconfig.me"), 1, 187]));
    const [reply] = (await once(client, "data")) as [Buffer];
    expect(reply[1]).toBe(SOCKS_REPLY.succeeded);
    const closed = once(client, "close");
    await service.setMode("desktop");
    await closed;
    expect(upstream.destroyed).toBe(true);
  });

  it("serves SOCKS5 on the configured loopback address and answers fail-closed with a general failure", async () => {
    const service = createVmEgressService({ store: memoryStore({ mode: "desktop", updatedAt: 1 }), directDial: async () => new PassThrough(), tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 } });
    services.push(service);
    await service.load();
    const bound = await service.start();
    expect(bound.host).toBe("127.0.0.1");
    expect(service.status().listener).toBe("listening");
    expect(await service.start()).toEqual(bound);
    const client = net.connect(bound.port, "127.0.0.1");
    sockets.push(client);
    await once(client, "connect");
    client.write(Buffer.from([5, 1, 0]));
    const [greeting] = (await once(client, "data")) as [Buffer];
    expect(greeting).toEqual(Buffer.from([5, 0]));
    client.write(Buffer.from([5, 1, 0, 3, 11, ...Buffer.from("ifconfig.me"), 1, 187]));
    const [reply] = (await once(client, "data")) as [Buffer];
    expect(reply[1]).toBe(SOCKS_REPLY.generalFailure);
    await service.stop();
    expect(service.status().listener).toBe("off");
  });
});

