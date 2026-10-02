import { describe, expect, it, vi } from "vitest";
import { COMPUTER_HOME_CHECKPOINT_MAX_BYTES } from "@octogee/shared/types/glm";
import {
  DESKTOP_HOME_PATHS,
  checkpointHome,
  homeScope,
  restoreHome,
  type HomeCheckpointDeps,
  type HomeScope,
} from "../../lib/vm-gateway-agent/home-checkpoint";
import { bundleFixture } from "./fixture";

const SHA = "c".repeat(64);
const NAME = "20260905T101500Z.tar.gz";

interface FakeHome {
  deps: HomeCheckpointDeps;
  scope: HomeScope;
  shell: string[];
  fetches: Array<{ url: string; init: RequestInit }>;
  touched: Array<{ path: string; at: number }>;
  removed: string[];
  world: { dataEntries: string[]; markerExists: boolean; dirty: boolean; archiveSize: number; tarCode: number; savedSize: number };
  routes: Record<string, () => { status: number; body: unknown }>;
}

function fakeHome(overrides: Partial<FakeHome["world"]> = {}, routes: FakeHome["routes"] = {}): FakeHome {
  const world = { dataEntries: ["README.md"], markerExists: true, dirty: true, archiveSize: 2048, tarCode: 0, savedSize: 2048, ...overrides };
  const shell: string[] = [];
  const fetches: FakeHome["fetches"] = [];
  const touched: FakeHome["touched"] = [];
  const removed: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    fetches.push({ url: String(url), init: init ?? {} });
    const key = String(url).replace(/^https?:\/\/[^/]+/, "");
    const route = routes[key];
    if (!route) return new Response("", { status: 200 });
    const r = route();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const deps: HomeCheckpointDeps = {
    gatewayId: "b-x",
    apiUrl: "http://10.128.9.9:3001",
    metadata: { identityToken: async (aud) => `id-${aud}` },
    fetchImpl,
    stateRoot: "/srv/octogee",
    desktop: { run: vi.fn(async () => {}) },
    snapshot: async (work) => work(),
    captureSnapshot: async () => {},
    discardSnapshot: async () => {},
    shell: {
      run: async (command, args) => {
        shell.push(`${command} ${args.join(" ")}`);
        if (command === "sync") return { code: 0, stdout: "", stderr: "" };
        if (command === "find") return { code: 0, stdout: world.dirty ? "/srv/octogee/volumes/data/x\n" : "", stderr: "" };
        return { code: world.tarCode, stdout: "", stderr: world.tarCode > 1 ? "tar: boom" : "" };
      },
    },
    fs: {
      listDir: async () => world.dataEntries,
      exists: async (path) => path.endsWith("/data") || (path.endsWith("home-checkpoint.marker") && world.markerExists),
      mkdir: async () => {},
      replaceDirectory: async () => {},
      fileSize: async (path) => (path.includes("home-restore") ? world.savedSize : world.archiveSize),
      sha256: async () => SHA,
      mkdtemp: async (prefix) => `/tmp/${prefix}xyz`,
      rm: async (path) => { removed.push(path); },
      touch: async (path, at) => { touched.push({ path, at }); },
      uploadBody: async (path) => `body:${path}`,
      saveResponse: async () => {},
    },
    now: () => 1_700_000_000_000,
    log: vi.fn(),
  };
  const scope = homeScope("/srv/octogee", bundleFixture({
    containers: bundleFixture().containers.map((c) => ({ ...c, env: { ...c.env, GATEWAY_BUILDER_SLUG: "bob" } })),
  }))!;
  return { deps, scope, shell, fetches, touched, removed, world, routes };
}

const signedUpload = { url: "https://storage.example/customers/bob/computer-home/checkpoints/x", method: "PUT" as const, gcsPath: "p", expiresAt: "e", requiredHeaders: { "x-goog-if-generation-match": "0" } };

