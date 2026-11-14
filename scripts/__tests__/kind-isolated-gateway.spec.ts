import { describe, expect, it } from "vitest";
import {
  IDENTITY_FAILURE,
  POD_PROFILE,
  identityReady,
  lastIdentityFailure,
  redactSecrets,
  run,
} from "../ops/kind-isolated-gateway.mjs";

const MODEL = "platform-openrouter/meta/muse-ember";
const BOT = "bot-user-id";
const ISOLATED = "b-lin-1";
const BOOT_FILE = "/home/node/.openclaw/workspace-identity-boot";
const READY_FILE = "/home/node/.openclaw/workspace-identity-ready";
const FAILURE_LINE = `2026-11-13T10:00:02Z [octogee-identity-tools] ${IDENTITY_FAILURE}: Error: OpenClaw returned no profile for uid-1`;

interface Scenario {
  identityReadyAfterBoot?: boolean;
  identityReadyAfterResume?: boolean;
  log?: string;
  lastError?: string | null;
  homeSurvives?: boolean;
  gatewayStartsAfterMs?: number;
  markerReadError?: string;
  previousLog?: string;
  kubernetes?: { pods?: unknown[]; events?: unknown[]; networkPolicies?: unknown[] };
}

const RESUMED_PROCESS_STARTS_MS = 30_000;

