import { describe, expect, it, vi } from "vitest";
import { fleetStoreDependencies, withFleetStore } from "../ci/fleet-store.mjs";

const cluster = vi.hoisted(() => ({ calls: [] as string[][], readable: new Set<string>() }));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    execFile: (_file: string, args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      const command = args.slice(4);
      cluster.calls.push(command);
      const pod = command.find((arg) => arg.startsWith("pod/"))?.slice("pod/".length);
      if (command[0] === "wait" && command.includes("--for=create") && pod) cluster.readable.add(pod);
      if (command[0] === "wait" && command.includes("--for=condition=Ready") && pod && !cluster.readable.has(pod)) {
        callback(new Error(`Error from server (NotFound): pods "${pod}" not found`));
        return;
      }
      callback(null, { stdout: "", stderr: "" });
    },
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      setImmediate(() => child.stdout.write("Forwarding from 127.0.0.1:43210 -> 15432\n"));
      return child;
    },
  };
});

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

  it("passes the original certificate identity and CA through the tunnel", async () => {
    const close = vi.fn(async () => {});
    const result = await withFleetStore({
      inspect: async () => ({
        backend: "postgres", host: "10.89.0.11", port: 5432, database: "platform",
        user: "runtime", password: "secret", sslmode: "verify-full", image: "image",
        tlsServerIdentity: "db.example.test", caCertificate: "pem",
      }),
      tunnel: async () => ({ port: 15432, close }),
    }, async env => env);
    expect(result).toMatchObject({
      PLATFORM_DB_HOST: "127.0.0.1",
      PLATFORM_DB_SSLMODE: "verify-full",
      PLATFORM_DB_TLS_SERVER_IDENTITY: "db.example.test",
      PLATFORM_DB_CA_CERT: "pem",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses plaintext connections through the tunnel", async () => {
    const tunnel = vi.fn();
    await expect(withFleetStore({ inspect: async () => ({ backend: "postgres", sslmode: "disable" }), tunnel }, async () => {})).rejects.toThrow("disable");
    expect(tunnel).not.toHaveBeenCalled();
  });
});

describe("platform database tunnel", () => {
  it("waits for its pod to be readable before waiting for it to become ready", async () => {
    const tunnel = await fleetStoreDependencies("prod").tunnel({ host: "10.89.0.12", port: 5432, image: "fleet-controller@sha256:abc" });

    expect(tunnel.port).toBe(43210);
    const verbs = cluster.calls.map((command) => command.slice(0, 2).join(" "));
    expect(verbs.indexOf("wait --for=create")).toBeGreaterThan(verbs.indexOf(`run ${cluster.calls[0][1]}`));
    expect(verbs.indexOf("wait --for=condition=Ready")).toBeGreaterThan(verbs.indexOf("wait --for=create"));
    await tunnel.close();
    expect(cluster.calls.at(-1)).toEqual(expect.arrayContaining(["delete", "pod", cluster.calls[0][1]]));
  });
});
