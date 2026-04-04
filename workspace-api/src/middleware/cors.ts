/**
 * CORS config — replaces setCorsHeaders() in 12 files + { cors: CORS_ORIGINS }.
 */
import cors from "cors";

export const CORS_ORIGINS: (string | RegExp)[] = [
  /^https:\/\/octogee\.web\.app$/,
  /^https:\/\/octogee-test\.web\.app$/,
  /^https:\/\/app-octogee\.web\.app$/,
  /^https:\/\/app-octogee-test\.web\.app$/,
  /^https:\/\/octogee\.firebaseapp\.com$/,
  /^https:\/\/octogee-test\.firebaseapp\.com$/,
  /^https:\/\/app-octogee\.firebaseapp\.com$/,
  /^https:\/\/app-octogee-test\.firebaseapp\.com$/,
  /^https:\/\/(www\.)?octogee\.com$/,
  /^https:\/\/app\.octogee\.com$/,
  /^https:\/\/api\.octogee\.com$/,
  /^https:\/\/api-test\.octogee\.com$/,
  /^http:\/\/localhost:\d+$/,
];

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl)
    if (!origin) {
      callback(null, true);
      return;
    }
    const allowed = CORS_ORIGINS.some((pattern) =>
      typeof pattern === "string" ? pattern === origin : pattern.test(origin),
    );
    callback(null, allowed);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Agent-Key", "X-Internal-Service-Key"],
  credentials: true,
});
