import { firestoreBuilderTierReader } from "@octogee/core/builder-activation-lease";
import { createFirestorePlatformStateStore } from "@octogee/core/platform-state";
import { db } from "./db.js";

export const platformStateStore = createFirestorePlatformStateStore({ db });
export const readBuilderTier = firestoreBuilderTierReader(db);
