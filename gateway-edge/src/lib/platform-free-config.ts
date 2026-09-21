import {
  DEFAULT_PLATFORM_FREE_CONFIG,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_FREE_CONFIG_DOC,
  parsePlatformFreeConfig,
  type PlatformFreeConfig,
} from "@octogee/shared/types/platform-config";

import { db } from "./db.js";
import { logger } from "../middleware/logging.js";

export async function readPlatformFreeConfig(): Promise<PlatformFreeConfig> {
  const snapshot = await db
    .collection(PLATFORM_CONFIG_COLLECTION)
    .doc(PLATFORM_FREE_CONFIG_DOC)
    .get();
  if (!snapshot.exists) return DEFAULT_PLATFORM_FREE_CONFIG;
  const config = parsePlatformFreeConfig(snapshot.data());
  if (config) return config;
  logger.warn("platformConfig/free invalid; using compiled Free storage allowance");
  return DEFAULT_PLATFORM_FREE_CONFIG;
}
