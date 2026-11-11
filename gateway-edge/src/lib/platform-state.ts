import { firestoreBuilderTierReader } from "@octogee/core/user-activation-lease";
import { createFirestorePlatformStateStore, platformStateStoreFromEnvironment } from "@octogee/core/platform-state";
import { logger } from "../middleware/logging.js";
import { db } from "./db.js";

export const platformStateStore = platformStateStoreFromEnvironment({
  applicationName: "octogee-api",
  createFirestoreStore: () => createFirestorePlatformStateStore({ db }),
  logger: {
    warn: (message, detail) => logger.warn(message, detail),
    error: (message, detail) => logger.error(message, detail),
  },
});
export const readBuilderTier = firestoreBuilderTierReader(db);