describe("homeScope", () => {
  it("derives the home volume and builder slug from the bundle and is absent when either is missing", () => {
    const scope = homeScope("/srv/octogee", bundleFixture({ containers: bundleFixture().containers.map((c) => ({ ...c, env: { ...c.env, GATEWAY_BUILDER_SLUG: "bob" } })) }));
    expect(scope).toEqual({ slug: "bob", dataDir: "/srv/octogee/volumes/data", marker: "/srv/octogee/home-checkpoint.marker", desktopDir: "/srv/octogee/desktop-home", restorePending: "/srv/octogee/home-restore.pending" });
    expect(homeScope("/srv/octogee", bundleFixture())).toBeNull();
    expect(homeScope("/srv/octogee", bundleFixture({ volumes: [{ name: "data", kind: "identityToken", audience: "x" }] }))).toBeNull();
  });
});

describe("checkpointHome", () => {
  it("preserves the archive error when snapshot cleanup also fails", async () => {
    const h = fakeHome({ tarCode: 2 });
    let cleanups = 0;
    h.deps.discardSnapshot = async () => { if (++cleanups === 2) throw new Error("snapshot deletion failed"); };
    await expect(checkpointHome(h.deps, h.scope, { force: true })).rejects.toThrow(/tar --create exited 2.*snapshot deletion failed/);
    expect(h.removed).toEqual(["/tmp/octogee-home-checkpoint-xyz"]);
  });

  it("thaws writers before compression and archives only the captured filesystem snapshot", async () => {
    const h = fakeHome({}, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: signedUpload } }),
      "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME, size: 2048, sha256: SHA } }),
      "/internal/fleet/computer-home/prune": () => ({ status: 200, body: { deleted: 0 } }),
    });
    let frozen = false;
    const events: string[] = [];
    h.deps.snapshot = async (work) => { frozen = true; try { await work(); } finally { frozen = false; events.push("thaw"); } };
    h.deps.captureSnapshot = async () => { expect(frozen).toBe(true); events.push("snapshot-home"); };
    h.deps.discardSnapshot = async () => { events.push("discard-home-snapshot"); };
    const run = h.deps.shell.run;
    h.deps.shell.run = async (command, args) => {
      if (command === "tar") {
        expect(frozen).toBe(false);
        expect(args).toContain("/srv/octogee/.home-checkpoint/snapshot/volumes/data/..");
        events.push("compress");
      }
      return run(command, args);
    };
    await checkpointHome(h.deps, h.scope, { force: true });
    expect(events).toEqual(["discard-home-snapshot", "snapshot-home", "thaw", "compress", "discard-home-snapshot"]);
  });

  it("is a no-op when nothing changed since the marker", async () => {
    const h = fakeHome({ dirty: false });
    expect(await checkpointHome(h.deps, h.scope, { force: false })).toEqual({ status: "clean" });
    expect(h.shell).toEqual([
      "find /srv/octogee/volumes/data ( -name node_modules -o -name .npm -o -name .npm-cache -o -name .cache -o -name .pnpm-store -o -name Trash -o -name Cache -o -name Code Cache -o -name GPUCache -o -name DawnCache -o -name GrShaderCache -o -name ShaderCache -o -name CacheStorage -o -name SingletonLock -o -name SingletonCookie -o -name SingletonSocket -o -name DevToolsActivePort ) -prune -o -newer /srv/octogee/home-checkpoint.marker -print -quit",
    ]);
    expect(h.fetches).toEqual([]);
  });

  it("carries the desktop's Octogee config (the Desk note) in the checkpoint alongside the browser profile and Omarchy config", async () => {
    expect(DESKTOP_HOME_PATHS).toEqual([".config/octogee-chromium", ".config/hypr", ".config/omarchy", ".config/octogee", "Documents"]);
    const h = fakeHome({}, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: signedUpload } }),
      "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME, size: 2048, sha256: SHA, completedAt: 5 } }),
      "/internal/fleet/computer-home/prune": () => ({ status: 200, body: { deleted: 0 } }),
    });
    const present = new Set(["/srv/octogee/.home-checkpoint/snapshot/desktop-home/.config/octogee", "/srv/octogee/.home-checkpoint/snapshot/desktop-home/Documents"]);
    const baseExists = h.deps.fs.exists;
    h.deps.fs.exists = async (path) => present.has(path) || baseExists(path);
    await checkpointHome(h.deps, h.scope, { force: true });
    const tar = h.shell.find((line) => line.startsWith("tar "))!;
    expect(tar).toContain("-C /srv/octogee/.home-checkpoint/snapshot/desktop-home/.. desktop-home/.config/octogee desktop-home/Documents");
    expect(tar).not.toContain("desktop-home/.config/hypr");
  });

  it("archives the home without caches, uploads to the signed create-only URL, commits, marks the start time, and prunes", async () => {
    const h = fakeHome({}, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: signedUpload } }),
      "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME, size: 2048, sha256: SHA, completedAt: 5 } }),
      "/internal/fleet/computer-home/prune": () => ({ status: 200, body: { deleted: 2 } }),
    });
    const result = await checkpointHome(h.deps, h.scope, { force: false });
    expect(result).toEqual({ status: "uploaded", name: NAME, size: 2048, pruned: 2 });
    const tar = h.shell.find((line) => line.startsWith("tar "))!;
    expect(tar).toContain("--create --gzip --numeric-owner");
    expect(tar).toContain("--file=/tmp/octogee-home-checkpoint-xyz/home.tar.gz");
    expect(tar).toContain("-C /srv/octogee/.home-checkpoint/snapshot/volumes/data/.. data");
    expect(tar).toContain("--exclude=node_modules");
    expect(tar).toContain("--exclude=Code Cache");
    expect(tar).not.toContain("--ignore-failed-read");

    const [url, upload, commit, prune] = h.fetches;
    expect(url.url).toBe("http://10.128.9.9:3001/internal/fleet/computer-home/checkpoint-url");
    expect(JSON.parse(String(url.init.body))).toEqual({ gatewayId: "b-x", slug: "bob", size: 2048 });
    expect(url.init.headers).toMatchObject({ "x-k8s-sa-token": "id-octogee-api", "x-octogee-gateway-credential-token": "id-octogee-api-gateway-credentials" });
    expect(upload).toMatchObject({ url: signedUpload.url, init: { method: "PUT", body: "body:/tmp/octogee-home-checkpoint-xyz/home.tar.gz" } });
    expect(upload.init.headers).toEqual({ "content-type": "application/gzip", "x-goog-if-generation-match": "0" });
    expect(JSON.parse(String(commit.init.body))).toEqual({ gatewayId: "b-x", slug: "bob", name: NAME, size: 2048, sha256: SHA, requestedAt: null });
    expect(JSON.parse(String(prune.init.body))).toEqual({ gatewayId: "b-x", slug: "bob" });
    expect(h.touched).toEqual([{ path: "/srv/octogee/home-checkpoint.marker", at: 1_700_000_000_000 }]);
    expect(h.removed).toEqual(["/tmp/octogee-home-checkpoint-xyz"]);
  });

  it("force skips the dirty check and a prune failure does not fail the checkpoint", async () => {
    const h = fakeHome({ dirty: false }, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: signedUpload } }),
      "/internal/fleet/computer-home/commit": () => ({ status: 200, body: { name: NAME, size: 2048, sha256: SHA, completedAt: 5 } }),
      "/internal/fleet/computer-home/prune": () => ({ status: 502, body: { error: "boom" } }),
    });
    expect(await checkpointHome(h.deps, h.scope, { force: true })).toEqual({ status: "uploaded", name: NAME, size: 2048, pruned: null });
    expect(h.shell.some((line) => line.startsWith("find "))).toBe(false);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("prune failed"));
  });

  it("refuses an oversized or empty archive and surfaces tar, upload, and commit failures, always cleaning up", async () => {
    const big = fakeHome({ archiveSize: COMPUTER_HOME_CHECKPOINT_MAX_BYTES + 1 });
    await expect(checkpointHome(big.deps, big.scope, { force: true })).rejects.toThrow(/over the .* byte cap/);
    expect(big.fetches).toEqual([]);
    expect(big.removed).toEqual(["/tmp/octogee-home-checkpoint-xyz"]);

    const empty = fakeHome({ archiveSize: 0 });
    await expect(checkpointHome(empty.deps, empty.scope, { force: true })).rejects.toThrow(/archive is empty/);

    const tarFailed = fakeHome({ tarCode: 2 });
    await expect(checkpointHome(tarFailed.deps, tarFailed.scope, { force: true })).rejects.toThrow(/tar --create exited 2: tar: boom/);

    const denied = fakeHome({}, { "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 403, body: { error: "forbidden" } }) });
    await expect(checkpointHome(denied.deps, denied.scope, { force: true })).rejects.toThrow(/checkpoint-url: HTTP 403/);

    const uploadFailed = fakeHome({}, {
      "/internal/fleet/computer-home/checkpoint-url": () => ({ status: 200, body: { name: NAME, upload: { ...signedUpload, url: "https://storage.example/fail" } } }),
      "/fail": () => ({ status: 412, body: {} }),
    });
    await expect(checkpointHome(uploadFailed.deps, uploadFailed.scope, { force: true })).rejects.toThrow(/upload: HTTP 412/);
    expect(uploadFailed.touched).toEqual([]);
  });
});

