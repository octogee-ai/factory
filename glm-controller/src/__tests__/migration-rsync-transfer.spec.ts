import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION } from "../../../shared/types/glm";
import { FLEET_KEY_PAIR } from "../../../scripts/__tests__/fixtures/fleet-keys";
import {
  createRsyncMigrationTransfer,
  migrationTransferTaskId,
  type CommandRunner,
} from "../lib/migration-rsync-transfer";

type Store = Record<string, Record<string, unknown>>;

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

function readyPod(name: string): Response {
  return jsonResponse({
    items: [
      {
        metadata: { name },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
        },
      },
    ],
  });
}

function makeFetch(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as { migrationId: string; slug: string };
    if (url.includes("/prepare-import/")) {
      return jsonResponse({ migrationId: body.migrationId, slug: body.slug, imported: true });
    }
    if (url.includes("/export-paths/")) {
      return jsonResponse({
        migrationId: body.migrationId,
        slug: body.slug,
        sources: [
          { cwd: "/home/node/.openclaw", path: "customers/alice" },
          { cwd: "/home/node/.openclaw", path: "customer-keys/alice" },
        ],
      });
    }
    if (url.includes("/export-activation-manifest/")) {
      return jsonResponse({
        migrationId: body.migrationId,
        slug: body.slug,
        manifest: {
          version: 1,
          slug: body.slug,
          agentId: "octogee-alice-coach",
          accountId: "alice-coach",
          agent: { id: "octogee-alice-coach" },
          mattermostAccount: { botToken: "token" },
          bindings: [{ agentId: "octogee-alice-coach" }],
        },
      });
    }
    if (url.includes("/activate-import/")) {
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
  it("runs prepare → source path list → rsync pull/push → activate and makes succeeded retry a no-op", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    let now = 10_000;
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
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
      "http://gw-to/prepare-import/gw-to",
      "http://gw-from/export-paths/gw-from",
      "http://gw-from/export-activation-manifest/gw-from",
      "http://gw-to/activate-import/gw-to",
    ]);
    const rsyncCalls = commandCalls.filter((c) => c.command === "rsync");
    expect(rsyncCalls).toHaveLength(2);
    expect(rsyncCalls[0].args).toContain(
      "gw-from-pod:/home/node/.openclaw/./customers/alice",
    );
    expect(rsyncCalls[1].args).toContain("--delete");
    expect(rsyncCalls[1].args.some((arg) => arg.includes("./customers/alice"))).toBe(true);
    expect(rsyncCalls[1].args.some((arg) => arg.includes("./.octogee-migration-activation/alice/activation.json"))).toBe(true);

    await transfer({
      migrationId: "mig-1",
      fromGatewayId: "gw-from",
      toGatewayId: "gw-to",
      slug: "alice",
      mode: "pre",
      includeActivationManifest: true,
    });

    expect(fetchCalls).toHaveLength(4);
    expect(commandCalls.filter((c) => c.command === "rsync")).toHaveLength(2);
  });

  it("marks a failed rsync task failed and retries it with the next attempt", async () => {
    const store: Store = {};
    const fetchCalls: string[] = [];
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    let failPush = true;
    const baseRunner = makeCommandRunner(commandCalls);
    const runCommand: CommandRunner = async (command, args, opts) => {
      if (command === "rsync" && args.includes("--delete") && failPush) {
        commandCalls.push({ command, args });
        return { stdout: "", stderr: "network reset", code: 12 };
      }
      return baseRunner(command, args, opts);
    };
    const transfer = createRsyncMigrationTransfer({
      db: makeDb(store),
      namespace: "octogee-test",
      privateKey: FLEET_KEY_PAIR.privateKey,
      resolveGatewayUrl: (id) => `http://${id}`,
      fetch: makeFetch(fetchCalls),
      runCommand,
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

    failPush = false;
    await transfer(input);
    expect(store["mig-2__final"]).toMatchObject({ status: "succeeded", attempt: 2 });
  });
});
