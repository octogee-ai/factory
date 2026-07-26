import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "node:fs";

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

function argument(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function serviceAccountForProject(value: unknown, projectId: string): {
  projectId: string;
  clientEmail: string;
  privateKey: string;
} {
  const serviceAccount = value as {
    project_id?: unknown;
    client_email?: unknown;
    private_key?: unknown;
  };
  if (
    serviceAccount.project_id !== projectId ||
    typeof serviceAccount.client_email !== "string" ||
    typeof serviceAccount.private_key !== "string"
  ) {
    throw new Error(`service-account project does not match ${projectId}`);
  }
  return {
    projectId: serviceAccount.project_id,
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key,
  };
}

async function main(): Promise<void> {
  const projectId = requiredArgument("--project");
  const serviceAccountPath = argument("--service-account");
  const credential = serviceAccountPath
    ? cert(serviceAccountForProject(JSON.parse(readFileSync(serviceAccountPath, "utf8")), projectId))
    : applicationDefault();
  const app = initializeApp({ credential, projectId });
  if (process.argv.includes("--verify")) {
    await getAuth(app).listUsers(1);
    console.log("Firebase Auth cleanup credential verified");
    return;
  }
  const deleted = await deleteAllFirebaseAuthUsers(getAuth(app));
  console.log(`Deleted ${deleted} Firebase Auth user(s)`);
}

if (process.argv[1]?.endsWith("delete-firebase-auth-users.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
