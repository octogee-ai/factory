import {
  DEFAULT_PLATFORM_CONNECT_CONFIG,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_CONNECT_CONFIG_DOC,
  parsePlatformConnectConfig,
  type PlatformConnectConfig,
} from "@octogee/shared/types/platform-config";
import { db } from "./db.js";

export async function readPlatformConnectConfig(): Promise<PlatformConnectConfig> {
  const snap = await db
    .collection(PLATFORM_CONFIG_COLLECTION)
    .doc(PLATFORM_CONNECT_CONFIG_DOC)
    .get();
  return parsePlatformConnectConfig(snap.data()) ?? DEFAULT_PLATFORM_CONNECT_CONFIG;
}
