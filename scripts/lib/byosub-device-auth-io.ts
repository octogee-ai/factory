

import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname } from "path";
import {
  codexAuthJsonPath,
  codexStagingAuthJsonPath,
  codexStagingHomeDir,
  isSafeAgentId,
} from "./byosub-restore.js";
import type { DeviceAuthChild, DeviceAuthDeps } from "./byosub-device-auth.js";
import { internalFetch } from "./internal-fetch.js";

export interface DeviceAuthIoConfig {
  openclawDir: string;
  internalServiceKey: string;
  
  gatewayEdgeBaseUrl?: string;
  codexBin?: string;
  log?: (m: string) => void;
}

function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function defaultOctogeeApiBaseUrl(): string {
  const configured = process.env.OCTOGEE_API_URL;
  if (configured) return stripTrailingSlash(configured);
  const ns = process.env.K8S_NAMESPACE ?? "octogee";
  return `http://octogee-api.${ns}.svc.cluster.local:3001`;
}

export function realDeviceAuthDeps(cfg: DeviceAuthIoConfig): DeviceAuthDeps {
  const base = cfg.gatewayEdgeBaseUrl
    ? stripTrailingSlash(cfg.gatewayEdgeBaseUrl)
    : defaultOctogeeApiBaseUrl();
  const codexBin = cfg.codexBin ?? "codex";
  const log = cfg.log ?? (() => {});
  return {
    now: () => Date.now(),
    log: cfg.log,
    spawnDeviceAuth: (agentId: string): DeviceAuthChild => {

if (!isSafeAgentId(agentId)) {
        throw new Error(
          `refusing to spawn device-auth for unsafe agentId ${JSON.stringify(agentId.slice(0, 80))}`,
        );
      }

const stagingHome = codexStagingHomeDir(cfg.openclawDir, agentId);

      mkdirSync(stagingHome, { recursive: true });
      const child = spawn(codexBin, ["login", "--device-auth"], {
        env: {
          ...process.env,
          CODEX_HOME: stagingHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        onStdout: (cb) => {
          child.stdout?.on("data", (d: Buffer) => cb(d.toString("utf8")));
          
          child.stderr?.on("data", (d: Buffer) => cb(d.toString("utf8")));
        },

onExit: (cb) => {
          let fired = false;
          const fire = (code: number) => {
            if (fired) return;
            fired = true;
            cb(code);
          };
          child.on("exit", (code) => fire(code ?? -1));
          child.on("error", (err: Error) => {
            log(
              `byosub device-auth: codex child error for ${agentId} — ${err.message}`,
            );
            fire(-1);
          });
        },
        kill: () => {
          child.kill("SIGTERM");
        },
      };
    },
    readAuthJson: async (agentId: string): Promise<string | null> => {
      if (!isSafeAgentId(agentId)) return null;
      try {

        return await readFile(
          codexStagingAuthJsonPath(cfg.openclawDir, agentId),
          "utf8",
        );
      } catch {
        return null;
      }
    },
    promoteStagedAuth: async (agentId: string) => {
      if (!isSafeAgentId(agentId)) {
        return { ok: false, reason: "unsafe agentId" };
      }
      const staged = codexStagingAuthJsonPath(cfg.openclawDir, agentId);
      const live = codexAuthJsonPath(cfg.openclawDir, agentId);
      const tmp = `${live}.promote.tmp`;
      try {

        const payload = await readFile(staged, "utf8");
        await mkdir(dirname(live), { recursive: true });
        await writeFile(tmp, payload, { mode: 0o600 });
        await rename(tmp, live);
        return { ok: true };
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => {});
        return { ok: false, reason: (e as Error).message };
      }
    },
    discardStaged: async (agentId: string) => {
      if (!isSafeAgentId(agentId)) return;
      try {
        await rm(codexStagingHomeDir(cfg.openclawDir, agentId), {
          recursive: true,
          force: true,
        });
      } catch {
        // best-effort scratch cleanup
      }
    },
    postCapture: async (flowId: string, credential: string) => {
      try {
        const r = await internalFetch(`${base}/api/model-credentials/subscription/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ flowId, credential }),
        }, {
          internalServiceKey: cfg.internalServiceKey,
        });
        if (!r.ok) {

const body = (await r.text().catch(() => "")).slice(0, 200);
          return { ok: false, reason: `capture ${r.status} ${body}` };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  };
}