describe("restoreHome", () => {
  const record = { name: NAME, size: 2048, sha256: SHA, completedAt: 5, download: { url: "https://storage.example/download", method: "GET", gcsPath: "p", expiresAt: "e" } };

  it("never touches a non-empty home", async () => {
    const h = fakeHome();
    expect(await restoreHome(h.deps, h.scope)).toEqual({ status: "preserved" });
    expect(h.fetches).toEqual([]);
    expect(h.shell).toEqual([]);
  });

  it("reports no checkpoint for a fresh customer", async () => {
    const h = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 404, body: { error: "no_checkpoint" } }) });
    expect(await restoreHome(h.deps, h.scope)).toEqual({ status: "none" });
    expect(h.shell).toEqual([]);
  });

  it("downloads the current checkpoint, verifies size and digest, extracts it into the empty home, and marks it clean", async () => {
    const h = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: record }) });
    expect(await restoreHome(h.deps, h.scope)).toEqual({ status: "restored", name: NAME, size: 2048 });
    expect(h.fetches[1]).toMatchObject({ url: "https://storage.example/download", init: { method: "GET" } });
    expect(h.shell).toEqual([
      "tar --extract --gzip --numeric-owner --same-owner --same-permissions --file=/tmp/octogee-home-restore-xyz/home.tar.gz --directory=/tmp/octogee-home-restore-xyz/staged",
    ]);
    expect(h.touched).toEqual([{ path: "/srv/octogee/home-restore.pending", at: 1_700_000_000_000 }, { path: "/srv/octogee/home-checkpoint.marker", at: 1_700_000_000_000 }]);
    expect(h.removed).toEqual(["/srv/octogee/home-restore.pending", "/tmp/octogee-home-restore-xyz"]);
  });

  it("refuses a checkpoint whose bytes do not match the committed record and leaves the home untouched", async () => {
    const h = fakeHome({ dataEntries: [], savedSize: 2047 }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: record }) });
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow(/downloaded 2047 bytes, expected 2048/);
    const digest = fakeHome({ dataEntries: [] }, { "/internal/fleet/computer-home/download-url": () => ({ status: 200, body: { ...record, sha256: "d".repeat(64) } }) });
    await expect(restoreHome(digest.deps, digest.scope)).rejects.toThrow(/sha256 mismatch/);
    expect(h.shell).toEqual([]);
    expect(digest.shell).toEqual([]);
    expect(h.removed).toEqual(["/tmp/octogee-home-restore-xyz"]);
  });
});
