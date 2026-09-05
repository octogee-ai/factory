import { describe, expect, it, vi } from "vitest";
import {
  TOKEN_REFRESH_MS,
  convergeOnce,
  initialAgentState,
  type VmAgentDeps,
} from "../../lib/vm-gateway-agent/agent";
import type { DockerEngine } from "../../lib/vm-gateway-agent/docker-engine";
import { HOME_CHECKPOINT_INTERVAL_MS } from "../../lib/vm-gateway-agent/home-checkpoint";
import { bundleFixture } from "./fixture";

const SHA = "c".repeat(64);
const CHECKPOINT = { name: "20260905T101500Z.tar.gz", size: 2048, sha256: SHA, completedAt: 5, download: { url: "https://storage.example/download", method: "GET", gcsPath: "p", expiresAt: "e" } };

interface FakeDocker {
  engine: DockerEngine;
  containers: Map<string, { config: Record<string, unknown>; running: boolean; paused?: boolean }>;
  log: string[];
}

function fakeDocker(log: string[] = []): FakeDocker {
  const containers = new Map<string, { config: Record<string, unknown>; running: boolean; paused?: boolean }>();
  const name = (path: string) => decodeURIComponent(path.split("/")[2].split("?")[0]);
  const engine: DockerEngine = {
    async request(method, path, body) {
      log.push(`${method} ${path.split("?")[0]}`);
      if (path.startsWith("/images/create")) return { status: 200, body: '{"status":"ok"}' as never };
      if (method === "GET" && path.endsWith("/json")) {
        const c = containers.get(name(path));
        return c
          ? { status: 200, body: { Id: name(path), State: { Running: c.running, Paused: c.paused ?? false }, Config: { Labels: (c.config.Labels as Record<string, string>) } } as never }
          : { status: 404, body: { message: "no such container" } as never };
      }
      if (method === "DELETE") { containers.delete(name(path)); return { status: 204, body: "" as never }; }
      if (path.startsWith("/containers/create")) {
        const n = new URL(`http://x${path}`).searchParams.get("name")!;
        containers.set(n, { config: body as Record<string, unknown>, running: false });
        return { status: 201, body: { Id: n } as never };
      }
      if (path.endsWith("/pause") || path.endsWith("/unpause")) { containers.get(name(path))!.paused = path.endsWith("/pause"); return { status: 204, body: "" as never }; }
      if (path.endsWith("/start")) { containers.get(name(path))!.running = true; return { status: 204, body: "" as never }; }
      if (path.endsWith("/wait")) { containers.get(name(path))!.running = false; return { status: 200, body: { StatusCode: 0 } as never }; }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { engine, containers, log };
}

type Reply = { status: number; body: unknown };

function deps(
  docker: FakeDocker,
  bundleResponse: () => Reply,
  clock: { now: number },
  opts: { routes?: Record<string, () => Reply>; home?: { entries?: string[]; dirty?: boolean } } = {},
) {
  const files = new Map<string, { content: string; mode: number }>();
  const dirs = new Set<string>();
  const chowns: string[] = [];
  const home = { entries: opts.home?.entries ?? ["README.md"], dirty: opts.home?.dirty ?? false };
  const routes: Record<string, () => Reply> = {
    "/internal/fleet/computer-home/download-url": () => ({ status: 404, body: { error: "no_checkpoint" } }),
    "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: CHECKPOINT.name, upload: { url: "https://storage.example/upload", method: "PUT", gcsPath: "p", expiresAt: "e" } } }),
    "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: CHECKPOINT.name, size: 2048, sha256: SHA, completedAt: clock.now } }),
    "/internal/fleet/computer-home/prune": () => ({ status: 200, body: { deleted: 0 } }),
    ...opts.routes,
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/internal/fleet/vm-runtime")) {
      const r = bundleResponse();
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }
    const route = routes[path];
    if (!route) return new Response("", { status: 200 });
    const r = route();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const d: VmAgentDeps = {
    gatewayId: "b-x",
    apiUrl: "http://10.128.9.9:3001",
    stateRoot: "/srv/octogee",
    engine: docker.engine,
    metadata: {
      identityToken: async (aud) => `id-${aud}`,
      accessToken: async () => "access-1",
      instanceIdentity: async () => ({ instanceId: "4242", instanceName: "octogee-gw-b-x", zone: "us-central1-a" }),
      attribute: async () => null,
    },
    fetchImpl,
    fs: {
      mkdir: async (p) => { dirs.add(p); },
      writeFile: async (p, content, mode) => { files.set(p, { content, mode }); },
      chown: async (p) => { chowns.push(p); },
    },
    home: {
      desktop: { run: vi.fn(async () => {}) },
      shell: {
        run: async (command, args) => {
          docker.log.push(`${command} ${args[0]}`);
          if (command === "find") return { code: 0, stdout: home.dirty ? "changed\n" : "", stderr: "" };
          if (args[0] === "--extract") home.entries = ["restored"];
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      fs: {
        listDir: async () => home.entries,
        exists: async (path) => !path.endsWith("home-restore.pending"),
        mkdir: async () => {},
        replaceDirectory: async () => {},
        fileSize: async () => 2048,
        sha256: async () => SHA,
        mkdtemp: async (prefix) => `/tmp/${prefix}1`,
        rm: async () => {},
        touch: async () => { home.dirty = false; },
        uploadBody: async () => "bytes",
        saveResponse: async () => {},
      },
    },
    now: () => clock.now,
    log: vi.fn(),
  };
  return { d, files, dirs, chowns, fetchImpl, home };
}

const homeBundle = (overrides: Parameters<typeof bundleFixture>[0] = {}) => bundleFixture({
  containers: bundleFixture().containers.map((c) => ({ ...c, env: { ...c.env, GATEWAY_BUILDER_SLUG: "bob" } })),
  ...overrides,
});

const runtimeReply = (bundle: ReturnType<typeof bundleFixture>, homeCheckpoint = { requestedAt: null as number | null, completedAt: null as number | null }): Reply =>
  ({ status: 200, body: { bundle, homeCheckpoint } });

const calls = (fetchImpl: typeof fetch, suffix: string) =>
  (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.filter(([url]) => String(url).endsWith(suffix));

describe("convergeOnce", () => {
  it("waits while the bundle is unrendered, then writes tokens, prepares volumes, runs init, and starts the services", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let rendered = false;
    const h = deps(docker, () => (rendered ? runtimeReply(bundleFixture()) : { status: 404, body: { error: "vm_runtime_not_rendered" } }), clock);

    let state = await convergeOnce(h.d, initialAgentState());
    expect(state).toEqual(initialAgentState());
    expect(docker.containers.size).toBe(0);
    const [, init] = (h.fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(init.headers).toMatchObject({ "x-k8s-sa-token": "id-octogee-api", "x-octogee-gateway-credential-token": "id-octogee-api-gateway-credentials" });

    rendered = true;
    state = await convergeOnce(h.d, state);

    expect(state).toEqual({ tokensWrittenAt: 1_000, appliedVersion: "v1", homeCheckpointCheckedAt: null });
    expect(h.files.get("/srv/octogee/tokens/gateway-broker-sa-token/token")).toEqual({ content: "id-octogee-api", mode: 0o644 });
    expect(h.files.get("/srv/octogee/tokens/k8s-api-token/token")?.content).toBe("access-1");
    expect(h.files.get("/srv/octogee/tokens/k8s-api-token/ca.crt")?.content).toBe("CA-PEM");
    expect(h.chowns).toEqual(["/srv/octogee/volumes/data", "/srv/octogee/volumes/secret-resolver", "/srv/octogee/desktop-home/Documents"]);
    expect(h.dirs.has("/srv/octogee/desktop-home/Documents")).toBe(true);
    expect([...docker.containers.keys()]).toEqual(["octogee-gateway", "octogee-gateway-edge"]);
    expect(docker.containers.get("octogee-gateway")?.running).toBe(true);
    expect(docker.log.filter((l) => l.startsWith("POST /images/create"))).toHaveLength(2);
    const initIndex = docker.log.findIndex((l) => l === "POST /containers/octogee-fix-perms/wait");
    const gatewayStart = docker.log.findIndex((l) => l === "POST /containers/octogee-gateway/start");
    expect(initIndex).toBeGreaterThan(-1);
    expect(gatewayStart).toBeGreaterThan(initIndex);
  });

  it("is a no-op while the running containers carry the bundle version, and replaces them on a new version", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let bundle = bundleFixture();
    const h = deps(docker, () => runtimeReply(bundle), clock);

    let state = await convergeOnce(h.d, initialAgentState());
    const creates = () => docker.log.filter((l) => l.startsWith("POST /containers/create")).length;
    const afterFirst = creates();

    state = await convergeOnce(h.d, state);
    expect(creates()).toBe(afterFirst);
    expect(state.appliedVersion).toBe("v1");

    bundle = bundleFixture({ version: "v2" });
    state = await convergeOnce(h.d, state);
    expect(creates()).toBe(afterFirst + 3);
    expect(state.appliedVersion).toBe("v2");
    expect((docker.containers.get("octogee-gateway")?.config.Labels as Record<string, string>)["ai.octogee.bundle-version"]).toBe("v2");
  });

  it("refreshes token files on the refresh interval and restarts a container that died", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    const h = deps(docker, () => runtimeReply(bundleFixture()), clock);
    let state = await convergeOnce(h.d, initialAgentState());
    h.files.clear();

    clock.now = 1_000 + TOKEN_REFRESH_MS - 1;
    state = await convergeOnce(h.d, state);
    expect(h.files.size).toBe(0);

    clock.now = 1_000 + TOKEN_REFRESH_MS;
    state = await convergeOnce(h.d, state);
    expect(h.files.size).toBe(3);
    expect(state.tokensWrittenAt).toBe(clock.now);

    docker.containers.get("octogee-gateway-edge")!.running = false;
    const before = docker.log.length;
    await convergeOnce(h.d, state);
    expect(docker.log.slice(before)).toContain("POST /containers/octogee-gateway-edge/start");
  });

  it("rejects a bundle for another gateway and surfaces API failures", async () => {
    const docker = fakeDocker();
    const other = deps(docker, () => runtimeReply(bundleFixture({ gatewayId: "b-y" })), { now: 1 });
    await expect(convergeOnce(other.d, initialAgentState())).rejects.toThrow(/not this gateway/);
    const denied = deps(docker, () => ({ status: 403, body: { error: "forbidden" } }), { now: 1 });
    await expect(convergeOnce(denied.d, initialAgentState())).rejects.toThrow(/HTTP 403/);
  });

  it("restores the current home checkpoint into an empty home before the init container runs, and never into a populated one", async () => {
    const docker = fakeDocker();
    const fresh = deps(docker, () => runtimeReply(homeBundle()), { now: 1_000 }, {
      home: { entries: [] },
      routes: { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: CHECKPOINT }) },
    });
    await convergeOnce(fresh.d, initialAgentState());
    const extract = docker.log.indexOf("tar --extract");
    const init = docker.log.indexOf("POST /containers/create");
    expect(extract).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(extract);
    expect(calls(fresh.fetchImpl, "/download")).toHaveLength(1);
    expect(fresh.d.log).toHaveBeenCalledWith(expect.stringContaining("home restore restored 20260905T101500Z.tar.gz"));

    const populated = deps(fakeDocker(), () => runtimeReply(homeBundle({ version: "v2" })), { now: 1_000 }, {
      routes: { "/internal/fleet/computer-home/download-url": () => { throw new Error("must not ask for a checkpoint"); } },
    });
    await convergeOnce(populated.d, initialAgentState());
    expect(calls(populated.fetchImpl, "/computer-home/download-url")).toHaveLength(0);

    const bare = deps(fakeDocker(), () => runtimeReply(bundleFixture()), { now: 1_000 }, { home: { entries: [] } });
    await convergeOnce(bare.d, initialAgentState());
    expect(calls(bare.fetchImpl, "/computer-home/download-url")).toHaveLength(0);
  });

  it("checkpoints a dirty home once the containers are steady, waits out the interval, and checkpoints immediately when Cowboy asks", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let signal = { requestedAt: null as number | null, completedAt: null as number | null };
    const h = deps(docker, () => runtimeReply(homeBundle(), signal), clock, { home: { dirty: true } });
    const uploads = () => calls(h.fetchImpl, "/upload").length;

    let state = await convergeOnce(h.d, initialAgentState());
    expect(uploads()).toBe(0);
    expect(state.homeCheckpointCheckedAt).toBeNull();

    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(1);
    expect(state.homeCheckpointCheckedAt).toBe(1_000);
    expect(calls(h.fetchImpl, "/computer-home/commit")).toHaveLength(1);
    expect(calls(h.fetchImpl, "/computer-home/prune")).toHaveLength(1);

    h.home.dirty = true;
    clock.now = 1_000 + HOME_CHECKPOINT_INTERVAL_MS - 1;
    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(1);

    clock.now = 1_000 + HOME_CHECKPOINT_INTERVAL_MS;
    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(2);
    expect(state.homeCheckpointCheckedAt).toBe(clock.now);

    clock.now += 1_000;
    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(2);

    signal = { requestedAt: clock.now, completedAt: clock.now - 1 };
    clock.now += 1_000;
    state = await convergeOnce(h.d, state);
    expect(uploads()).toBe(3);
    expect(docker.log.filter((l) => l === "find /srv/octogee/volumes/data")).toHaveLength(2);

    signal = { requestedAt: signal.requestedAt, completedAt: clock.now };
    clock.now += 1_000;
    await convergeOnce(h.d, state);
    expect(uploads()).toBe(3);
  });

  it("holds final-checkpoint writers through upload and controller handoff, releasing them when replacement is cancelled", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let signal = { requestedAt: null as number | null, completedAt: null as number | null };
    const h = deps(docker, () => runtimeReply(homeBundle(), signal), clock);
    let state = await convergeOnce(h.d, initialAgentState());
    signal = { requestedAt: 1_000, completedAt: null };
    const original = h.d.fetchImpl;
    h.d.fetchImpl = async (input, init) => {
      if (String(input).endsWith("/upload")) expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
      return original(input, init);
    };
    state = await convergeOnce(h.d, state);
    expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
    expect(JSON.parse(String(calls(h.fetchImpl, "/computer-home/commit")[0][1].body))).toMatchObject({ requestedAt: 1_000 });
    signal = { requestedAt: 1_000, completedAt: 1_000 };
    await convergeOnce(h.d, initialAgentState());
    expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
    signal = { requestedAt: null, completedAt: 1_000 };
    await convergeOnce(h.d, state);
    expect([...docker.containers.values()].some((c) => c.paused)).toBe(false);
  });

  it("holds final-checkpoint writers after a lost commit reply until the controller clears the request", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    let requestedAt: number | null = 1_000;
    const h = deps(docker, () => runtimeReply(homeBundle(), { requestedAt, completedAt: null }), clock,
      { routes: { "/internal/fleet/computer-home/commit": () => ({ status: 500, body: { error: "reply lost after commit" } }) } });
    const state = await convergeOnce(h.d, initialAgentState());
    const next = await convergeOnce(h.d, state);
    expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
    expect(h.d.log).toHaveBeenCalledWith(expect.stringContaining("home checkpoint failed"));
    await convergeOnce(h.d, next);
    expect([...docker.containers.values()].every((c) => c.paused)).toBe(true);
    requestedAt = null;
    await convergeOnce(h.d, next);
    expect([...docker.containers.values()].some((c) => c.paused)).toBe(false);
    expect(h.d.home.desktop.run).toHaveBeenLastCalledWith("thaw");
  });

  it("logs a failed periodic checkpoint and keeps converging instead of throwing", async () => {
    const docker = fakeDocker();
    const clock = { now: 1_000 };
    const h = deps(docker, () => runtimeReply(homeBundle()), clock, {
      home: { dirty: true },
      routes: { "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 502, body: { error: "signing failed" } }) },
    });
    let state = await convergeOnce(h.d, initialAgentState());
    state = await convergeOnce(h.d, state);
    expect(state.homeCheckpointCheckedAt).toBe(1_000);
    expect(h.d.log).toHaveBeenCalledWith(expect.stringContaining("home checkpoint failed: computer-home checkpoint-url: HTTP 502"));
  });
});
