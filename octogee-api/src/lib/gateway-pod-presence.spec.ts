import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGatewayPodPresence, type PodLookupRequest } from "./gateway-pod-presence.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-pod-presence-"));
  fs.writeFileSync(path.join(dir, "token"), "reader-token\n");
  fs.writeFileSync(path.join(dir, "ca.crt"), "ca-bundle");
  fs.writeFileSync(path.join(dir, "namespace"), "octogee-test\n");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function presence(status: number) {
  const requests: PodLookupRequest[] = [];
  const exists = createGatewayPodPresence({
    apiHost: "10.0.0.1",
    apiPort: "443",
    tokenPath: path.join(dir, "token"),
    caPath: path.join(dir, "ca.crt"),
    namespacePath: path.join(dir, "namespace"),
    transport: async (input) => {
      requests.push(input);
      return { status };
    },
  });
  return { exists, requests };
}

describe("createGatewayPodPresence", () => {
  it("reads the pod in octogee-api's own namespace with its service account", async () => {
    const { exists, requests } = presence(200);

    await expect(exists("octogee-gateway-jane-s-1a2b3c4d-7f9c5d8b6-old01")).resolves.toBe(true);

    expect(requests).toEqual([{
      url: "https://10.0.0.1:443/api/v1/namespaces/octogee-test/pods/octogee-gateway-jane-s-1a2b3c4d-7f9c5d8b6-old01",
      bearerToken: "reader-token",
      ca: "ca-bundle",
    }]);
  });

  it("reports a pod the API server no longer has as absent", async () => {
    await expect(presence(404).exists("octogee-gateway-jane-s-1a2b3c4d-7f9c5d8b6-old01")).resolves.toBe(false);
  });

  it.each([403, 500])("fails on HTTP %s rather than guessing", async (status) => {
    await expect(presence(status).exists("octogee-gateway-jane-s-1a2b3c4d-7f9c5d8b6-old01")).rejects.toThrow(`pod lookup HTTP ${status}`);
  });
});
