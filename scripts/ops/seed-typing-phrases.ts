

import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  TYPING_PHRASES_BY_VIBE,
  WORKSPACE_VIBE_PRESETS,
} from '../../shared/types/display-names';
import { pathToFileURL } from 'node:url';
import { initializeOperatorFirebaseAdmin } from '../lib/operator-firebase-admin.js';

export interface SeedTypingPhrasesArgs {
  force: boolean;
  project: string;
}

export function parseSeedTypingPhrasesArgs(argv: string[]): SeedTypingPhrasesArgs {
  const projectFlag = argv.find((arg) => arg.startsWith('--project='));
  return {
    force: argv.includes('--force'),
    project: projectFlag ? projectFlag.slice('--project='.length) : 'octogee-test',
  };
}

async function main() {
  const { force, project } = parseSeedTypingPhrasesArgs(process.argv.slice(2));
  const app = initializeOperatorFirebaseAdmin(project);
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
