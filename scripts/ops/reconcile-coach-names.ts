import * as fs from "fs";
import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { pathToFileURL } from "node:url";

export interface ReconcileCoachNamesArgs {
  apply: boolean;
  clearOnboarding: boolean;
  filters: string[];
  list: boolean;
  mmAdminToken: string | undefined;
  mmUrl: string | undefined;
  projectId: string | undefined;
  saKey: string | undefined;
}

export function parseReconcileCoachNamesArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ReconcileCoachNamesArgs {
  return {
    apply: argv.includes("--apply"),
    list: argv.includes("--list"),
    clearOnboarding: argv.includes("--clear-onboarding-name"),
    filters: argv.filter((a) => !a.startsWith("--")),
    mmUrl: env.MM_URL,
    mmAdminToken: env.MM_ADMIN_TOKEN,
    saKey: env.GOOGLE_APPLICATION_CREDENTIALS,
    projectId: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT,
  };
}

let APPLY = false;
let LIST = false;
let CLEAR_ONBOARDING = false;
let FILTERS: string[] = [];
let MM_URL = "";
let MM_ADMIN_TOKEN = "";
let projectId = "";
let db: FirebaseFirestore.Firestore;

// The canonical Mattermost display name for a coach is the bot account's
// display_name — exactly the field syncCoachIdentity writes (PUT /bots/{id}).
// Fall back to the user's first_name for any non-bot account.
async function mmCoachName(userId: string): Promise<string> {
  const bot = await fetch(`${MM_URL}/api/v4/bots/${userId}`, {
    headers: { Authorization: `Bearer ${MM_ADMIN_TOKEN}` },
  });
  if (bot.ok) {
    const data = (await bot.json()) as { display_name?: string };
    return (data.display_name ?? "").trim();
  }
  const user = await fetch(`${MM_URL}/api/v4/users/${userId}`, {
    headers: { Authorization: `Bearer ${MM_ADMIN_TOKEN}` },
  });
  if (!user.ok) {
    throw new Error(`MM ${user.status} GET /users/${userId}: ${(await user.text().catch(() => "")).slice(0, 200)}`);
  }
  const data = (await user.json()) as { first_name?: string };
  return (data.first_name ?? "").trim();
}

interface AgentRow {
  uid: string;
  slug: string;
  coachMmUserId: string;
  firestoreName: string;
  mmName: string;
  onboardingName: string;
}

async function buildInventory(): Promise<AgentRow[]> {
  const snap = await db.collection("agents").get();
  const out: AgentRow[] = [];

  for (const doc of snap.docs) {
    const uid = doc.id;
    const data = doc.data();
    const coachMmUserId = data.mattermost?.userId as string | undefined;
    if (!coachMmUserId) continue;

    const userSnap = await db.doc(`users/${uid}`).get();
    const userData = userSnap.data() ?? {};
    const slug = (userData.username as string | undefined) ?? uid;
    const onboarding = (userData.onboarding ?? {}) as Record<string, unknown>;
    const onboardingName = typeof onboarding.coachName === "string" ? onboarding.coachName : "";

    if (FILTERS.length > 0 && !FILTERS.includes(slug) && !FILTERS.includes(uid)) continue;

    const firestoreName = typeof data.name === "string" ? data.name : "";
    let mmName = "";
    try {
      mmName = await mmCoachName(coachMmUserId);
    } catch (err) {
      console.warn(`  SKIP ${slug} (${uid}) — MM read failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    out.push({ uid, slug, coachMmUserId, firestoreName, mmName, onboardingName });
  }
  return out;
}

async function reconcileNames(inventory: AgentRow[]): Promise<void> {
  // Only reconcile when MM has a non-empty name that differs — never clobber Firestore with a blank.
  const candidates = inventory.filter((r) => r.mmName && r.mmName !== r.firestoreName);
  console.log(`Found ${candidates.length} agent(s) whose Firestore name differs from Mattermost:`);
  for (const c of candidates) {
    console.log(`  - ${c.slug} (${c.uid}): firestore="${c.firestoreName}" → mm="${c.mmName}"`);
  }
  if (!APPLY) {
    console.log("Done (dry run).");
    return;
  }
  for (const c of candidates) {
    await db.doc(`agents/${c.uid}`).set(
      { name: c.mmName, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    console.log(`  WROTE agents/${c.uid}.name = "${c.mmName}" (${c.slug})`);
  }
  console.log("Done.");
}

async function clearOnboardingNames(inventory: AgentRow[]): Promise<void> {
  // The vestigial onboarding.coachName overrides agents/{uid}.name in the client
  // profile merge; clear it so the reconciled agent name surfaces.
  const candidates = inventory.filter((r) => r.onboardingName.length > 0);
  console.log(`Found ${candidates.length} user(s) with a stale onboarding.coachName:`);
  for (const c of candidates) {
    console.log(`  - ${c.slug} (${c.uid}): onboarding.coachName="${c.onboardingName}" (agent name="${c.firestoreName}")`);
  }
  if (!APPLY) {
    console.log("Done (dry run).");
    return;
  }
  for (const c of candidates) {
    await db.doc(`users/${c.uid}`).update({ "onboarding.coachName": FieldValue.delete() });
    console.log(`  CLEARED users/${c.uid}.onboarding.coachName (${c.slug})`);
  }
  console.log("Done.");
}

async function main() {
  const args = parseReconcileCoachNamesArgs(process.argv.slice(2));
  if (!args.mmUrl || !args.mmAdminToken) {
    console.error("ERROR: Both MM_URL and MM_ADMIN_TOKEN must be set.");
    process.exit(1);
  }
  APPLY = args.apply;
  LIST = args.list;
  CLEAR_ONBOARDING = args.clearOnboarding;
  FILTERS = args.filters;
  MM_URL = args.mmUrl;
  MM_ADMIN_TOKEN = args.mmAdminToken;

  if (args.saKey && fs.existsSync(args.saKey)) {
    const saKey = JSON.parse(fs.readFileSync(args.saKey, "utf-8"));
    projectId = saKey.project_id;
    initializeApp({ credential: cert(saKey), projectId });
  } else if (args.projectId) {
    projectId = args.projectId;
    initializeApp({ credential: applicationDefault(), projectId });
  } else {
    console.error(
      "ERROR: set GOOGLE_APPLICATION_CREDENTIALS to a service-account key, or GOOGLE_CLOUD_PROJECT to use application-default credentials.",
    );
    process.exit(1);
  }
  db = getFirestore();
  console.log(`Project: ${projectId}${APPLY ? "" : LIST ? " [LIST]" : " [DRY RUN — pass --apply to write]"}`);
  if (FILTERS.length > 0) console.log(`Filter: ${FILTERS.join(", ")}`);

  const inventory = await buildInventory();

  if (LIST) {
    console.log(`Agents (${inventory.length}):`);
    for (const r of inventory) {
      const flag = r.mmName && r.mmName !== r.firestoreName ? "  ← differs" : "";
      console.log(
        `  - ${r.slug} (${r.uid}) [${r.coachMmUserId}]: firestore="${r.firestoreName}" mm="${r.mmName}" onboarding="${r.onboardingName}"${flag}`,
      );
    }
    return;
  }

  if (CLEAR_ONBOARDING) {
    await clearOnboardingNames(inventory);
    return;
  }

  await reconcileNames(inventory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
