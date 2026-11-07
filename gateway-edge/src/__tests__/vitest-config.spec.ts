import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it } from "vitest";
import config from "../../vitest.config.js";
import emulatorConfig from "../../vitest.emulator.config.js";

interface VitestConfig {
  test?: {
    exclude?: string[];
    setupFiles?: string[];
    testTimeout?: number;
    hookTimeout?: number;
  };
}

describe("gateway-edge vitest config", () => {
  it("excludes build output and package dependencies from test discovery", () => {
    const cfg = config as VitestConfig;

    expect(cfg.test?.exclude).toEqual(["dist/**", "node_modules/**"]);
  });

  it("loads the loopback listen shim in both run modes", () => {
    expect((config as VitestConfig).test?.setupFiles).toEqual([
      "./src/test-setup/loopback-listen.ts",
      "./src/test-setup/public-app-origins.ts",
    ]);
    expect((emulatorConfig as VitestConfig).test?.setupFiles).toEqual([
      "./src/test-setup/loopback-listen.ts",
      "./src/test-setup/public-app-origins.ts",
    ]);
  });

  it("budgets subprocess-heavy specs for a loaded machine, not an idle one", () => {
    const cfg = config as VitestConfig;

    expect(cfg.test?.testTimeout).toBe(60_000);
    expect(cfg.test?.hookTimeout).toBe(60_000);
  });
});

describe("loopback listen shim", () => {
  async function boundAddress(listenArgs: [number, string?]): Promise<string> {
    const server = http.createServer();
    server.listen(...listenArgs);
    await once(server, "listening");
    const { address } = server.address() as AddressInfo;
    server.close();
    return address;
  }

  it("pins host-less ephemeral listeners to 127.0.0.1", async () => {
    expect(await boundAddress([0])).toBe("127.0.0.1");
  });

  it("rewrites explicit wildcard hosts to 127.0.0.1", async () => {
    expect(await boundAddress([0, "0.0.0.0"])).toBe("127.0.0.1");
  });

  it("serves supertest requests from a loopback-bound server", async () => {
    let localAddress = "";
    await request((req: http.IncomingMessage, res: http.ServerResponse) => {
      localAddress = req.socket.localAddress ?? "";
      res.end("ok");
    })
      .get("/")
      .expect(200);
    expect(localAddress).toBe("127.0.0.1");
  });
});
