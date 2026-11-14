#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  coachRoundTrip,
  command,
  kindDependencies,
  kubectlArgs,
  parseArgs,
  pinModel,
  placeOnSharedGateway,
  waitFor,
  waitForUserMount,
} from "./kind-agent-round-trip.mjs";

export const POD_SIZING_PROFILE = "pod-s";
export const POD_PROFILE = {
  isolation: "isolated",
  sizingTier: "s",
  computer: { runtime: "cluster", homeSizeGiB: 2 },
  fallbackStorageGb: null,
};
export const IDENTITY_FAILURE = "Workspace identity initialization failed";

const IDENTITY_BOOT = "/home/node/.openclaw/workspace-identity-boot";
const IDENTITY_READY = "/home/node/.openclaw/workspace-identity-ready";
const HOME_MARKER = "/home/node/kind-isolated-gateway-marker";
const BOOT_TIMEOUT_MS = 900_000;

const GATEWAY_LEDGER_SQL = `SELECT event::text FROM platform.model_broker_usage_events
WHERE event->>'gatewayId' = :'gateway' AND created_at >= :'since'::bigint ORDER BY created_at;
`;

export function identityReady({ boot, ready }, bootBeforePark = null) {
  return Boolean(boot) && boot === ready && boot !== bootBeforePark;
}

export function lastIdentityFailure(log) {
  return log.split("\n").filter(line => line.includes(IDENTITY_FAILURE)).at(-1)?.trim() ?? null;
}

function identityFailureNote(deps, gatewayId) {
  try {
    const line = lastIdentityFailure(deps.gatewayLog(gatewayId));
    return line ? `Last identity failure in the gateway log: ${line}` : `The gateway log has no "${IDENTITY_FAILURE}" line`;
  } catch (error) {
    return `The gateway log could not be read: ${error.message}`;
  }
}

function blockerNote(deps, gatewayId) {
  try {
    const gateway = (deps.fleet(["gateway", "ls"]).gateways ?? []).find(entry => entry.gatewayId === gatewayId);
    const blocker = gateway?.lastError?.message;
    return blocker ? `${gatewayId} is blocked: ${blocker}` : null;
  } catch (error) {
    return `${gatewayId}'s last error could not be read: ${error.message}`;
  }
}

export async function waitForWorkspaceIdentities(deps, gatewayId, bootBeforePark = null) {
  let readFailure = null;
  try {
    await waitFor(() => {
      try {
        const markers = {
          boot: deps.readGatewayFile(gatewayId, IDENTITY_BOOT),
          ready: deps.readGatewayFile(gatewayId, IDENTITY_READY),
        };
        readFailure = null;
        return identityReady(markers, bootBeforePark);
      } catch (error) {
        readFailure = error.message;
        return false;
      }
    }, { timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 10_000, label: `${gatewayId} to mark its workspace identities ready for this boot` }, deps.clock);
  } catch (error) {
    const notes = [
      error.message,
      identityFailureNote(deps, gatewayId),
      blockerNote(deps, gatewayId),
      readFailure && `The last marker read failed: ${readFailure}`,
    ];
    throw new Error(notes.filter(Boolean).join(". "));
  }
  deps.log(`${gatewayId} marked its workspace identities ready for this boot`);
}

function requireBoundHome(deps, gatewayId) {
  const phase = deps.homeClaimPhase(gatewayId);
  if (phase !== "Bound") throw new Error(`${gatewayId}'s home claim is ${phase ?? "missing"}, not Bound`);
}

