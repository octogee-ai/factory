import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  POD_SESSION_DIGEST_SCRIPT,
  createSurgePodTransport,
  parseSurgePodSnapshot,
  readPodDurableSessionDigest,
} from "../surge-customer-handoff-runtime.js";
import {
  SurgeGatewayScopedSignatureCapabilityMissingError,
  type SurgePod,
} from "../surge-customer-handoff.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const GATEWAY_ID = "gw-a";

const source: SurgePod = {
  uid: "old",
  name: "old-pod",
  podIP: "10.0.0.1",
  ready: true,
  terminating: false,
};
const target: SurgePod = {
  uid: "new",
  name: "new-pod",
  podIP: "10.0.0.2",
  ready: false,
  terminating: false,
};

const LOCAL_CORE_PORTABLE_PLAN = fileURLToPath(new URL(
  "../../node_modules/@octogee/core/dist/local-coach-wired.js",
  import.meta.url,
));

function runBuilderDigest(
  stateDir: string,
  configPath?: string,
): { fileCount: number; totalBytes: number; sha256: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      POD_SESSION_DIGEST_SCRIPT.replace(
        "/octogee/scripts/node_modules/@octogee/core/dist/local-coach-wired.js",
        LOCAL_CORE_PORTABLE_PLAN,
      ),
      "alice",
      "configured-builder-system-config",
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath ?? "",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(`digest subprocess failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as { fileCount: number; totalBytes: number; sha256: string };
}

function writeConfiguredBuilderState(
  stateDir: string,
  configPath = path.join(stateDir, "openclaw.json"),
): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    agents: {
      list: [{
        id: "discord-helper",
        agentDir: path.join(stateDir, "agents", "discord-helper", "runtime"),
        workspace: path.join(stateDir, "workspaces", "discord-helper"),
      }],
    },
    session: { store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json") },
  }));
  const files = [
    ["agents/discord-helper/agent/legacy.json", "legacy"],
    ["agents/discord-helper/runtime/auth.json", "agent-auth"],
    ["workspaces/discord-helper/notes.md", "workspace"],
    ["agents/discord-helper/sessions/sessions.json", "session"],
    ["memory/discord-helper.sqlite", "sqlite"],
  ] as const;
  for (const [relativePath, contents] of files) {
    const absolutePath = path.join(stateDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
  }
}

describe("surge handoff Kubernetes projection", () => {
  it("keeps every observed UID while projecting usable pods independently", () => {
    expect(parseSurgePodSnapshot(JSON.stringify({
      items: [
        {
          metadata: { uid: "old", name: "old-pod" },
          status: {
            phase: "Running",
            podIP: "10.0.0.1",
            conditions: [{ type: "Ready", status: "True" }],
          },
        },
        {
          metadata: { uid: "new", name: "new-pod" },
          status: { phase: "Running", podIP: "10.0.0.2", conditions: [] },
        },
        {
          metadata: { uid: "gone", name: "gone-pod", deletionTimestamp: "now" },
          status: { phase: "Running", podIP: "10.0.0.3" },
        },
        {
          metadata: { uid: "pending", name: "pending-pod" },
          status: { phase: "Pending" },
        },
      ],
    }))).toEqual({
      pods: [
        source,
        target,
        {
          uid: "gone",
          name: "gone-pod",
          podIP: "10.0.0.3",
          ready: false,
          terminating: true,
        },
      ],
      observedPodUids: ["old", "new", "gone", "pending"],
    });
  });

  it("reads the session digest through kubectl exec so the source may run the prior image", async () => {
    const runKubectl = vi.fn(async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ fileCount: 2, totalBytes: 20, sha256: "a".repeat(64) }),
    }));

    await expect(readPodDurableSessionDigest(
      runKubectl,
      "octogee-test",
      source,
      "alice",
    )).resolves.toEqual({ fileCount: 2, totalBytes: 20, sha256: "a".repeat(64) });

    expect(runKubectl).toHaveBeenCalledWith(expect.arrayContaining([
      "-n",
      "octogee-test",
      "exec",
      "pod/old-pod",
      "-c",
      "gateway",
      "--",
      "node",
      "--input-type=module",
      "-e",
      expect.any(String),
      "alice",
    ]));
  });

  it("runs the Builder durable-state planner from the scripts package context", async () => {
    const runKubectl = vi.fn(async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ fileCount: 4, totalBytes: 40, sha256: "b".repeat(64) }),
    }));

    await readPodDurableSessionDigest(
      runKubectl,
      "octogee-test",
      source,
      "alice",
      "configured-builder-system-config",
    );

    const args = runKubectl.mock.calls[0]?.[0] as string[];
    expect(args).toEqual(expect.arrayContaining([
      "node",
      "--input-type=module",
      "-e",
      "configured-builder-system-config",
    ]));
    const script = args[args.indexOf("-e") + 1] ?? "";
    expect(script).toContain(
      "/octogee/scripts/node_modules/@octogee/core/dist/local-coach-wired.js",
    );
    expect(script).toContain("configuredBuilderPortableStatePlanFromConfig");
    expect(script).toContain("assertConfiguredBuilderPortableStatePlanOnDisk");
  });

  it("hashes matching explicit Builder agent, workspace, and session-store state on distinct pods", () => {
    const sourceState = fs.mkdtempSync(path.join(os.tmpdir(), "builder-digest-source-"));
    const targetState = fs.mkdtempSync(path.join(os.tmpdir(), "builder-digest-target-"));
    try {
      writeConfiguredBuilderState(sourceState);
      writeConfiguredBuilderState(targetState);

      const sourceDigest = runBuilderDigest(sourceState, path.join(sourceState, "openclaw.json"));
      const targetDigest = runBuilderDigest(targetState, path.join(targetState, "openclaw.json"));

      expect(sourceDigest).toEqual(targetDigest);
      expect(sourceDigest.fileCount).toBe(5);

      fs.writeFileSync(
        path.join(targetState, "workspaces", "discord-helper", "notes.md"),
        "changed workspace state",
      );
      expect(runBuilderDigest(targetState, path.join(targetState, "openclaw.json"))).not.toEqual(sourceDigest);
    } finally {
      fs.rmSync(sourceState, { recursive: true, force: true });
      fs.rmSync(targetState, { recursive: true, force: true });
    }
  });

  it("uses the configured Builder system config when the gateway does not expose its config path", () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "builder-digest-system-config-"));
    try {
      writeConfiguredBuilderState(state, path.join(state, "system_config", "openclaw.json"));

      expect(runBuilderDigest(state)).toMatchObject({ fileCount: 5, totalBytes: expect.any(Number) });
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

type SurgeTransportCall = { url: string; body?: Record<string, unknown> };
type FetchInput = string | URL | Request;

describe("surge handoff direct pod transport", () => {
  it("transfers customer keys before final state and verifies each direct pod", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "pod-uid", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({
          status: "ready",
          version: url.includes("10.0.0.2") ? "new" : "old",
          customers: ["alice"],
        }));
      }
      if (url.endsWith("/surge-ready")) {
        return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }), { status: 503 });
      }
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "octogee-import" }));
      }
      if (url.includes("/durable-session-digest/")) {
        return new Response(JSON.stringify({ fileCount: 2, totalBytes: 20, sha256: "a".repeat(64) }));
      }
      return new Response(JSON.stringify({ imported: true, released: true }));
    }) as unknown as typeof globalThis.fetch;
    const randomKey = vi.fn()
      .mockReturnValueOnce("keys-transfer-key")
      .mockReturnValueOnce("final-transfer-key");
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      randomKey,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toEqual({
      status: "ready",
      version: "new",
      fleetSignatureCapability: "gateway-scoped",
      handoffReleased: false,
      prelaunchState: "none",
      mountedCustomers: ["alice"],
    });
    await transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "expedited",
      configTransferMode: "activation-manifest",
    });
    await transport.discardTargetCustomer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    });
    await transport.releaseTarget({
      gatewayId: "default",
      operationId: "surge-default-new",
      pod: target,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://10.0.0.2:3003/health",
      "http://10.0.0.2:3003/surge-ready",
      `http://10.0.0.2:3003/fleet-state/${GATEWAY_ID}`,
      "http://10.0.0.2:3003/prepare-rsync-import/default",
      "http://10.0.0.1:3003/push-rsync-state/default",
      "http://10.0.0.2:3003/finish-rsync-import/default",
      "http://10.0.0.2:3003/prepare-rsync-import/default",
      "http://10.0.0.1:3003/push-rsync-state/default",
      "http://10.0.0.2:3003/finish-rsync-import/default",
      "http://10.0.0.2:3003/unmount/default",
      "http://10.0.0.2:3003/complete-surge-handoff/default",
    ]);
    expect(calls.slice(3, 9).map((call) => call.body?.rpcPhase)).toEqual([
      "prepare-rsync-import",
      "push-rsync-state",
      "finish-rsync-import",
      "prepare-rsync-import",
      "push-rsync-state",
      "finish-rsync-import",
    ]);
    expect(calls[3]?.body).toMatchObject({
      slug: "alice",
      mode: "keys",
      sourcePodIp: "10.0.0.1",
      transferKey: "keys-transfer-key",
    });
    expect(calls[4]?.body).toMatchObject({
      mode: "keys",
      targetHost: "10.0.0.2",
      targetPort: 30873,
    });
    expect(calls[6]?.body).toMatchObject({
      slug: "alice",
      mode: "final",
      sourcePodIp: "10.0.0.1",
      transferKey: "final-transfer-key",
      configTransferMode: "activation-manifest",
    });
    expect(calls[7]?.body).toMatchObject({
      mode: "final",
      targetHost: "10.0.0.2",
      targetPort: 30873,
      includeActivationManifest: true,
      configTransferMode: "activation-manifest",
    });
    expect(calls[8]?.body).toMatchObject({
      mode: "final",
      loadStrategy: "expedited",
      configTransferMode: "activation-manifest",
    });
    expect(calls[10]?.body).toEqual({
      migrationId: "surge-default-new",
      targetPodUid: "new",
    });
    expect(randomKey).toHaveBeenCalledTimes(2);
  });

  it("converges a Builder system config before final import and clears only target migration observation on convergence failure", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "state" }));
      }
      if (url.includes("/flush/")) {
        return new Response(JSON.stringify({ error: "flush failed" }), { status: 500 });
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      randomKey: vi.fn()
        .mockReturnValueOnce("keys-transfer-key")
        .mockReturnValueOnce("final-transfer-key"),
      log: vi.fn(),
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "standard",
      configTransferMode: "configured-builder-system-config",
      expectedSystemConfigCommit: "a".repeat(40),
    })).rejects.toThrow("flush pod=new-pod: 500");

    expect(calls.map((call) => call.url)).toEqual([
      "http://10.0.0.2:3003/prepare-rsync-import/default",
      "http://10.0.0.1:3003/push-rsync-state/default",
      "http://10.0.0.2:3003/finish-rsync-import/default",
      "http://10.0.0.2:3003/flush/default",
      "http://10.0.0.2:3003/abort-rsync-import/default",
    ]);
    expect(calls[3]?.body).toEqual({
      migrationId: "surge-default-new",
      slug: "alice",
      reason: "migration-converge",
      expectedSystemConfigCommit: "a".repeat(40),
    });
    expect(calls[4]?.body).toEqual({
      migrationId: "surge-default-new",
      slug: "alice",
      rpcPhase: "abort-rsync-import",
      mode: "final",
      configTransferMode: "configured-builder-system-config",
    });
    expect(calls.some((call) => call.url.includes("/unmount/"))).toBe(false);
  });

  it("continues a legacy target convergence only after its exact config checkpoint succeeded", async () => {
    const calls: SurgeTransportCall[] = [];
    const log = vi.fn();
    const expectedSystemConfigCommit = "a".repeat(40);
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "state" }));
      }
      if (url.includes("/flush/")) {
        return new Response(JSON.stringify({
          migrationId: "surge-default-new",
          slug: "alice",
          ok: false,
          durationMs: 12,
          systemConfigCommit: expectedSystemConfigCommit,
          steps: [
            { name: "session-quiesce", status: "skipped", durationMs: 0 },
            {
              name: "workspace-git",
              status: "failed",
              error: "[git-sync] durable flush failed: alice: git metadata is missing",
              durationMs: 1,
            },
            { name: "blob-sync", status: "skipped", durationMs: 0 },
            { name: "system-config", status: "done", durationMs: 11 },
            { name: "gitea-key-release", status: "skipped", durationMs: 0 },
          ],
        }), { status: 500 });
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      randomKey: vi.fn()
        .mockReturnValueOnce("keys-transfer-key")
        .mockReturnValueOnce("final-transfer-key"),
      allowLegacyConfiguredBuilderConvergence: true,
      log,
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "standard",
      configTransferMode: "configured-builder-system-config",
      expectedSystemConfigCommit,
    })).resolves.toBeUndefined();

    expect(calls.map((call) => [call.url, call.body?.mode, call.body?.rpcPhase])).toEqual([
      ["http://10.0.0.2:3003/prepare-rsync-import/default", "keys", "prepare-rsync-import"],
      ["http://10.0.0.1:3003/push-rsync-state/default", "keys", "push-rsync-state"],
      ["http://10.0.0.2:3003/finish-rsync-import/default", "keys", "finish-rsync-import"],
      ["http://10.0.0.2:3003/flush/default", undefined, undefined],
      ["http://10.0.0.2:3003/prepare-rsync-import/default", "final", "prepare-rsync-import"],
      ["http://10.0.0.1:3003/push-rsync-state/default", "final", "push-rsync-state"],
      ["http://10.0.0.2:3003/finish-rsync-import/default", "final", "finish-rsync-import"],
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "target config converged before import; continuing to materialize missing workspace pod=new-pod slug=alice",
    ));
  });

  it("keeps even the exact legacy convergence response fenced unless the TEST bridge is enabled", async () => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "state" }));
      }
      if (url.includes("/flush/")) {
        return new Response(JSON.stringify({
          migrationId: "surge-default-new",
          slug: "alice",
          ok: false,
          durationMs: 12,
          systemConfigCommit: expectedSystemConfigCommit,
          steps: [
            { name: "session-quiesce", status: "skipped", durationMs: 0 },
            {
              name: "workspace-git",
              status: "failed",
              error: "[git-sync] durable flush failed: alice: git metadata is missing",
              durationMs: 1,
            },
            { name: "blob-sync", status: "skipped", durationMs: 0 },
            { name: "system-config", status: "done", durationMs: 11 },
            { name: "gitea-key-release", status: "skipped", durationMs: 0 },
          ],
        }), { status: 500 });
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      randomKey: vi.fn()
        .mockReturnValueOnce("keys-transfer-key")
        .mockReturnValueOnce("final-transfer-key"),
      log: vi.fn(),
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "standard",
      configTransferMode: "configured-builder-system-config",
      expectedSystemConfigCommit,
    })).rejects.toThrow("flush pod=new-pod: 500");

    const paths = fetch.mock.calls.map(([input]) => String(input));
    expect(paths.filter((path) => path.includes("/prepare-rsync-import/")).length).toBe(1);
    expect(paths).toContain("http://10.0.0.2:3003/abort-rsync-import/default");
  });

  it.each([
    ["a different accepted config commit", {
      systemConfigCommit: "b".repeat(40),
    }],
    ["another failed durability step", {
      steps: [
        { name: "session-quiesce", status: "skipped", durationMs: 0 },
        {
          name: "workspace-git",
          status: "failed",
          error: "[git-sync] durable flush failed: alice: git metadata is missing",
          durationMs: 1,
        },
        { name: "blob-sync", status: "failed", error: "blob failure", durationMs: 1 },
        { name: "system-config", status: "done", durationMs: 11 },
        { name: "gitea-key-release", status: "skipped", durationMs: 0 },
      ],
    }],
  ])("keeps legacy convergence fenced when it reports %s", async (_label, overrides) => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "state" }));
      }
      if (url.includes("/flush/")) {
        return new Response(JSON.stringify({
          migrationId: "surge-default-new",
          slug: "alice",
          ok: false,
          durationMs: 12,
          systemConfigCommit: expectedSystemConfigCommit,
          steps: [
            { name: "session-quiesce", status: "skipped", durationMs: 0 },
            {
              name: "workspace-git",
              status: "failed",
              error: "[git-sync] durable flush failed: alice: git metadata is missing",
              durationMs: 1,
            },
            { name: "blob-sync", status: "skipped", durationMs: 0 },
            { name: "system-config", status: "done", durationMs: 11 },
            { name: "gitea-key-release", status: "skipped", durationMs: 0 },
          ],
          ...overrides,
        }), { status: 500 });
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      randomKey: vi.fn()
        .mockReturnValueOnce("keys-transfer-key")
        .mockReturnValueOnce("final-transfer-key"),
      allowLegacyConfiguredBuilderConvergence: true,
      log: vi.fn(),
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "standard",
      configTransferMode: "configured-builder-system-config",
      expectedSystemConfigCommit,
    })).rejects.toThrow("flush pod=new-pod: 500");

    const paths = fetch.mock.calls.map(([input]) => String(input));
    expect(paths.filter((path) => path.includes("/prepare-rsync-import/")).length).toBe(1);
    expect(paths).toContain("http://10.0.0.2:3003/abort-rsync-import/default");
  });

  it("does not transfer final state when the key transfer fails", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.includes("/prepare-rsync-import/")) {
        return new Response(JSON.stringify({ port: 30873, host: "0.0.0.0", module: "octogee-import" }));
      }
      if (url.includes("/push-rsync-state/") && body?.mode === "keys") {
        return new Response(JSON.stringify({ error: "key export missing" }), { status: 404 });
      }
      return new Response(JSON.stringify({ imported: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      randomKey: () => "transfer-key",
      log: vi.fn(),
    });

    await expect(transport.transfer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      sourcePod: source,
      targetPod: target,
      loadStrategy: "standard",
      configTransferMode: "activation-manifest",
    })).rejects.toThrow(/push-rsync-state.*404/u);

    expect(calls.map((call) => [call.url, call.body?.mode, call.body?.rpcPhase])).toEqual([
      ["http://10.0.0.2:3003/prepare-rsync-import/default", "keys", "prepare-rsync-import"],
      ["http://10.0.0.1:3003/push-rsync-state/default", "keys", "push-rsync-state"],
      ["http://10.0.0.2:3003/abort-rsync-import/default", "keys", "abort-rsync-import"],
    ]);
  });

  it("retries signed target cleanup once after a structured config hash race", async () => {
    let attempts = 0;
    const log = vi.fn();
    const fetch = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(JSON.stringify({
          error: "unmount failed",
          message: "config changed",
          code: "hash-mismatch",
        }), { status: 500 })
        : new Response(JSON.stringify({ unmounted: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.discardTargetCustomer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying signed unmount once"));
  });

  it("does not retry target cleanup after an unstructured or permanent failure", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: "unmount failed",
      message: "account removal rejected",
      code: "invalid-patch",
    }), { status: 500 })) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.discardTargetCustomer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).rejects.toThrow("invalid-patch");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops after the single bounded retry when the config hash keeps racing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: "unmount failed",
      message: "config changed",
      code: "hash-mismatch",
    }), { status: 500 })) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.discardTargetCustomer({
      gatewayId: "default",
      slug: "alice",
      operationId: "surge-default-new",
      targetPod: target,
    })).rejects.toThrow("hash-mismatch");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a latched runtime as booting when the live OpenClaw probe is down", async () => {
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "pod-uid", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({ status: "ready", version: "new", customers: [] }));
      }
      return new Response(JSON.stringify({
        handoffReleased: true,
        openclawUp: false,
      }), { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toEqual({
      status: "booting",
      version: "new",
      fleetSignatureCapability: "gateway-scoped",
      handoffReleased: true,
      prelaunchState: "none",
      mountedCustomers: [],
    });
  });

  it("carries a held prelaunch surge report so a stopped Builder target stays transferable", async () => {
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "pod-uid", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({ status: "ready", version: "new", customers: [] }));
      }
      return new Response(JSON.stringify({
        handoffReleased: false,
        openclawUp: false,
        prelaunchState: "hydrated",
      }), { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toMatchObject({
      status: "booting",
      prelaunchState: "hydrated",
    });
  });

  it("stops, resumes, reserves, and unreserves Builder OpenClaw through the process endpoints", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });
    const base = {
      gatewayId: GATEWAY_ID,
      slug: "alice",
      operationId: "surge-gw-a-target",
    };

    await transport.stopSourceOpenClaw!({ ...base, sourcePod: source, targetPod: target });
    await transport.resumeSourceOpenClaw!({ ...base, sourcePod: source, targetPod: target });
    await transport.holdTargetOpenClaw!({ ...base, targetPod: target });
    await transport.unreserveTargetOpenClaw!({ ...base, targetPod: target });

    expect(calls.map((call) => call.path)).toEqual([
      `/hold-surge-openclaw/${GATEWAY_ID}`,
      `/resume-surge-openclaw/${GATEWAY_ID}`,
      `/hold-surge-openclaw/${GATEWAY_ID}`,
      `/unreserve-surge-openclaw/${GATEWAY_ID}`,
    ]);
    for (const call of calls) {
      expect(call.body).toEqual({
        migrationId: "surge-gw-a-target",
        slug: "alice",
        targetPodUid: target.uid,
      });
    }
  });

  it("names the missing process-control capability when a pod predates the endpoint", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.stopSourceOpenClaw!({
      gatewayId: GATEWAY_ID,
      slug: "alice",
      operationId: "surge-gw-a-target",
      sourcePod: source,
      targetPod: target,
    })).rejects.toThrow("lacks the required surge OpenClaw hold endpoint");
  });

  it("rejects pod health that does not prove the mounted customer inventory", async () => {
    const log = vi.fn();
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "pod-uid", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({ status: "ready", version: "new" }));
      }
      return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("invalid fleet state response"));
  });

  it("reads the roster and image tag from the signed fleet state, not the slim /health probe", async () => {
    const calls: SurgeTransportCall[] = [];
    const fetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      });
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "new", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({
          status: "ready",
          version: "new",
          customers: ["alice", "alice", "bob"],
        }));
      }
      return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log: vi.fn(),
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toEqual({
      status: "ready",
      version: "new",
      fleetSignatureCapability: "gateway-scoped",
      handoffReleased: false,
      prelaunchState: "none",
      mountedCustomers: ["alice", "bob"],
    });
    const fleetStateCall = calls.find((call) => call.url.includes("/fleet-state/"));
    expect(fleetStateCall?.url).toBe(`http://10.0.0.2:3003/fleet-state/${GATEWAY_ID}`);
    expect(fleetStateCall?.body).toMatchObject({ gatewayId: GATEWAY_ID });
  });

  it("refuses a legacy health payload before any gateway-scoped signed exchange", async () => {
    const calls: string[] = [];
    const log = vi.fn();
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({
          status: "ready",
          gatewayId: GATEWAY_ID,
          version: "old",
          customers: ["alice"],
        }));
      }
      return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.readPodHealth(source, GATEWAY_ID)).resolves.toEqual({
      status: "ready",
      version: "old",
      fleetSignatureCapability: "legacy",
      handoffReleased: false,
      prelaunchState: "none",
      mountedCustomers: ["alice"],
    });
    await expect(transport.quiesce({
      gatewayId: GATEWAY_ID,
      slug: "alice",
      operationId: "surge-gw-a-new",
      sourcePod: source,
    })).rejects.toBeInstanceOf(SurgeGatewayScopedSignatureCapabilityMissingError);
    await expect(transport.readPodHealth(source, GATEWAY_ID)).resolves.toMatchObject({
      fleetSignatureCapability: "legacy",
    });

    expect(calls.every((url) => !url.includes("/fleet-state/") && !url.includes("/quiesce/"))).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("predates the gateway-scoped fleet signature protocol"));
  });

  it("names an unsigned-read rejection so a fleet key skew is not read as an absent pod", async () => {
    const log = vi.fn();
    const fetch = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ready", podUid: "new", startedAt: 1 }));
      }
      if (url.includes("/fleet-state/")) {
        return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 });
      }
      return new Response(JSON.stringify({ handoffReleased: false, openclawUp: true }));
    }) as unknown as typeof globalThis.fetch;
    const transport = createSurgePodTransport({
      privateKey: FLEET_KEY_PAIR.privateKey,
      fetch,
      log,
    });

    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toBeNull();
    await expect(transport.readPodHealth(target, GATEWAY_ID)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("does not match Cowboy's signing key"),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
