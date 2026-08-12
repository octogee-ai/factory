import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION } from "@octogee/shared/types/glm";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";
import {
  createRsyncMigrationTransfer,
  migrationTransferTaskId,
  type CommandRunner,
} from "../lib/migration-rsync-transfer";

type Store = Record<string, Record<string, unknown>>;

const SOURCE_POD_IP = ["10", "1", "0", "10"].join(".");
const TARGET_POD_IP = ["10", "1", "0", "20"].join(".");
const IPV6_TARGET_POD_IP = "fd00::20";
const FLEET_CONTROLLER_PORT = "3003";

function makeDb(store: Store): Firestore {
  const docFor = (collection: string, id: string) => ({
    id,
    async get() {
      const data = store[id];
      return {
        exists: data != null,
        data: () => data,
      };
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      if (collection !== GLM_MIGRATION_TRANSFER_TASKS_COLLECTION) {
        throw new Error(`unexpected collection: ${collection}`);
      }
      store[id] = opts?.merge ? { ...(store[id] ?? {}), ...data } : { ...data };
    },
  });

  return {
    collection: (collection: string) => ({
      doc: (id: string) => docFor(collection, id),
    }),
    runTransaction: async <T,>(body: (txn: {
      get: (ref: ReturnType<typeof docFor>) => Promise<Awaited<ReturnType<ReturnType<typeof docFor>["get"]>>>;
      set: (
        ref: ReturnType<typeof docFor>,
        data: Record<string, unknown>,
        opts?: { merge?: boolean },
      ) => void;
    }) => Promise<T>) => {
      const writes: Array<() => Promise<void>> = [];
      const result = await body({
        get: (ref) => ref.get(),
        set: (ref, data, opts) => {
          writes.push(() => ref.set(data, opts));
        },
      });
      for (const write of writes) await write();
      return result;
    },
  } as unknown as Firestore;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runningPod(name: string, ready = true, podIP?: string): Response {
  return jsonResponse({
    items: [
      {
        metadata: { name },
        status: {
          phase: "Running",
          podIP: podIP ?? (name === "gw-from-pod" ? SOURCE_POD_IP : TARGET_POD_IP),
          conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
        },
      },
    ],
  });
}

function readyPod(name: string): Response {
  return runningPod(name);
}

function makeFetch(
  calls: string[],
  targetPodIP = TARGET_POD_IP,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as { migrationId: string; slug: string };
    if (url.includes("/prepare-rsync-import/")) {
      expect(body).toMatchObject({
        transferUser: "migration",
        sourcePodIp: SOURCE_POD_IP,
      });
      return jsonResponse({
        migrationId: body.migrationId,
        slug: body.slug,
        imported: true,
        host: "0.0.0.0",
        port: 30873,
        module: "state",
      });
    }
    if (url.includes("/push-rsync-state/")) {
      expect(body).toMatchObject({
        targetHost: targetPodIP,
        targetPort: 30873,
        transferUser: "migration",
      });
      return jsonResponse({ migrationId: body.migrationId, slug: body.slug, imported: true });
    }
    if (url.includes("/finish-rsync-import/")) {
      return jsonResponse({ migrationId: body.migrationId, slug: body.slug, imported: true });
    }
    if (url.includes("/abort-rsync-import/")) {
      return jsonResponse({ migrationId: body.migrationId, slug: body.slug, imported: true });
    }
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
}

function makeCommandRunner(calls: Array<{ command: string; args: string[] }>): CommandRunner {
  return async (command, args) => {
    calls.push({ command, args });
    if (command === "kubectl") {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=gw-from")) {
        return { stdout: await readyPod("gw-from-pod").text(), stderr: "", code: 0 };
      }
      if (selector.includes("gateway-instance=gw-to")) {
        return { stdout: await readyPod("gw-to-pod").text(), stderr: "", code: 0 };
      }
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

describe("migrationTransferTaskId", () => {
  it("is deterministic per migration phase and Firestore-doc safe", () => {
    expect(migrationTransferTaskId({ migrationId: "mig/1", mode: "final" })).toBe(
      "mig_1__final",
    );
  });
});

describe("createRsyncMigrationTransfer", () => {
  it("uses a running target transport while restore convergence intentionally holds Pod readiness", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      const response = selector.includes("gateway-instance=gw-to")
        ? runningPod("gw-to-pod", false, IPV6_TARGET_POD_IP)
        : readyPod("gw-from-pod");
      return { stdout: await response.text(), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: "7443",
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(fetchCalls, IPV6_TARGET_POD_IP),
      runCommand,
    });

    await expect(transfer({
      migrationId: "mig-target-restoring",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    })).resolves.toMatchObject({ imported: true });
    expect(fetchCalls).toEqual([
      `http://[${IPV6_TARGET_POD_IP}]:7443/prepare-rsync-import/gw-to`,
      "http://gw-from/push-rsync-state/gw-from",
      `http://[${IPV6_TARGET_POD_IP}]:7443/finish-rsync-import/gw-to`,
    ]);
  });

  it("requires the source transport to be Ready before it serves the state push", async () => {
    const store: Store = {};
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      const response = selector.includes("gateway-instance=gw-from")
        ? runningPod("gw-from-pod", false)
        : readyPod("gw-to-pod");
      return { stdout: await response.text(), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch([]),
      runCommand,
    });

    await expect(transfer({
      migrationId: "mig-source-not-ready",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    })).rejects.toMatchObject({
      message: "expected exactly one ready pod for transport=gw-from; found 0",
      retryable: true,
    });
  });

  it("rejects an ambiguous target transport instead of selecting an arbitrary pod", async () => {
    const store: Store = {};
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=gw-to")) {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: "gw-to-pod-a" },
                status: { phase: "Running", podIP: TARGET_POD_IP },
              },
              {
                metadata: { name: "gw-to-pod-b" },
                status: { phase: "Running", podIP: "10.1.0.21" },
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: await readyPod("gw-from-pod").text(), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch([]),
      runCommand,
    });

    await expect(transfer({
      migrationId: "mig-ambiguous-target",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    })).rejects.toMatchObject({
      message: "expected exactly one ready pod for transport=gw-to; found 0",
      retryable: true,
    });
  });

  it("selects the sole Ready target during a surge overlap", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=gw-to")) {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: "gw-to-serving" },
                status: {
                  phase: "Running",
                  podIP: TARGET_POD_IP,
                  conditions: [{ type: "Ready", status: "True" }],
                },
              },
              {
                metadata: { name: "gw-to-candidate" },
                status: {
                  phase: "Running",
                  podIP: "10.1.0.21",
                  conditions: [{ type: "Ready", status: "False" }],
                },
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: await readyPod("gw-from-pod").text(), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(fetchCalls),
      runCommand,
    });

    await transfer({
      migrationId: "mig-surge-target",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    });

    expect(fetchCalls[0]).toBe(
      `http://${TARGET_POD_IP}:${FLEET_CONTROLLER_PORT}/prepare-rsync-import/gw-to`,
    );
  });

  it("signals a missing source pod as retryable so a preempted shared gateway can recover in place", async () => {
    const store: Store = {};
    const runCommand: CommandRunner = async (_command, args) => {
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=gw-to")) {
        return { stdout: await readyPod("gw-to-pod").text(), stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify({ items: [] }), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch([]),
      runCommand,
    });

    await expect(transfer({
      migrationId: "mig-preempted-source",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
    })).rejects.toMatchObject({
      message: "expected exactly one ready pod for transport=gw-from; found 0",
      retryable: true,
    });
  });

  it("uses revision transport ids for same-gateway drain pod selection and control URLs", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    const runCommand: CommandRunner = async (command, args) => {
      commandCalls.push({ command, args });
      const selector = args[args.indexOf("-l") + 1] ?? "";
      if (selector.includes("gateway-instance=default-r2")) {
        return { stdout: await readyPod("gw-from-pod").text(), stderr: "", code: 0 };
      }
      if (selector.includes("gateway-instance=default-r3")) {
        return { stdout: await readyPod("gw-to-pod").text(), stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify({ items: [] }), stderr: "", code: 0 };
    };
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(fetchCalls),
      runCommand,
    });

    await transfer({
      migrationId: "mig-drain",
      fromGatewayId: "default",
      toGatewayId: "default",
      fromTransportId: "default-r2",
      toTransportId: "default-r3",
      slug: "alice",
      mode: "initial",
    });

    expect(commandCalls.map((call) => call.args[call.args.indexOf("-l") + 1])).toEqual([
      "app=octogee-gateway,gateway-instance=default-r2",
      "app=octogee-gateway,gateway-instance=default-r3",
    ]);
    expect(fetchCalls).toEqual([
      `http://${TARGET_POD_IP}:3003/prepare-rsync-import/default`,
      "http://default-r2/push-rsync-state/default",
      `http://${TARGET_POD_IP}:3003/finish-rsync-import/default`,
    ]);
  });

  it("re-runs a succeeded transfer because rollback can remove the target copy", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    let now = 10_000;
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(fetchCalls),
      runCommand: makeCommandRunner(commandCalls),
      now: () => now++,
      workerId: "worker-1",
    });

    await transfer({
      migrationId: "mig-1",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
      includeActivationManifest: true,
    });

    expect(store["mig-1__pre"]).toMatchObject({
      status: "succeeded",
      attempt: 1,
      sourceGatewayId: "gw-from",
      targetGatewayId: "gw-to",
    });
    expect(fetchCalls).toEqual([
      `http://${TARGET_POD_IP}:3003/prepare-rsync-import/gw-to`,
      "http://gw-from/push-rsync-state/gw-from",
      `http://${TARGET_POD_IP}:3003/finish-rsync-import/gw-to`,
    ]);
    expect(commandCalls.filter((c) => c.command === "kubectl")).toHaveLength(2);
    expect(commandCalls.filter((c) => c.command === "rsync")).toHaveLength(0);

    await transfer({
      migrationId: "mig-1",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
      includeActivationManifest: true,
    });

    expect(store["mig-1__pre"]).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(fetchCalls).toHaveLength(6);
    expect(commandCalls.filter((c) => c.command === "kubectl")).toHaveLength(4);
  });

  it("marks a failed direct push task failed, aborts target import, and retries it with the next attempt", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    let failPush = true;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes("/push-rsync-state/") && failPush) {
        return new Response("network reset", { status: 500 });
      }
      return makeFetch([])(input, init);
    }) as typeof globalThis.fetch;
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      fleetControllerPort: FLEET_CONTROLLER_PORT,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch,
      runCommand: makeCommandRunner(commandCalls),
      now: () => Date.now(),
      workerId: "worker-1",
    });

    const input = {
      migrationId: "mig-2",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "final" as const,
      includeActivationManifest: false,
    };

    await expect(transfer(input)).rejects.toThrow(/network reset/);
    expect(store["mig-2__final"]).toMatchObject({ status: "failed", attempt: 1 });
    expect(fetchCalls).toContain(
      `http://${TARGET_POD_IP}:3003/abort-rsync-import/gw-to`,
    );

    failPush = false;
    await transfer(input);
    expect(store["mig-2__final"]).toMatchObject({ status: "succeeded", attempt: 2 });
  });
});
