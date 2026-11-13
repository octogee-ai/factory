import cors from "cors";
import { publicAppOriginsFromEnv } from "@octogee/core/public-app-origins";
import { isAllowedLocalhostOrigin } from "../lib/dev-origins.js";

const ALLOWED_ORIGINS = new Set(publicAppOriginsFromEnv());

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) || isAllowedLocalhostOrigin(origin);
}

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, isAllowedOrigin(origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Internal-Service-Key", "X-Requested-With"],
  credentials: true,
});