function cluster(scenario: Scenario = {}) {
  let now = 0;
  const events: string[] = [];
  const sql: Array<{ sql: string; variables: Record<string, string> }> = [];
  let mounted = "shared-a";
  let isolatedMounted: string[] = [];
  let staleHeartbeats = 0;
  let pods = 0;
  let claim: string | null = null;
  let boots = 0;
  let resumedProcessStartsAt: number | null = null;
  let runningFrom = 0;
  const running = () => pods > 0 && now >= runningFrom;
  const home = new Map<string, string>();
  let sent = 0;

  const boot = (identityReady: boolean) => {
    boots += 1;
    pods = 1;
    claim = "Bound";
    if (scenario.homeSurvives === false) home.clear();
    home.set(BOOT_FILE, `boot-${boots}`);
    if (identityReady) home.set(READY_FILE, `boot-${boots}`);
    mounted = ISOLATED;
    isolatedMounted = ["lin"];
  };
  const settle = () => {
    if (resumedProcessStartsAt === null || now < resumedProcessStartsAt) return;
    resumedProcessStartsAt = null;
    boot(scenario.identityReadyAfterResume !== false);
  };

  const deps = {
    log: () => {},
    clock: { now: () => now, sleep: async (ms: number) => { now += ms; } },
    fleet: (args: string[]) => {
      settle();
      events.push(args.slice(0, 3).join(" "));
      const [noun, verb] = args;
      if (noun === "gateway" && verb === "ls") {
        if (staleHeartbeats > 0 && --staleHeartbeats === 0) isolatedMounted = [];
        return { gateways: [
          { gatewayId: "shared-a", status: "ready", mountedUsers: mounted === "shared-a" ? ["lin"] : [] },
          ...(claim === null && boots > 0 ? [] : [{
            gatewayId: ISOLATED, status: "starting", mountedUsers: isolatedMounted,
            lastError: { message: scenario.lastError ?? null, at: null },
          }]),
        ] };
      }
      if (noun === "user" && verb === "ls") return { users: [{ id: "uid-1", name: "lin", assignedGatewayId: "shared-a" }] };
      if (noun === "user" && verb === "inspect") {
        return { user: { id: "uid-1", name: "lin", provisioningStatus: "complete", mountedGatewayId: mounted } };
      }
      if (noun === "user" && verb === "migrate" && args[2] === "lin" && args[3] === "--to-isolated=pod-s") {
        runningFrom = now + (scenario.gatewayStartsAfterMs ?? 0);
        boot(scenario.identityReadyAfterBoot !== false);
        return { dryRun: false, response: { uid: "uid-1", gatewayId: ISOLATED, operationId: "op-1" } };
      }
      if (noun === "user" && verb === "migrate" && args[3] === "--to=shared-a") {
        mounted = "shared-a";
        staleHeartbeats = 2;
        return { dryRun: false, response: {} };
      }
      if (noun === "user" && verb === "issue-passwords") {
        return { dryRun: false, response: { chat: { username: "lin", password: "chat-pass" }, git: { username: "ws-lin", password: "git" } } };
      }
      if (noun === "gateway" && verb === "park") { pods = 0; mounted = "none"; return { dryRun: false, response: {} }; }
      if (noun === "gateway" && verb === "resume") {
        pods = 1;
        runningFrom = now;
        resumedProcessStartsAt = now + RESUMED_PROCESS_STARTS_MS;
        return { dryRun: false, response: {} };
      }
      if (noun === "gateway" && verb === "retire") {
        if (isolatedMounted.length > 0) {
          throw new Error(`octogee-fleet --env=kind gateway retire ${ISOLATED} --apply exited with 1: gateway ${ISOLATED} still has mounted users: ${isolatedMounted.join(", ")}`);
        }
        pods = 0;
        claim = null;
        return { dryRun: false, response: {} };
      }
      throw new Error(`unexpected fleet call ${args.join(" ")}`);
    },
    sql: (query: string, variables: Record<string, string>) => {
      sql.push({ sql: query, variables });
      if (query.includes("model_broker_usage_events")) {
        return JSON.stringify({ provider: "openrouter", model: "meta/muse-ember", gatewayId: ISOLATED, upstreamStatus: 200, totalTokens: 900, costUsd: 0.0001 });
      }
      return "";
    },
    waitForGatewayPod: () => "",
    signIn: async () => ({
      get: async (path: string) => {
        if (path === "/api/v4/users/username/lin-coach") return { id: BOT, username: "lin-coach" };
        if (path === "/api/v4/users/me/teams") return [{ id: "team-1" }];
        if (path === "/api/v4/teams/team-1/channels/name/lin-coach") return { id: "channel-1" };
        if (path.startsWith("/api/v4/channels/channel-1/posts?since=")) {
          return { posts: { reply: { id: "reply", user_id: BOT, create_at: sent + 1, message: "I can hear you." } } };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      post: async () => {
        events.push("chat post");
        sent = now;
        return { id: "sent", create_at: sent };
      },
    }),
    setSizingProfile: (name: string, profile: unknown) => { events.push(`sizing set ${name}`); expect(profile).toEqual(POD_PROFILE); },
    readGatewayFile: (gatewayId: string, path: string) => {
      settle();
      expect(gatewayId).toBe(ISOLATED);
      if (!running()) throw new Error(`container "gateway" of ${gatewayId} is not running`);
      if (path === BOOT_FILE || path === READY_FILE) {
        events.push("identity read");
        if (scenario.markerReadError) throw new Error(scenario.markerReadError);
      }
      return home.get(path) ?? null;
    },
    writeGatewayFile: (_gatewayId: string, path: string, content: string) => { home.set(path, content); },
    gatewayLog: () => scenario.log ?? "",
    previousGatewayLog: () => {
      if (scenario.previousLog === undefined) throw new Error("previous terminated container \"gateway\" not found");
      return scenario.previousLog;
    },
    gatewayPods: () => scenario.kubernetes?.pods ?? [],
    gatewayEvents: () => scenario.kubernetes?.events ?? [],
    networkPolicies: () => scenario.kubernetes?.networkPolicies ?? [],
    homeClaimPhase: () => claim,
    gatewayPodCount: () => pods,
    gatewayRunning: () => { settle(); return running(); },
  };
  return { deps, events, sql };
}

const options = { fleet: "octogee-fleet", gateway: "shared-a", user: "lin", model: MODEL, replyTimeoutMs: 300_000, state: "/state/isolated" };

describe("kind isolated gateway smoke", () => {
  it("gives the user a pod gateway, requires its workspace identities before the Coach round trip, keeps the home through park and resume, then returns and retires it", async () => {
    const { deps, events, sql } = cluster();

    const result = await run(deps, options);

    expect(result.gatewayId).toBe(ISOLATED);
    expect(events).toContain("sizing set pod-s");
    expect(events.indexOf("sizing set pod-s")).toBeLessThan(events.indexOf("user migrate lin"));
    expect(events.indexOf("identity read")).toBeLessThan(events.indexOf("chat post"));
    expect(events.filter(event => event.startsWith("gateway park") || event.startsWith("gateway resume") || event.startsWith("gateway retire")))
      .toEqual([`gateway park ${ISOLATED}`, `gateway resume ${ISOLATED}`, `gateway retire ${ISOLATED}`]);
    expect(sql.find(entry => entry.sql.includes("model_broker_usage_events"))?.variables).toMatchObject({ gateway: ISOLATED });
    expect(result.evidence).toMatchObject({ calls: 1, provider: "openrouter", model: "meta/muse-ember" });
  });

  it("fails before the Coach round trip when the gateway never marks its identities ready, with the gateway's last identity failure", async () => {
    const log = ["boot", `${IDENTITY_FAILURE}: Error: first`, "retrying", FAILURE_LINE, "idle"].join("\n");
    const { deps, events } = cluster({ identityReadyAfterBoot: false, log });

    await expect(run(deps, options)).rejects.toThrow(
      `Timed out after 900s waiting for ${ISOLATED} to mark its workspace identities ready for this boot. `
        + `Last identity failure in the gateway log: ${FAILURE_LINE}`,
    );
    expect(events).not.toContain("chat post");
  });

  it("says when the gateway log has no identity failure, and names what blocks the gateway", async () => {
    const { deps } = cluster({ identityReadyAfterBoot: false, lastError: "the isolated gateway image is linux/amd64 only, and this cluster has no amd64 node" });

    await expect(run(deps, options)).rejects.toThrow(
      `The gateway log has no "${IDENTITY_FAILURE}" line. `
        + `${ISOLATED} is blocked: the isolated gateway image is linux/amd64 only, and this cluster has no amd64 node`,
    );
  });

  it("adds the pod's status, its events, the network policies that select it and the gateway log's redacted tail to a failure", async () => {
    const pod = {
      metadata: { name: `octogee-gateway-${ISOLATED}-b7db69b87-lbr56`, labels: { app: "octogee-gateway", "gateway-instance": ISOLATED } },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "gateway", ready: false, restartCount: 1,
            state: { running: { startedAt: "2026-11-14T03:51:58Z" } },
            lastState: { terminated: { exitCode: 137, reason: "Error", finishedAt: "2026-11-14T03:51:56Z" } },
          },
          { name: "gateway-edge", ready: true, restartCount: 0, state: { running: { startedAt: "2026-11-14T03:41:12Z" } } },
        ],
      },
    };
    const events = [
      {
        type: "Normal", reason: "Killing", lastTimestamp: "2026-11-14T03:51:37Z",
        involvedObject: { kind: "Pod", name: pod.metadata.name }, message: "Container gateway failed startup probe, will be restarted",
      },
      {
        type: "Warning", reason: "Unhealthy", lastTimestamp: "2026-11-14T03:46:57Z", count: 30,
        involvedObject: { kind: "Pod", name: pod.metadata.name }, message: "Startup probe failed: connect: connection refused",
      },
    ];
    const networkPolicies = [
      {
        metadata: { name: `octogee-gateway-apiserver-egress-${ISOLATED}` },
        spec: { podSelector: { matchLabels: { app: "octogee-gateway", "gateway-instance": ISOLATED } }, policyTypes: ["Egress"] },
      },
      {
        metadata: { name: "isolated-gateways" },
        spec: { podSelector: { matchExpressions: [{ key: "gateway-instance", operator: "In", values: [ISOLATED] }] }, ingress: [] },
      },
      {
        metadata: { name: "shared-a-ingress" },
        spec: { podSelector: { matchLabels: { app: "octogee-gateway", "gateway-instance": "shared-a" } }, policyTypes: ["Ingress"] },
      },
    ];
    const log = [
      "[entrypoint] Pre-boot: reading user identity",
      "[builder-identity] broker read failed: fetch failed",
      "[entrypoint] Pre-boot: User identity unavailable; retrying in 5s...",
      "[mm] connecting with authorization: Bearer mm-session-1f2e3d",
    ].join("\n");
    const previousLog = "[provisioner] issued token=gitea-token-9a8b7c for lin";
    const { deps } = cluster({ identityReadyAfterBoot: false, log, previousLog, kubernetes: { pods: [pod], events, networkPolicies } });

    const failure = await run(deps, options).then(() => null, (error: Error) => error.message);

    expect(failure).toContain(`Timed out after 900s waiting for ${ISOLATED} to mark its workspace identities ready for this boot`);
    expect(failure).toContain(`pod ${pod.metadata.name}: Running`);
    expect(failure).toContain("gateway: not ready, 1 restarts, running since 2026-11-14T03:51:58Z, last exited 137 (Error) at 2026-11-14T03:51:56Z");
    expect(failure).toContain("gateway-edge: ready, 0 restarts, running since 2026-11-14T03:41:12Z");
    expect(failure.indexOf("Unhealthy")).toBeLessThan(failure.indexOf("Killing"));
    expect(failure).toContain(`2026-11-14T03:46:57Z Warning Unhealthy pod/${pod.metadata.name} (30 times): Startup probe failed: connect: connection refused`);
    expect(failure).toContain(`octogee-gateway-apiserver-egress-${ISOLATED} (Egress)`);
    expect(failure).toContain("isolated-gateways (Ingress)");
    expect(failure).not.toContain("shared-a-ingress");
    expect(failure).toContain("[builder-identity] broker read failed: fetch failed");
    expect(failure).toContain("previous gateway container");
    expect(failure).not.toContain("mm-session-1f2e3d");
    expect(failure).not.toContain("gitea-token-9a8b7c");
  });

  it("still fails with the original error when the diagnostics cannot be read", async () => {
    const { deps } = cluster({ identityReadyAfterBoot: false });
    const broken = {
      ...deps,
      gatewayPods: () => { throw new Error("kubectl get pods exited with 1: connection refused"); },
      networkPolicies: () => { throw new Error("kubectl get networkpolicies exited with 1: forbidden"); },
    };

    const failure = await run(broken, options).then(() => null, (error: Error) => error.message);

    expect(failure).toContain(`Timed out after 900s waiting for ${ISOLATED} to mark its workspace identities ready for this boot`);
    expect(failure).toContain("could not be read: kubectl get pods exited with 1: connection refused");
    expect(failure).toContain("could not be read: kubectl get networkpolicies exited with 1: forbidden");
  });

  it("fails when the home does not survive park and resume", async () => {
    const { deps, events } = cluster({ homeSurvives: false });

    await expect(run(deps, options)).rejects.toThrow(`${ISOLATED} lost its home across park and resume`);
    expect(events).not.toContain(`gateway retire ${ISOLATED}`);
  });

  it("does not take the previous boot's identity markers, which the home keeps through park, as the resumed boot's", async () => {
    const { deps, events } = cluster({ identityReadyAfterResume: false });

    await expect(run(deps, options)).rejects.toThrow(
      `Timed out after 900s waiting for ${ISOLATED} to mark its workspace identities ready for this boot`,
    );
    expect(events.filter(event => event === "user migrate lin")).toHaveLength(1);
  });

  it("waits through a gateway container that has not started yet without counting it as a marker read failure", async () => {
    const { deps } = cluster({ gatewayStartsAfterMs: 120_000 });

    await expect(run(deps, options)).resolves.toMatchObject({ gatewayId: ISOLATED });
  });

  it("fails fast when the markers cannot be read three times in a row while the gateway container runs", async () => {
    const { deps, events } = cluster({ markerReadError: "error: unable to upgrade connection: Forbidden" });

    const failure = await run(deps, options).then(() => null, (error: Error) => error.message);

    expect(failure).toContain(`${ISOLATED}'s gateway container is running, but its identity markers could not be read 3 times in a row. `);
    expect(failure).toContain("The last marker read failed: error: unable to upgrade connection: Forbidden");
    expect(events.filter(event => event === "identity read")).toHaveLength(3);
    expect(deps.clock.now()).toBeLessThan(60_000);
    expect(events).not.toContain("chat post");
  });
});

