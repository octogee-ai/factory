import { firestoreSizingKeyReader } from "@octogee/core/user-activation-lease";
import { lazyPlatformStateStore, platformStateStoreFromEnvironment } from "@octogee/core/platform-state";
import { logger } from "../middleware/logging.js";
import { db } from "./db.js";

export const platformStateStore = lazyPlatformStateStore(() => platformStateStoreFromEnvironment({
  applicationName: "octogee-api",
  logger: {
    warn: (message, detail) => logger.warn(message, detail),
    error: (message, detail) => logger.error(message, detail),
  },
}));
export const readSizingKey = firestoreSizingKeyReader(db);
