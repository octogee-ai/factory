import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it } from "vitest";
import unitConfig from "../../vitest.config.js";
import emulatorConfig from "../../vitest.emulator.config.js";

interface VitestConfig {
  test?: {
    setupFiles?: string[];
    fileParallelism?: boolean;
    testTimeout?: number;
    exclude?: string[];
    include?: string[];
  };
}

describe("octogee-api vitest configs", () => {
  it("loads Firebase offline setup and keeps route reuse serial", () => {
    const cfg = unitConfig as VitestConfig;

    expect(cfg.test?.setupFiles).toEqual([
      "./src/test-setup/loopback-listen.ts",
      "./src/test-setup/firebase-offline.ts",
      "./src/test-setup/markup-env.ts",
    ]);
    expect(cfg.test?.fileParallelism).toBe(false);
    expect(cfg.test?.testTimeout).toBe(15_000);
    expect(cfg.test?.exclude).toContain("../gateway-edge/**");
  });

  it("runs emulator specs serially with the emulator glob", () => {
    const cfg = emulatorConfig as VitestConfig;

    expect(cfg.test?.include).toEqual(["src/__tests__/**/*.emulator.spec.ts"]);
    expect(cfg.test?.fileParallelism).toBe(false);
    expect(cfg.test?.testTimeout).toBe(15_000);
  });

  it("loads the loopback listen shim and the markup env in both run modes", () => {
    expect((emulatorConfig as VitestConfig).test?.setupFiles).toEqual([
      "./src/test-setup/loopback-listen.ts",
      "./src/test-setup/markup-env.ts",
    ]);
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
