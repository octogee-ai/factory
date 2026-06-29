import * as fs from "fs";
import * as path from "path";
import { log, CUSTOMERS_DIR } from "./config.js";

export function cleanupStaleLimitsMd(): void {
  if (!fs.existsSync(CUSTOMERS_DIR)) return;
  for (const slug of fs.readdirSync(CUSTOMERS_DIR)) {
    const limitsPath = path.join(CUSTOMERS_DIR, slug, "coach", "LIMITS.md");
    if (fs.existsSync(limitsPath)) {
      fs.unlinkSync(limitsPath);
      log(`throttle: removed stale LIMITS.md for ${slug}`);
    }
  }
}
