import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MARKER = ".surge-handoff-ready.json";

export interface SurgeReadinessGate {
  released: () => Promise<boolean>;
  release: (input: { targetPodUid: string }) => Promise<void>;
}

export function createSurgeReadinessGate(openclawDir: string): SurgeReadinessGate {
  const markerPath = path.join(openclawDir, MARKER);
  return {
    async released() {
      try {
        await fs.access(markerPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async release({ targetPodUid }) {
      await fs.mkdir(openclawDir, { recursive: true });
      const tempPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify({ targetPodUid }), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(tempPath, markerPath);
    },
  };
}
