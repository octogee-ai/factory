/**
 * Seed `systemTypingPhrases/{vibe}` docs with the default phrase lists from
 * `shared/types/display-names.ts`.
 *
 * Idempotent: re-runs overwrite each doc's `phrases` array with the current
 * default only if you pass `--force`. Admins edit the docs via the Phrase
 * Manager UI; `--force` resets to shipped defaults.
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
  TYPING_PHRASES_BY_VIBE,
  WORKSPACE_VIBE_PRESETS,
} from '../shared/types/display-names';

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
      `Could not read service-account key at ${keyPath} (${(err as Error)?.message ?? "unknown"}). ` +
        `Set GOOGLE_APPLICATION_CREDENTIALS or drop the key file at ${DEFAULT_SA_KEY_PATH}.`,
    );
  }
}

async function main() {
  const force = process.argv.includes('--force');
  const sa = loadSa();
  const app = initializeApp({ credential: cert(sa) }, 'seed-typing-phrases');
  const db = getFirestore(app);

  console.log(
    `Seeding systemTypingPhrases/{${WORKSPACE_VIBE_PRESETS.join('|')}} ` +
      `(force=${force})`,
  );

  for (const vibe of WORKSPACE_VIBE_PRESETS) {
    const ref = db.doc(`systemTypingPhrases/${vibe}`);
    const snap = await ref.get();
    if (snap.exists && !force) {
      console.log(`  • ${vibe}: exists, skipping (use --force to overwrite)`);
      continue;
    }
    await ref.set(
      {
        vibe,
        phrases: TYPING_PHRASES_BY_VIBE[vibe],
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: false },
    );
    console.log(
      `  • ${vibe}: wrote ${TYPING_PHRASES_BY_VIBE[vibe].length} phrases`,
    );
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
