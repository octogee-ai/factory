import { getAuth } from "firebase-admin/auth";
import { initializeOperatorFirebaseAdmin } from "../lib/operator-firebase-admin.js";

type FirebaseAuthCleanupClient = {
  listUsers(maxResults: number, pageToken?: string): Promise<{
    users: Array<{ uid: string }>;
    pageToken?: string;
  }>;
  deleteUsers(uids: string[]): Promise<{ failureCount: number }>;
};

const PAGE_SIZE = 1_000;

export async function deleteAllFirebaseAuthUsers(
  auth: FirebaseAuthCleanupClient,
): Promise<number> {
  const uids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(PAGE_SIZE, pageToken);
    uids.push(...page.users.map((user) => user.uid));
    pageToken = page.pageToken;
  } while (pageToken);

  for (let index = 0; index < uids.length; index += PAGE_SIZE) {
    const result = await auth.deleteUsers(uids.slice(index, index + PAGE_SIZE));
    if (result.failureCount > 0) {
      throw new Error(`Firebase Auth deletion failed for ${result.failureCount} user(s)`);
    }
  }
  const remaining = await auth.listUsers(1);
  if (remaining.users.length > 0) {
    throw new Error("Firebase Auth still contains users after deletion");
  }
  return uids.length;
}

function parseArgs(argv: readonly string[]): { projectId: string; verify: boolean } {
  let projectId = "";
  let verify = false;
  for (const arg of argv) {
    if (arg === "--verify") verify = true;
    else if (arg.startsWith("--project=")) projectId = arg.slice("--project=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!projectId) throw new Error("--project is required");
  return { projectId, verify };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { projectId, verify } = parseArgs(argv);
  const auth = getAuth(initializeOperatorFirebaseAdmin(projectId));
  if (verify) {
    await auth.listUsers(1);
    console.log("Firebase Auth cleanup credential verified");
    return;
  }
  const deleted = await deleteAllFirebaseAuthUsers(auth);
  console.log(`Deleted ${deleted} Firebase Auth user(s)`);
}

if (process.argv[1]?.endsWith("delete-firebase-auth-users.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
