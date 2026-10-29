import {
  DEFAULT_PLATFORM_CONNECT_CONFIG,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_CONNECT_CONFIG_DOC,
  parsePlatformConnectConfig,
  type PlatformConnectConfig,
} from "@octogee/shared/types/platform-config";
import { db } from "./db.js";
import { logger } from "../middleware/logging.js";

export class MalformedPlatformConnectConfigError extends Error {
  constructor() {
    super("platformConfig/connect is malformed");
    this.name = "MalformedPlatformConnectConfigError";
  }
}

export function platformConnectDoc() {
  return db.collection(PLATFORM_CONFIG_COLLECTION).doc(PLATFORM_CONNECT_CONFIG_DOC);
}

export async function readPlatformConnectConfig(): Promise<PlatformConnectConfig> {
  const snap = await platformConnectDoc().get();
  const data = snap.data();
  if (data === undefined) return DEFAULT_PLATFORM_CONNECT_CONFIG;
  const parsed = parsePlatformConnectConfig(data);
  if (!parsed) {
    logger.error(
      "[connect] platformConfig/connect is malformed — Google connect is refused until the operator rewrites it as { googleStages, googleAllowlistUids }",
      { data },
    );
    throw new MalformedPlatformConnectConfigError();
  }
  return parsed;
}
