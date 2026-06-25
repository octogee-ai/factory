import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { internalFetch } from "../lib/internal-fetch.js";

const tempDirs: string[] = [];

async function tokenFile(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scripts-internal-fetch-"));
  tempDirs.push(dir);
  const file = path.join(dir, "token");
  await writeFile(file, body);
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("scripts internalFetch", () => {
  it("adds both internal key and projected service-account token headers", async () => {
    const seen: RequestInit[] = [];
    await internalFetch(
      "http://gateway-edge.local/api/model-credentials/subscription/auth-state",
      { method: "POST" },
      {
        internalServiceKey: "service-key",
        tokenPath: await tokenFile("projected-jwt\n"),
        fetchImpl: async (_url, init) => {
          seen.push(init ?? {});
          return new Response("ok");
        },
      },
    );

    const headers = new Headers(seen[0].headers);
    expect(headers.get("x-internal-service-key")).toBe("service-key");
    expect(headers.get("x-k8s-sa-token")).toBe("projected-jwt");
  });

  it("omits the service-account token header when the projected token is missing", async () => {
    const seen: RequestInit[] = [];
    await internalFetch(
      "http://gateway-edge.local/api/model-credentials/subscription/auth-state",
      {},
      {
        internalServiceKey: "service-key",
        tokenPath: path.join(os.tmpdir(), "missing-token-" + Math.random()),
        fetchImpl: async (_url, init) => {
          seen.push(init ?? {});
          return new Response("ok");
        },
      },
    );

    const headers = new Headers(seen[0].headers);
    expect(headers.get("x-internal-service-key")).toBe("service-key");
    expect(headers.get("x-k8s-sa-token")).toBeNull();
  });
});
