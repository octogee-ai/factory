import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "jane-s-1a2b3c4d";
const THIS_POD = `octogee-gateway-${GATEWAY_ID}-7f9c5d8b6-new01`;
const PREVIOUS_POD = `octogee-gateway-${GATEWAY_ID}-7f9c5d8b6-old01`;
const TERMINATING_POD = `octogee-gateway-${GATEWAY_ID}-7f9c5d8b6-term1`;

function fixture(existing: string[], lookup?: (podName: string) => Promise<boolean>) {
  const looked: string[] = [];
  const server = express();
  server.disable("x-powered-by");
  server.use(express.json());
  server.use(((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: GATEWAY_ID, podName: THIS_POD, podUid: "uid-new", tokenSource: "ksa" } as never;
    next();
  }) as RequestHandler);
  server.use("/internal/fleet", createFleetBrokerRoutes({
    store: createDocumentFixtureStore(new RecordingDocuments({})),
    gatewayPodExists: lookup ?? (async (podName) => {
      looked.push(podName);
      return existing.includes(podName);
    }),
  }));
  return { server, looked };
}

function ask(server: express.Express, hostnames: unknown, gatewayId: string = GATEWAY_ID) {
  return request(server).post("/internal/fleet/stopped-gateway-pods").send({ gatewayId, hostnames });
}

describe("stopped-gateway-pods", () => {
  it("names the caller's gateway pods that no longer exist, and keeps a pod that still exists, terminating or not", async () => {
    const { server, looked } = fixture([TERMINATING_POD]);

    const response = await ask(server, [PREVIOUS_POD, TERMINATING_POD]).expect(200);

    expect(response.body).toEqual({ stopped: [PREVIOUS_POD] });
    expect(looked).toEqual([PREVIOUS_POD, TERMINATING_POD]);
  });

  it("never answers for the calling pod itself", async () => {
    const { server, looked } = fixture([]);

    await ask(server, [THIS_POD]).expect(400, { error: "invalid_gateway_pod_hostnames" });

    expect(looked).toEqual([]);
  });

  it.each([
    ["a pod of another gateway", "octogee-gateway-john-s-9f8e7d6c-7f9c5d8b6-old01"],
    ["a hostname the kubelet truncated from a longer pod name", `octogee-gateway-${GATEWAY_ID}-7f9c5d8b6-ol`],
    ["a hostname that is not a Deployment pod name", `octogee-gateway-${GATEWAY_ID}-old01`],
  ])("refuses %s, whose absence would prove nothing", async (_name, hostname) => {
    const { server, looked } = fixture([]);

    await ask(server, [hostname]).expect(400, { error: "invalid_gateway_pod_hostnames" });

    expect(looked).toEqual([]);
  });

  it.each([
    ["no hostnames", []],
    ["a non-string hostname", [42]],
    ["too many hostnames", Array.from({ length: 9 }, (_, index) => `octogee-gateway-${GATEWAY_ID}-7f9c5d8b6-old0${index}`)],
  ])("refuses %s", async (_name, hostnames) => {
    const { server, looked } = fixture([]);

    await ask(server, hostnames).expect(400, { error: "invalid_gateway_pod_hostnames" });

    expect(looked).toEqual([]);
  });

  it("refuses a request that names another gateway", async () => {
    const { server, looked } = fixture([]);

    await ask(server, [PREVIOUS_POD], "john-s-9f8e7d6c").expect(403);

    expect(looked).toEqual([]);
  });

  it("fails without an answer when the pod lookup fails", async () => {
    const { server } = fixture([], async () => { throw new Error("pod lookup HTTP 403"); });

    const response = await ask(server, [PREVIOUS_POD]);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "pod lookup HTTP 403" });
  });
});