export async function run(deps, options) {
  const { log, clock } = deps;
  pinModel(deps, options);
  await placeOnSharedGateway(deps, options);

  deps.setSizingProfile(POD_SIZING_PROFILE, POD_PROFILE);
  log(`Set sizing profile ${POD_SIZING_PROFILE} to a pod with a ${POD_PROFILE.computer.homeSizeGiB} GiB home`);
  const given = deps.fleet(["user", "migrate", options.user, `--to-isolated=${POD_SIZING_PROFILE}`, "--apply"]).response;
  const gatewayId = given?.gatewayId;
  if (typeof gatewayId !== "string" || gatewayId === "") {
    throw new Error(`user migrate --to-isolated=${POD_SIZING_PROFILE} answered without a gateway id`);
  }
  log(`Gave ${options.user} isolated gateway ${gatewayId}`);

  await waitForWorkspaceIdentities(deps, gatewayId);
  await waitForUserMount(deps, options, gatewayId);
  requireBoundHome(deps, gatewayId);
  const roundTrip = await coachRoundTrip(deps, options,
    { sql: GATEWAY_LEDGER_SQL, variables: { gateway: gatewayId }, caller: `isolated gateway ${gatewayId}` });

  const marker = `${gatewayId}-${clock.now()}`;
  deps.writeGatewayFile(gatewayId, HOME_MARKER, marker);
  const bootBeforePark = deps.readGatewayFile(gatewayId, IDENTITY_BOOT);
  deps.fleet(["gateway", "park", gatewayId, "--apply"]);
  await waitFor(() => deps.gatewayPodCount(gatewayId) === 0,
    { timeoutMs: 300_000, intervalMs: 5_000, label: `${gatewayId}'s pod to stop after park` }, clock);
  requireBoundHome(deps, gatewayId);
  log(`Parked ${gatewayId}; its pod stopped and its home claim stayed Bound`);

  deps.fleet(["gateway", "resume", gatewayId, "--apply"]);
  await waitForWorkspaceIdentities(deps, gatewayId, bootBeforePark);
  await waitForUserMount(deps, options, gatewayId);
  if (deps.readGatewayFile(gatewayId, HOME_MARKER) !== marker) {
    throw new Error(`${gatewayId} lost its home across park and resume: ${HOME_MARKER} no longer holds what was written before park`);
  }
  log(`Resumed ${gatewayId} with its home intact`);

  deps.fleet(["user", "migrate", options.user, `--to=${options.gateway}`, "--apply"]);
  await waitForUserMount(deps, options, options.gateway, BOOT_TIMEOUT_MS);
  await waitFor(() => {
    const gateway = (deps.fleet(["gateway", "ls"]).gateways ?? []).find(entry => entry.gatewayId === gatewayId);
    return Array.isArray(gateway?.mountedUsers) && gateway.mountedUsers.length === 0;
  }, { timeoutMs: 300_000, intervalMs: 10_000, label: `${gatewayId}'s heartbeat to report no mounted users after the return` }, clock);
  deps.fleet(["gateway", "retire", gatewayId, "--apply"]);
  await waitFor(() => deps.gatewayPodCount(gatewayId) === 0 && deps.homeClaimPhase(gatewayId) === null,
    { timeoutMs: 600_000, intervalMs: 5_000, label: `${gatewayId}'s pod and home claim to be deleted after retire` }, clock);
  log(`Returned ${options.user} to ${options.gateway} and retired ${gatewayId}; its home claim is gone`);
  return { gatewayId, ...roundTrip };
}

export function isolatedDependencies(base, options) {
  const kubectl = kubectlArgs(options.state);
  const deployment = gatewayId => `deployment/octogee-gateway-${gatewayId}`;
  const gatewayExec = (gatewayId, script, args, input) => command("kubectl",
    [...kubectl, "exec", ...(input === undefined ? [] : ["-i"]), deployment(gatewayId), "-c", "gateway", "--",
      "sh", "-c", script, "sh", ...args], { input });
  return {
    ...base,
    log: line => console.log(`[isolated-gateway] ${line}`),
    setSizingProfile: (name, profile) => {
      const file = join(base.scratch, `${name}.json`);
      writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
      base.fleet(["sizing", "set", name, `--file=${file}`, "--apply"]);
    },
    readGatewayFile: (gatewayId, path) => {
      const output = gatewayExec(gatewayId, 'if [ -e "$1" ]; then printf present; cat "$1"; else printf absent; fi', [path]);
      return output.startsWith("present") ? output.slice("present".length) : null;
    },
    writeGatewayFile: (gatewayId, path, content) => {
      gatewayExec(gatewayId, 'cat > "$1"', [path], content);
    },
    gatewayLog: gatewayId => command("kubectl", [...kubectl, "logs", deployment(gatewayId), "-c", "gateway", "--tail=5000"]),
    homeClaimPhase: gatewayId => command("kubectl",
      [...kubectl, "get", "pvc", `octogee-gateway-${gatewayId}-data`, "--ignore-not-found", "-o", "jsonpath={.status.phase}"])
      .trim() || null,
    gatewayPodCount: gatewayId => command("kubectl",
      [...kubectl, "get", "pods", "-l", `gateway-instance=${gatewayId}`, "-o", "name"])
      .split("\n").filter(Boolean).length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const base = await kindDependencies(options);
  try {
    const deps = isolatedDependencies(base, options);
    const { gatewayId } = await run(deps, options);
    deps.log(`Isolated gateway ${gatewayId} served ${options.user}, kept their home through park and resume, and retired cleanly`);
  } finally {
    base.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[isolated-gateway] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
