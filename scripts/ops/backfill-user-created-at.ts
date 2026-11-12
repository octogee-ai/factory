import { pathToFileURL } from "node:url";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import type { PlatformStateStore, PlatformUserRecord } from "@octogee/core/platform-state";
import { initializeOperatorFirebaseAdmin } from "../lib/operator-firebase-admin.js";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";

export const BACKFILL_USER_CREATED_AT_USAGE =
  "Usage: npm run --prefix scripts with-platform-state -- --env=<test|prod> -- npx tsx ops/backfill-user-created-at.ts --env=<test|prod> [--apply]";

const ACCOUNT_READ_BATCH = 100;

export interface BackfillUserCreatedAtArgs {
  environment: "test" | "prod";
  apply: boolean;
}

export function parseBackfillUserCreatedAtArgs(argv: readonly string[]): BackfillUserCreatedAtArgs {
  const environment = argv.find((arg) => arg.startsWith("--env="))?.slice("--env=".length);
  if (environment !== "test" && environment !== "prod") {
    throw new Error(`backfill-user-created-at needs --env=test|prod\n${BACKFILL_USER_CREATED_AT_USAGE}`);
  }
  const unknown = argv.filter((arg) => !arg.startsWith("--env=") && arg !== "--apply");
  if (unknown.length > 0) {
    throw new Error(`backfill-user-created-at: unexpected arguments ${unknown.join(" ")}\n${BACKFILL_USER_CREATED_AT_USAGE}`);
  }
  return { environment, apply: argv.includes("--apply") };
}

export type CreatedAtSource = "account" | "provisioning-start";

export interface CreatedAtBackfill {
  uid: string;
  createdAt: number;
  source: CreatedAtSource;
}

export interface CreatedAtBackfillPlan {
  dated: number;
  backfills: CreatedAtBackfill[];
  unresolved: string[];
}

type BackfillCandidate = Pick<PlatformUserRecord, "uid" | "createdAt" | "provisioning">;

export function planCreatedAtBackfill(
  users: readonly BackfillCandidate[],
  accountCreatedAt: ReadonlyMap<string, number>,
): CreatedAtBackfillPlan {
  const plan: CreatedAtBackfillPlan = { dated: 0, backfills: [], unresolved: [] };
  for (const user of users) {
    if (user.createdAt !== null) {
      plan.dated += 1;
      continue;
    }
    const account = accountCreatedAt.get(user.uid);
    const provisioningStart = user.provisioning.startedAt;
    if (account !== undefined) plan.backfills.push({ uid: user.uid, createdAt: account, source: "account" });
    else if (provisioningStart !== undefined) plan.backfills.push({ uid: user.uid, createdAt: provisioningStart, source: "provisioning-start" });
    else plan.unresolved.push(user.uid);
  }
  return plan;
}

export function accountCreatedAtMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function readAccountCreatedAt(db: Firestore, uids: readonly string[]): Promise<Map<string, number>> {
  const createdAt = new Map<string, number>();
  for (let start = 0; start < uids.length; start += ACCOUNT_READ_BATCH) {
    const refs = uids.slice(start, start + ACCOUNT_READ_BATCH).map((uid) => db.collection("users").doc(uid));
    for (const snapshot of await db.getAll(...refs, { fieldMask: ["createdAt"] })) {
      const millis = accountCreatedAtMillis(snapshot.get("createdAt"));
      if (millis !== null) createdAt.set(snapshot.id, millis);
    }
  }
  return createdAt;
}

export type CreatedAtWrite = "written" | "already-dated" | "user-gone";

export function writeCreatedAt(store: Pick<PlatformStateStore, "transaction">, backfill: CreatedAtBackfill): Promise<CreatedAtWrite> {
  return store.transaction({ label: "backfill-user-created-at" }, async (transaction) => {
    const current = await transaction.users.records.get(backfill.uid);
    if (current === null) return "user-gone";
    if (current.createdAt !== null) return "already-dated";
    await transaction.users.records.create({ uid: backfill.uid, createdAt: backfill.createdAt });
    return "written";
  });
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseBackfillUserCreatedAtArgs(argv);
  const settings = deploymentEnvironmentSettings(args.environment);
  initializeOperatorFirebaseAdmin(settings.firebaseProjectId);
  const db = getFirestore();
  const store = await operatorPlatformStateStore(settings.targetId);
  try {
    const users = await store.users.records.listAll();
    const undated = users.filter((user) => user.createdAt === null).map((user) => user.uid);
    const plan = planCreatedAtBackfill(users, await readAccountCreatedAt(db, undated));
    console.log(`${users.length} user(s) in ${settings.targetId}: ${plan.dated} with a creation time, ${undated.length} without`);
    const written: Record<CreatedAtWrite, number> = { written: 0, "already-dated": 0, "user-gone": 0 };
    for (const backfill of plan.backfills) {
      const change = `${backfill.uid} created_at=${new Date(backfill.createdAt).toISOString()} (${backfill.source})`;
      if (!args.apply) {
        console.log(`  would set ${change}`);
        continue;
      }
      const outcome = await writeCreatedAt(store, backfill);
      written[outcome] += 1;
      console.log(`  ${outcome} ${change}`);
    }
    for (const uid of plan.unresolved) {
      console.error(`  ❌ ${uid}: no account createdAt and no provisioning start time; nothing to write`);
    }
    const bySource = (source: CreatedAtSource) => plan.backfills.filter((backfill) => backfill.source === source).length;
    console.log(
      `${args.apply ? "applied" : "dry run, nothing written"}: ${plan.backfills.length} to backfill ` +
      `(${bySource("account")} from the account document, ${bySource("provisioning-start")} from the provisioning start), ` +
      `${plan.unresolved.length} unresolved` +
      (args.apply ? `; ${written.written} written, ${written["already-dated"]} already dated, ${written["user-gone"]} gone` : "; rerun with --apply to write"),
    );
    if (plan.unresolved.length > 0) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
