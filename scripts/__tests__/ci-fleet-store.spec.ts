import { describe, expect, it, vi } from "vitest";
import { withFleetStore } from "../ci/fleet-store.mjs";

describe("release fleet store", () => {
  it("uses the existing environment for a Firestore deployment", async () => {
    const tunnel = vi.fn();
    const run = vi.fn(async (env) => env);
    const result = await withFleetStore({ inspect: async () => ({ backend: "firestore" }), tunnel }, run);
    expect(result).toEqual({ PLATFORM_STATE_BACKEND: "firestore" });
    expect(tunnel).not.toHaveBeenCalled();
  });

  it("passes the deployed PostgreSQL credentials through a temporary tunnel", async () => {
    const close = vi.fn(async () => {});
    const tunnel = vi.fn(async () => ({ port: 15432, close }));
    const run = vi.fn(async (env) => env);
    const result = await withFleetStore({
      inspect: async () => ({ backend: "postgres", host: "10.89.0.11", port: 5432, database: "platform", user: "runtime", password: "secret", sslmode: "require", image: "image@sha256:abc" }),
      tunnel,
    }, run);
    expect(result).toMatchObject({ PLATFORM_STATE_BACKEND: "postgres", PLATFORM_DB_HOST: "127.0.0.1", PLATFORM_DB_PORT: "15432", PLATFORM_DB_USER: "runtime", PLATFORM_DB_PASSWORD: "secret", PLATFORM_DB_SSLMODE: "require" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the tunnel when fleet convergence fails", async () => {
    const close = vi.fn(async () => {});
    await expect(withFleetStore({
      inspect: async () => ({ backend: "postgres", host: "db", port: 5432, database: "platform", user: "runtime", password: "secret", sslmode: "require", image: "image" }),
      tunnel: async () => ({ port: 15432, close }),
    }, async () => { throw new Error("fleet failed"); })).rejects.toThrow("fleet failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not downgrade verified TLS to an unverified tunnel", async () => {
    const tunnel = vi.fn();
    await expect(withFleetStore({ inspect: async () => ({ backend: "postgres", sslmode: "verify-full" }), tunnel }, async () => {})).rejects.toThrow("verify-full");
    expect(tunnel).not.toHaveBeenCalled();
  });
});
