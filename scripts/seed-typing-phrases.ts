/**
 * Seed `systemTypingPhrases/{workspaceType}` docs with the default phrase
 * lists shipped in `shared/types/workspaceType.ts`.
 *
 * Idempotent: re-runs overwrite each doc's `phrases` array with the current
 * default. Safe to run after PR4 lands — admins edit via the UI, and
 * re-running this script resets to shipped defaults only if you pass the
 * `--force` flag.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=~/.openclaw/secrets/octogee-test-sa-key.json \
 *   npx tsx scripts/seed-typing-phrases.ts
 *
 *   # Overwrite even if an admin has edited the docs since.
 *   npx tsx scripts/seed-typing-phrases.ts --force
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  DEFAULT_TYPING_PHRASES_BY_TYPE,
  WORKSPACE_TYPES,
} from '../shared/types/workspaceType';

const DEFAULT_SA_KEY_PATH = resolve(
  process.env.HOME || '~',
  '.openclaw/secrets/octogee-test-sa-key.json',
);

function loadSa(): Record<string, unknown> {
  // Honor GOOGLE_APPLICATION_CREDENTIALS first — matches the env-var path
  // documented in the usage block above. Fall back to the default dev path.
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || DEFAULT_SA_KEY_PATH;
  try {
    return JSON.parse(readFileSync(keyPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Could not read service-account key at ${keyPath}. Set ` +
        `GOOGLE_APPLICATION_CREDENTIALS or drop the key file at ${DEFAULT_SA_KEY_PATH}.`,
    );
  }
}

async function main() {
  const force = process.argv.includes('--force');
  const sa = loadSa();
  const app = initializeApp({ credential: cert(sa) }, 'seed-typing-phrases');
  const db = getFirestore(app);

  console.log(
    `Seeding systemTypingPhrases/{${WORKSPACE_TYPES.join('|')}} ` +
      `(force=${force})`,
  );

  for (const type of WORKSPACE_TYPES) {
    const ref = db.doc(`systemTypingPhrases/${type}`);
    const snap = await ref.get();
    if (snap.exists && !force) {
      console.log(`  • ${type}: exists, skipping (use --force to overwrite)`);
      continue;
    }
    await ref.set(
      {
        workspaceType: type,
        phrases: DEFAULT_TYPING_PHRASES_BY_TYPE[type],
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: false },
    );
    console.log(
      `  • ${type}: wrote ${DEFAULT_TYPING_PHRASES_BY_TYPE[type].length} phrases`,
    );
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
