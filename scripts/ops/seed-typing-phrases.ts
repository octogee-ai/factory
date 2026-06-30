

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  TYPING_PHRASES_BY_VIBE,
  WORKSPACE_VIBE_PRESETS,
} from '../../shared/types/display-names';
import { pathToFileURL } from 'node:url';

const DEFAULT_SA_KEY_PATH = resolve(
  process.env.HOME || '~',
  '.openclaw/secrets/octogee-test-sa-key.json',
);

export interface SeedTypingPhrasesArgs {
  force: boolean;
}

export function parseSeedTypingPhrasesArgs(argv: string[]): SeedTypingPhrasesArgs {
  return { force: argv.includes('--force') };
}

function loadSa(): Record<string, unknown> {

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
  const { force } = parseSeedTypingPhrasesArgs(process.argv.slice(2));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
