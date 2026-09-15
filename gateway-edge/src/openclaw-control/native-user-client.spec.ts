import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { OPENCLAW_FULL_OPERATOR_SCOPES } from "@octogee/shared/types/openclaw-proxy-identity";
import { openNativeUserClient } from "./native-user-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

async function gateway() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state = {
    scopes: ["operator.read", "operator.write"] as string[] | undefined,
    connects: [] as Array<{ uid: string; device: { id: string }; scopes: string[] }>,
  };
  wss.on("connection", (ws, req) => {
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.method === "connect") {
        state.connects.push({ uid: String(req.headers["x-octogee-user"]), device: frame.params.device, scopes: frame.params.scopes });
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", auth: { scopes: state.scopes } } }));
      } else {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "native role denied" } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => server.close(() => resolve()));
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-user-ready-"));
  fs.writeFileSync(path.join(dir, "workspace-identity-boot"), "test-boot");
  fs.writeFileSync(path.join(dir, "workspace-identity-ready"), "test-boot");
  cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { OPENCLAW_DIR: dir, GATEWAY_OWNER_UID: "owner", GATEWAY_CLASS: "builder", GATEWAY_ID: "b-alice", OPENCLAW_CONTROL_IDENTITY: "per-user",
    OPENCLAW_GATEWAY_TOKEN: "pod-secret", API_PUBLIC_URL: "https://api.octogee.com",
    OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  return { state, env };
}

describe("native user RPC identity", () => {
  it("keeps one device per user while native role changes update effective scopes", async () => {
    const { state, env } = await gateway();
    const first = await openNativeUserClient("alice", "b-alice", env);
    expect(first.scopes.has("operator.admin")).toBe(false);
    first.close();
    state.scopes = [...OPENCLAW_FULL_OPERATOR_SCOPES];
    const promoted = await openNativeUserClient("alice", "b-alice", env);
    expect(promoted.scopes.has("operator.admin")).toBe(true);
    expect(await promoted.call("users.setRole", {})).toEqual({ ok: false, reason: "native role denied" });
    promoted.close();
    const other = await openNativeUserClient("bob", "b-alice", env);
    other.close();
    expect(state.connects[0].device.id).toBe(state.connects[1].device.id);
    expect(state.connects[0].device.id).not.toBe(state.connects[2].device.id);
    expect(state.connects.map(connect => connect.uid)).toEqual(["alice", "alice", "bob"]);
    expect(state.connects.every(connect => JSON.stringify(connect.scopes) === JSON.stringify(OPENCLAW_FULL_OPERATOR_SCOPES))).toBe(true);
  });

  it("fails closed when native effective scopes are unavailable", async () => {
    const { state, env } = await gateway();
    state.scopes = undefined;
    await expect(openNativeUserClient("alice", "b-alice", env)).rejects.toThrow("effective scopes");
  });

  it("does not open a user connection until the current boot is initialized", async () => {
    const { state, env } = await gateway();
    fs.rmSync(path.join(env.OPENCLAW_DIR, "workspace-identity-ready"));
    await expect(openNativeUserClient("alice", "b-alice", env)).rejects.toThrow("not initialized");
    expect(state.connects).toEqual([]);
  });

  it("does not connect across gateway identities or on shared gateways", async () => {
    const { state, env } = await gateway();
    await expect(openNativeUserClient("alice", "other", env)).rejects.toThrow("local per-user Builder");
    await expect(openNativeUserClient("alice", "b-alice", { ...env, GATEWAY_CLASS: "shared" })).rejects.toThrow("local per-user Builder");
    expect(state.connects).toEqual([]);
  });
});
