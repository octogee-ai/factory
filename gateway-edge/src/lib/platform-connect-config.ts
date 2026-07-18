import {
  DEFAULT_PLATFORM_CONNECT_CONFIG,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_CONNECT_CONFIG_DOC,
  parsePlatformConnectConfig,
  type PlatformConnectConfig,
} from "@octogee/shared/types/platform-config";
import { db } from "./db.js";
import { logger } from "../middleware/logging.js";

export function platformConnectDoc() {
  return db.collection(PLATFORM_CONFIG_COLLECTION).doc(PLATFORM_CONNECT_CONFIG_DOC);
}

export async function readPlatformConnectConfig(): Promise<PlatformConnectConfig> {
  const snap = await platformConnectDoc().get();
  const parsed = parsePlatformConnectConfig(snap.data());
  if (snap.data() !== undefined && !parsed) {
    logger.warn("[connect] platformConfig/connect is malformed — resolving to the dark default", {
      data: snap.data(),
    });
  }
  return parsed ?? DEFAULT_PLATFORM_CONNECT_CONFIG;
}
