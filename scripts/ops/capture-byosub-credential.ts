

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";

const ENVS = new Set(["test", "prod"]);
const SAFE_ID = /^[a-z0-9-]+$/; 
const SAFE_UID = /^[A-Za-z0-9_-]+$/; 
const USAGE =
  "Usage: tsx scripts/ops/capture-byosub-credential.ts --env=test|prod --gateway=<id> --agent=<agentId> --provider=openai --uid=<uid> --file=<path>";

export interface CaptureArgs {
  env: "test" | "prod";
  gateway: string;
  agent: string;
  provider: "openai";
  uid: string;
  file: string;
}

export function parseCaptureArgs(argv: string[]): CaptureArgs {
  let env = "";
  let gateway = "";
  let agent = "";
  let provider = "";
  let uid = "";
  let file = "";
  for (const a of argv) {
    if (a.startsWith("--env=")) env = a.slice("--env=".length);
    else if (a.startsWith("--gateway=")) gateway = a.slice("--gateway=".length);
    else if (a.startsWith("--agent=")) agent = a.slice("--agent=".length);
    else if (a.startsWith("--provider=")) provider = a.slice("--provider=".length);
    else if (a.startsWith("--uid=")) uid = a.slice("--uid=".length);
    else if (a.startsWith("--file=")) file = a.slice("--file=".length);
    else throw new Error(`Unknown arg: ${a}\n${USAGE}`);
  }
  if (!ENVS.has(env)) throw new Error(`--env must be test|prod (got: '${env}')\n${USAGE}`);
  if (!SAFE_ID.test(gateway)) {
    throw new Error(`--gateway must match [a-z0-9-]+ (got: '${gateway}')\n${USAGE}`);
  }
  if (!SAFE_ID.test(agent)) {
    throw new Error(`--agent must match [a-z0-9-]+ — path-safe (got: '${agent}')\n${USAGE}`);
  }
  if (provider === "anthropic") {
    throw new Error(
      `--provider=anthropic uses the product Claude SSO flow; this tool captures only OpenAI auth.json\n${USAGE}`,
    );
  }
  if (provider !== "openai") {
    throw new Error(`--provider must be openai (got: '${provider}')\n${USAGE}`);
  }
  if (!SAFE_UID.test(uid)) {
    throw new Error(`--uid is required and must match [A-Za-z0-9_-]+\n${USAGE}`);
  }
  if (!file) throw new Error(`--file is required\n${USAGE}`);
  return { env: env as "test" | "prod", gateway, agent, provider: "openai", uid, file };
}

export function secretNameFor(uid: string, provider: string): string {
  return `byosub-${uid}-${provider}`;
}

export function gatewayByosubPatch(
  agent: string,
  provider: "openai",
  secretName: string,
): Record<string, unknown> {
  return {
    byosub: {
      [agent]: {
        providers: {
          [provider]: {
            provider,
            secretName,
            status: "connected",
            modelCredentialProvider: "openai-codex",
          },
        },
      },
    },
  };
}

export function validateCredentialPayload(
  provider: string,
  raw: string,
):
  | { ok: true }
  | { ok: false; reason: string } {
  if (!raw || !raw.trim()) return { ok: false, reason: "empty payload" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "not a JSON object" };
  }
  if (provider === "openai") {
    const o = parsed as Record<string, unknown>;
    if (!o.tokens || typeof o.tokens !== "object") {
      return {
        ok: false,
        reason: "not a codex auth.json (missing tokens object)",
      };
    }
    return { ok: true };
  }
  return { ok: false, reason: `unsupported provider ${provider}` };
}

async function main(): Promise<void> {
  const args = parseCaptureArgs(process.argv.slice(2));

  let raw: string;
  try {
    raw = fs.readFileSync(args.file, "utf-8");
  } catch (e) {
    console.error(`--file is not readable: ${(e as Error).message}`);
    process.exit(1);
  }

  const v = validateCredentialPayload(args.provider, raw);
  if (!v.ok) {
    console.error(`refusing to capture — invalid credential: ${v.reason}`);
    process.exit(1);
  }

  const envSuffix = args.env === "prod" ? "" : `-${args.env}`;
  const project = args.env === "prod" ? "octogee" : `octogee-${args.env}`;
  const saPath = path.join(
    process.env.HOME ?? "",
    `.openclaw/secrets/octogee${envSuffix}-sa-key.json`,
  );
  if (!fs.existsSync(saPath)) {
    console.error(`SA key not found at ${saPath}`);
    process.exit(1);
  }
  process.env.GCP_PROJECT_ID = project;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
  initializeApp({
    credential: cert(JSON.parse(fs.readFileSync(saPath, "utf-8"))),
    projectId: project,
  });
  const db = getFirestore();

  const secretName = secretNameFor(args.uid, args.provider);
  const { writeSecret } = await import("../lib/secret-manager.js");
  const { versionName } = await writeSecret({
    name: secretName,
    value: raw,
    labels: { byosub: "true", provider: args.provider },
  });

  await db
    .collection("glmGateways")
    .doc(args.gateway)
    .set(gatewayByosubPatch(args.agent, args.provider, secretName), { merge: true });

  console.log(
    `[capture-byosub] stored ${secretName} (${versionName}) + glmGateways/${args.gateway}.byosub[${args.agent}] → ${args.provider}`,
  );
}

const isEntrypoint =
  (process.argv[1] && process.argv[1].endsWith("capture-byosub-credential.ts")) ||
  process.argv[1]?.endsWith("capture-byosub-credential.js");
if (isEntrypoint) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[capture-byosub] ${err.message}`);
      process.exit(1);
    });
}
