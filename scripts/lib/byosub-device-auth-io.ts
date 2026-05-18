/**
 * Real I/O deps for the C1b device-auth manager. This is the I/O shell —
 * child spawn, fs read, the R2 capture POST — exercised in TEST, not
 * unit-tested (the orchestration in byosub-device-auth.ts is). codex runs
 * with the per-agent CODEX_HOME so its auth.json lands exactly where
 * Chunk A restores / Chunk B watches. workspace-api owns the Secret
 * Manager write; this only hands it the credential over the in-pod
 * internal channel. Design: BYO-SUBSCRIPTION-OAUTH-SPEC §13.
 */
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

export interface DeviceAuthIoConfig {
  openclawDir: string;
  internalServiceKey: string;
  /** workspace-api is an in-pod sidecar; default reaches it on localhost. */
  workspaceApiBaseUrl?: string;
  codexBin?: string;
  log?: (m: string) => void;
}

export function realDeviceAuthDeps(cfg: DeviceAuthIoConfig): DeviceAuthDeps {
  const base = cfg.workspaceApiBaseUrl ?? "http://127.0.0.1:3001";
  const codexBin = cfg.codexBin ?? "codex";
  const log = cfg.log ?? (() => {});
  return {
    now: () => Date.now(),
    log: cfg.log,
    spawnDeviceAuth: (agentId: string): DeviceAuthChild => {
      // agentId is SAFE_AGENT_ID-validated at the start-handler ingress;
      // re-assert here — it goes straight into a spawned process env.
      if (!isSafeAgentId(agentId)) {
        throw new Error(
          `refusing to spawn device-auth for unsafe agentId ${JSON.stringify(agentId.slice(0, 80))}`,
        );
      }
      // STAGING codex-home: a failed/expired/abandoned login must never
      // mutate the live per-agent auth.json (the "never break Bender"
      // invariant). The live home is replaced only by an atomic promote
      // of a successfully captured staged credential.
      const stagingHome = codexStagingHomeDir(cfg.openclawDir, agentId);
      // codex-cli >=0.130 (OC 2026.5.12) refuses to start when CODEX_HOME
      // does not exist ("path does not exist", exits before the device
      // prompt) — older codex auto-created it. Create it up front.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- traversal-guarded per-agent staging codex-home (isSafeAgentId)
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
          // codex writes the device prompt to stderr on some builds.
          child.stderr?.on("data", (d: Buffer) => cb(d.toString("utf8")));
        },
        // One-shot: exit and error are coalesced so the manager's single
        // exit listener fires at most once even if codex emits error→exit.
        // An `error` event (codex binary missing / EPERM) is logged so an
        // operator can tell "codex not installed" from "ran but exited".
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
        // STAGING path — what the device-auth child just wrote. Same
        // traversal boundary as Chunk A restore (SAFE_AGENT_ID).
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- traversal-guarded per-agent staging codex-home (isSafeAgentId)
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
        // Atomic: stage→read→write tmp 0600→rename over live. codex
        // hard-fails on a partial auth.json, so the live home only ever
        // sees a complete file (same discipline as Chunk A restore).
        // Paths are openclawDir + fixed segments + a SAFE_AGENT_ID-guarded
        // agentId (checked above) — same traversal boundary as restore.
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- traversal-guarded per-agent codex-home (isSafeAgentId)
        const payload = await readFile(staged, "utf8");
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- traversal-guarded per-agent codex-home (isSafeAgentId)
        await mkdir(dirname(live), { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- traversal-guarded per-agent codex-home (isSafeAgentId)
        await writeFile(tmp, payload, { mode: 0o600 });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- traversal-guarded per-agent codex-home (isSafeAgentId)
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
        const r = await fetch(`${base}/api/byosub/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Service-Key": cfg.internalServiceKey,
          },
          body: JSON.stringify({ flowId, credential }),
        });
        if (!r.ok) {
          // `reason` is surfaced via `status` + logs — must stay
          // credential-free. C1a error bodies are bounded and never echo
          // the credential; truncate anyway as defence-in-depth against a
          // future upstream/proxy error page.
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
