import { applicationDefault, initializeApp, type App } from "firebase-admin/app";

function applicationDefaultCredentialSource(env: NodeJS.ProcessEnv): string {
  const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS;
  return keyFile
    ? `GOOGLE_APPLICATION_CREDENTIALS=${keyFile} — unset it to use your gcloud application-default login`
    : "gcloud application-default login — rerun `gcloud auth application-default login` if Firestore answers UNAUTHENTICATED";
}

export function initializeOperatorFirebaseAdmin(
  projectId: string,
  { env = process.env, log = console.log }: { env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {},
): App {
  if (!projectId) {
    throw new Error("an explicit Firebase project id is required");
  }
  const app = initializeApp({ credential: applicationDefault(), projectId });
  log(`credentials: application default for ${projectId} from ${applicationDefaultCredentialSource(env)}`);
  return app;
}
