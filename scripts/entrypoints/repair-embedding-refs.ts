// Operator repair for shifted platform embedding SecretRefs on a live source
// pod (the r2→r8 roll wedge). Dry-run by default; logic + guards live in
// lib/embedding-ref-repair.ts (tested). Usage:
//
//   1. kubectl -n <ns> port-forward pod/<gateway-pod> 18789:18789
//   2. export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
//      export OPENCLAW_GATEWAY_TOKEN=$(kubectl -n <ns> get secret gateway-auth-token-<gateway> -o jsonpath='{.data.token}' | base64 -d)
//   3. kubectl -n <ns> exec <gateway-pod> -c gateway -- cat /home/octogee/.openclaw/openclaw.json > /tmp/gw-config.json
//      kubectl -n <ns> exec <gateway-pod> -c gateway -- ls /home/octogee/.openclaw/agents > /tmp/gw-agent-dirs.txt
//   4. npx tsx entrypoints/repair-embedding-refs.ts \
//        --project octogee-test --gateway default --revision default-r2 \
//        --config-file /tmp/gw-config.json --agent-dirs-file /tmp/gw-agent-dirs.txt [--apply]
//
// The tool refuses any revision the durable root does not select as
// live/traffic/roll-source, and refuses to apply while a platform-ref coach has
// no agent dir on the pod.

import * as fs from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { isGatewayDesiredDoc, type GatewayDoc } from "../../shared/types/gateway-releases.js";
import { createGatewayRpc } from "../lib/gateway-rpc.js";
import {
  repairTargetRevisionAllowed,
  runEmbeddingRefRepair,
} from "../lib/embedding-ref-repair.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArg(name: string): string {
  const value = argValue(name);
  if (!value) {
    console.error(`missing required --${name} (see header of this file for usage)`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const project = requiredArg("project");
  const gatewayId = requiredArg("gateway");
  const revisionId = requiredArg("revision");
  const configFile = requiredArg("config-file");
  const agentDirsFile = requiredArg("agent-dirs-file");
  const apply = process.argv.includes("--apply");

  const url = process.env.OPENCLAW_GATEWAY_URL;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!url || !token) {
    console.error("OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN must be set (port-forwarded pod RPC)");
    process.exit(2);
  }

  initializeApp({ projectId: project });
  const rootSnap = await getFirestore().collection("gateways").doc(gatewayId).get();
  const rootData = rootSnap.exists ? rootSnap.data() : undefined;
  if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== gatewayId) {
    console.error(`gateways/${gatewayId} in ${project} is missing or not a durable root — refusing`);
    process.exit(1);
  }
  const root = rootData as GatewayDoc;
  if (!repairTargetRevisionAllowed(root, revisionId)) {
    console.error(
      `revision ${revisionId} is not the live/traffic/roll-source revision of ${gatewayId} ` +
        `(stable instance=${root.gatewayId}) — refusing`,
    );
    process.exit(1);
  }

  const agentDirs = new Set(
    fs
      .readFileSync(agentDirsFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );

  const rpc = createGatewayRpc({ url, token });
  try {
    const result = await runEmbeddingRefRepair({
      rpc,
      readUnredactedConfig: async () => JSON.parse(fs.readFileSync(configFile, "utf8")) as unknown,
      agentDirExists: (agentId) => agentDirs.has(agentId),
      dryRun: !apply,
      log: (msg) => console.log(msg),
    });
    console.log(
      JSON.stringify(
        {
          gatewayId,
          revisionId,
          applied: result.applied,
          verified: result.verified,
          mismatched: result.plan.mismatched,
          absentAgentDirs: result.plan.absentAgentDirs,
        },
        null,
        2,
      ),
    );
    if (!apply && result.plan.mismatched.length > 0) {
      console.log("dry-run only — rerun with --apply to rebind");
    }
  } finally {
    try {
      await rpc.close();
    } catch {}
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
