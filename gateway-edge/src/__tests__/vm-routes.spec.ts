import { describe, expect, it, vi } from "vitest";
import { createVmRoutesResolver, parseVmRoutes } from "../vm-routes.js";
import { gatewaySurfaceTarget } from "../public-router.js";

describe("parseVmRoutes", () => {
  it("accepts a gatewayId -> ip object and rejects anything else", () => {
    expect(parseVmRoutes('{"b-x":"172.20.0.9"}')).toEqual({ "b-x": "172.20.0.9" });
    expect(() => parseVmRoutes("[]")).toThrow(/JSON object/);
    expect(() => parseVmRoutes('{"not a gateway id!":"1.2.3.4"}')).toThrow(/invalid gateway id/);
    expect(() => parseVmRoutes('{"b-x":"evil.example"}')).toThrow(/invalid address/);
  });
});

describe("createVmRoutesResolver", () => {
  function resolver(files: Record<string, { text: string; mtime: number } | undefined>) {
    const log = vi.fn();
    const logInfo = vi.fn();
    const readFile = vi.fn((path: string) => {
      const file = files[path];
      if (!file) throw new Error("ENOENT");
      return file.text;
    });
    const resolve = createVmRoutesResolver({
      filePath: "/routes.json",
      edgePort: 3001,
      readFile,
      mtimeOf: (path) => files[path]?.mtime ?? null,
      log,
      logInfo,
    });
    return { resolve, readFile, log, logInfo };
  }

  it("routes a listed gateway to its VM and leaves others to the default origin", () => {
    const files = { "/routes.json": { text: '{"b-x":"172.20.0.9"}', mtime: 1 } };
    const { resolve, readFile } = resolver(files);
    expect(resolve("b-x")).toBe("http://172.20.0.9:3001");
    expect(resolve("b-y")).toBeUndefined();
    expect(readFile).toHaveBeenCalledTimes(1);

    const target = gatewaySurfaceTarget({
      url: "/g/b-x/chat?x=1",
      namespace: "octogee-test",
      targetOriginForGateway: (_surface, id) => resolve(id) ?? `http://gateway-edge-${id}.octogee-test.svc.cluster.local:3001`,
    });
    expect(target).toMatchObject({ origin: "http://172.20.0.9:3001", path: "/api/g/b-x/chat?x=1" });
  });

  it("reloads when the file changes, empties when it disappears, and keeps the last good table on a bad write", () => {
    const files: Record<string, { text: string; mtime: number } | undefined> = { "/routes.json": { text: '{"b-x":"172.20.0.9"}', mtime: 1 } };
    const { resolve, log } = resolver(files);
    expect(resolve("b-x")).toBe("http://172.20.0.9:3001");

    files["/routes.json"] = { text: '{"b-x":"172.20.0.10"}', mtime: 2 };
    expect(resolve("b-x")).toBe("http://172.20.0.10:3001");

    files["/routes.json"] = { text: "{not json", mtime: 3 };
    expect(resolve("b-x")).toBe("http://172.20.0.10:3001");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/unreadable/), expect.anything());

    files["/routes.json"] = undefined;
    expect(resolve("b-x")).toBeUndefined();
  });

  it("reports a successful load as routine and only an unreadable table as a problem", () => {
    const loaded = resolver({ "/routes.json": { text: '{"b-x":"172.20.0.9"}', mtime: 1 } });
    loaded.resolve("b-x");
    expect(loaded.logInfo).toHaveBeenCalledWith("[gateway-router] vm routes loaded", { count: 1 });
    expect(loaded.log).not.toHaveBeenCalled();

    const broken = resolver({ "/routes.json": { text: "{not json", mtime: 1 } });
    broken.resolve("b-x");
    expect(broken.log).toHaveBeenCalledOnce();
    expect(broken.log.mock.calls[0][0]).toBe(
      "[gateway-router] vm routes unreadable; keeping the previous table",
    );
    expect(broken.logInfo).not.toHaveBeenCalled();
  });
});