describe("identityReady", () => {
  it("needs this boot's marker, not an earlier boot's", () => {
    expect(identityReady({ boot: "boot-2", ready: "boot-2" })).toBe(true);
    expect(identityReady({ boot: "boot-2", ready: "boot-1" })).toBe(false);
    expect(identityReady({ boot: "boot-2", ready: null })).toBe(false);
    expect(identityReady({ boot: null, ready: null })).toBe(false);
  });

  it("needs a boot after the one before park, even when that earlier boot's markers still match", () => {
    expect(identityReady({ boot: "boot-1", ready: "boot-1" }, "boot-1")).toBe(false);
    expect(identityReady({ boot: "boot-2", ready: "boot-1" }, "boot-1")).toBe(false);
    expect(identityReady({ boot: "boot-2", ready: "boot-2" }, "boot-1")).toBe(true);
  });
});

describe("lastIdentityFailure", () => {
  it("takes the last failure line, or none", () => {
    expect(lastIdentityFailure(`a\n${IDENTITY_FAILURE}: one\nb\n${IDENTITY_FAILURE}: two\nc`)).toBe(`${IDENTITY_FAILURE}: two`);
    expect(lastIdentityFailure("a\nb")).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("hides bearer and basic credentials, tokens, keys, passwords and URL credentials, and leaves the rest", () => {
    expect(redactSecrets("authorization: Bearer abc.def-ghi")).toBe("authorization: Bearer [redacted]");
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [redacted]");
    expect(redactSecrets("ok eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl ok")).toBe("ok [redacted] ok");
    expect(redactSecrets("OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123")).toBe("OPENROUTER_API_KEY=[redacted]");
    expect(redactSecrets("key sk-or-v1-0123456789abcdef0123 used")).toBe("key [redacted] used");
    expect(redactSecrets('{"password":"chat-pass","user":"lin"}')).toBe('{"password":"[redacted]","user":"lin"}');
    expect(redactSecrets("clone http://ws-lin:git-pass@gitea:3000/x.git")).toBe("clone http://[redacted]@gitea:3000/x.git");
    expect(redactSecrets("[builder-identity] broker read failed: fetch failed")).toBe("[builder-identity] broker read failed: fetch failed");
  });
});
