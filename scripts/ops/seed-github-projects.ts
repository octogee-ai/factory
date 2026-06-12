// One-off: seed a GitHub-backed project doc through the real create route so the
// project gets its full provisioning (Firestore doc + members + MM channel +
// activity pair) — never a bare Firestore write.
//
// Auth: mints a custom token for OPERATOR_UID (admin) via the Admin SDK, then
// exchanges it for an ID token at identitytoolkit, so the request hits
// POST /api/projects exactly like the PWA would — including the operator-only
// repoSource gate.
//
// Usage (run once per repo):
//   GCLOUD_PROJECT=octogee-test \
//   GOOGLE_APPLICATION_CREDENTIALS=~/path/to/sa.json \
//   OPERATOR_UID=<admin uid> \
//   FIREBASE_WEB_API_KEY=<web api key> \
//   API_BASE=https://api-test.octogee.com \
//   npx tsx ops/seed-github-projects.ts --slug octogee --name "Octogee" --owner octogee-ai --repo octogee
//   npx tsx ops/seed-github-projects.ts --slug openclaw --name "OpenClaw" --owner octogee-ai --repo openclaw

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(64);
  }
  return v;
}

async function main(): Promise<void> {
  const slug = arg("slug");
  const name = arg("name");
  const owner = arg("owner");
  const repo = arg("repo");
  const tagline = arg("tagline") ?? "";
  if (!slug || !name || !owner || !repo) {
    console.error(
      "usage: npx tsx ops/seed-github-projects.ts --slug <slug> --name <name> --owner <gh-owner> --repo <gh-repo> [--tagline <text>]",
    );
    process.exit(64);
  }

  const operatorUid = requireEnv("OPERATOR_UID");
  const webApiKey = requireEnv("FIREBASE_WEB_API_KEY");
  const apiBase = process.env.API_BASE ?? "https://api-test.octogee.com";

  initializeApp();
  const customToken = await getAuth().createCustomToken(operatorUid);

  const signIn = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  if (!signIn.ok) {
    console.error(`Custom-token exchange failed: ${signIn.status} ${await signIn.text()}`);
    process.exit(1);
  }
  const { idToken } = (await signIn.json()) as { idToken: string };

  const res = await fetch(`${apiBase}/api/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      name,
      slug,
      tagline,
      category: "other",
      visibility: "private",
      repoSource: { provider: "github", owner, repo },
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`Create failed: ${res.status} ${body}`);
    process.exit(1);
  }
  console.log(`Created ${slug} → github.com/${owner}/${repo}`);
  console.log(body);
}

main();
