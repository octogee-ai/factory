import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointHome, homeIsDirty, homeScope, restoreHome, type HomeCheckpointDeps } from "../../lib/vm-gateway-agent/home-checkpoint";
import { createHomeFs, homeShell } from "../../lib/vm-gateway-agent/home-fs";
import { bundleFixture } from "./fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "octogee-home-native-"));
  roots.push(root);
  const scope = homeScope(root, bundleFixture({ containers: bundleFixture().containers.map((container) => ({ ...container, env: { ...container.env, GATEWAY_BUILDER_SLUG: "bob" } })) }))!;
  await mkdir(scope.dataDir, { recursive: true });
  await mkdir(`${scope.desktopDir}/.config/octogee-chromium/Default/Cache`, { recursive: true });
  await mkdir(`${scope.desktopDir}/Documents`, { recursive: true });
  await mkdir(`${root}/tokens`, { recursive: true });
  await writeFile(`${scope.dataDir}/gateway.txt`, "gateway state");
  await writeFile(`${scope.desktopDir}/.config/octogee-chromium/Default/Preferences`, "browser profile");
  await symlink("replaced-computer-1234", `${scope.desktopDir}/.config/octogee-chromium/SingletonLock`);
  await symlink("/tmp/old-chromium/socket", `${scope.desktopDir}/.config/octogee-chromium/SingletonSocket`);
  await writeFile(`${scope.desktopDir}/.config/octogee-chromium/DevToolsActivePort`, "9222");
  await writeFile(`${scope.desktopDir}/.config/octogee-chromium/Default/Cache/disposable`, "cache");
  await writeFile(`${scope.desktopDir}/Documents/project.txt`, "Builder document");
  await writeFile(`${root}/tokens/secret`, "not part of home");
  let uploaded = new Uint8Array();
  let current: Record<string, unknown> | null = null;
  const events: string[] = [];
  const deps: HomeCheckpointDeps = {
    gatewayId: "b-x", apiUrl: "https://api.invalid", stateRoot: root,
    metadata: { identityToken: async () => "local-test-token" },
    fs: createHomeFs(root), shell: homeShell, now: Date.now, log: vi.fn(),
    desktop: { run: async (action) => { events.push(action); } },
    snapshot: async (work) => { events.push("freeze"); try { await work(); } finally { events.push("thaw"); } },
    fetchImpl: vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/checkpoint-url")) return Response.json({ name: "20260905T101500Z.tar.gz", upload: { url: "https://storage.invalid/upload", method: "PUT" } });
      if (url.endsWith("/upload")) {
        uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
        return new Response("");
      }
      if (url.endsWith("/commit")) { current = JSON.parse(String(init?.body)); return Response.json(current); }
      if (url.endsWith("/prune")) return Response.json({ deleted: 0 });
      if (url.endsWith("/download-url")) return current
        ? Response.json({ ...current, download: { url: "https://storage.invalid/download", method: "GET" } })
        : new Response("", { status: 404 });
      if (url.endsWith("/download")) return new Response(uploaded);
      throw new Error(`unexpected local fixture URL ${url}`);
    }) as typeof fetch,
  };
  const emptyGateway = async () => { await rm(scope.dataDir, { recursive: true }); await mkdir(scope.dataDir); };
  return { root, scope, deps, events, emptyGateway };
}

describe("native home archive and recovery", () => {
  it("detects deletion of an entire desktop persistence directory", async () => {
    const h = await fixture();
    await h.deps.fs.touch(h.scope.marker, Date.now() - 10_000);
    const { utimes } = await import("node:fs/promises");
    const old = new Date(Date.now() - 20_000);
    await h.deps.shell.run("find", [h.root, "-exec", "touch", "-h", "-t", "202001010000", "{}", "+"]);
    await h.deps.fs.touch(h.scope.marker, Date.now() - 10_000);
    await utimes(h.scope.desktopDir, old, old);
    expect(await homeIsDirty(h.deps, h.scope)).toBe(false);
    await rm(`${h.scope.desktopDir}/Documents`, { recursive: true });
    expect(await homeIsDirty(h.deps, h.scope)).toBe(true);
  });

  it("restores the desktop profile, Documents, and gateway home while excluding caches and tokens", async () => {
    const h = await fixture();
    await checkpointHome(h.deps, h.scope, { force: true });
    await h.emptyGateway();
    await rm(h.scope.desktopDir, { recursive: true });
    await mkdir(h.scope.desktopDir);
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
    expect(await readFile(`${h.scope.dataDir}/gateway.txt`, "utf8")).toBe("gateway state");
    expect(await readFile(`${h.scope.desktopDir}/.config/octogee-chromium/Default/Preferences`, "utf8")).toBe("browser profile");
    expect(await readFile(`${h.scope.desktopDir}/Documents/project.txt`, "utf8")).toBe("Builder document");
    expect(await h.deps.fs.exists(`${h.scope.desktopDir}/.config/octogee-chromium/Default/Cache/disposable`)).toBe(false);
    expect(await h.deps.fs.exists(`${h.scope.dataDir}/tokens`)).toBe(false);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(`${h.scope.desktopDir}/.config/octogee-chromium`)).toEqual(["Default"]);
    expect(h.events).toEqual(["freeze", "thaw", "stop", "start"]);
  });

  it("retries extraction failures without treating partially extracted staging files as a live home", async () => {
    const h = await fixture();
    await checkpointHome(h.deps, h.scope, { force: true });
    await h.emptyGateway();
    const shell = h.deps.shell;
    h.deps.shell = { run: async (command, args) => { await shell.run(command, args); return { code: 2, stdout: "", stderr: "injected disk exhaustion" }; } };
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow("injected disk exhaustion");
    expect(await h.deps.fs.listDir(h.scope.dataDir)).toEqual([]);
    expect(h.events).toEqual(["freeze", "thaw"]);
    h.deps.shell = shell;
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
  });

  it("keeps the desktop closed and resumes an interrupted installation even after the gateway directory becomes nonempty", async () => {
    const h = await fixture();
    await checkpointHome(h.deps, h.scope, { force: true });
    await h.emptyGateway();
    const replace = h.deps.fs.replaceDirectory;
    h.deps.fs.replaceDirectory = async (source, target) => {
      if (target !== h.scope.dataDir) throw new Error("injected installation interruption");
      await replace(source, target);
    };
    await expect(restoreHome(h.deps, h.scope)).rejects.toThrow("installation interruption");
    expect(await h.deps.fs.listDir(h.scope.dataDir)).toEqual(["gateway.txt"]);
    expect(await h.deps.fs.exists(h.scope.restorePending)).toBe(true);
    expect(h.events).not.toContain("start");
    h.deps.fs.replaceDirectory = replace;
    expect(await restoreHome(h.deps, h.scope)).toMatchObject({ status: "restored" });
    expect(await h.deps.fs.exists(h.scope.restorePending)).toBe(false);
    expect(h.events.at(-1)).toBe("start");
  });

  it("does not upload an incomplete archive, and releases the snapshot protection on failure", async () => {
    const h = await fixture();
    h.deps.shell = { run: async () => ({ code: 1, stdout: "", stderr: "file changed as we read it" }) };
    await expect(checkpointHome(h.deps, h.scope, { force: true })).rejects.toThrow("exited 1");
    expect(h.deps.fetchImpl).not.toHaveBeenCalled();
    expect(h.events).toEqual(["freeze", "thaw"]);
  });
});
