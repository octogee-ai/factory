import { Router, Request, Response, NextFunction } from "express";
import { applyConfigPatch } from "@octogee/core/apply-config-patch";
import { syncModelCredentialsForCustomer } from "@octogee/core/model-credential-sync-runtime";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import { requireByotSyncInternalAuth } from "../../middleware/byot-sync-auth.js";

const router = Router();

export function createLeasedModelConfigWriter(
  deps: {
    acquireLease?: typeof acquireSystemConfigMutationLease;
    applyPatch?: typeof applyConfigPatch;
    openclawDir?: () => string;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): typeof applyConfigPatch {
  const acquireLease = deps.acquireLease ?? acquireSystemConfigMutationLease;
  const applyPatch = deps.applyPatch ?? applyConfigPatch;
  const openclawDir = deps.openclawDir ?? (() => process.env.OPENCLAW_DIR ?? "/home/node/.openclaw");
  const wait = deps.wait ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  return async (args, options) => {
    let acquired = await acquireLease({ openclawDir: openclawDir() });
    for (const delayMs of [250, 750]) {
      if (acquired.ok || acquired.code !== "writer-lock-busy") break;
      await wait(delayMs);
      acquired = await acquireLease({ openclawDir: openclawDir() });
    }
    if (!acquired.ok) {
      if (acquired.code === "config-frozen") {
        throw new Error(
          `system config is frozen by ${acquired.freezeOwner.migrationId} for ${acquired.freezeOwner.slug}`,
        );
      }
      if (acquired.code === "shell-active") {
        throw new Error(`system config mutation blocked by active builder shells: ${acquired.shellIds.join(", ")}`);
      }
      throw new Error("system config writer lock is busy");
    }
    try {
      return await applyPatch(args, options);
    } finally {
      await acquired.lease.release();
    }
  };
}

const modelConfigWriter = createLeasedModelConfigWriter();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidPayload(value: unknown): value is Parameters<typeof syncModelCredentialsForCustomer>[0] {
  if (!isRecord(value)) return false;
  if (typeof value.username !== "string" || value.username.trim().length === 0) return false;
  const provisioning = value.provisioning;
  if (!isRecord(provisioning)) return false;
  const openclaw = provisioning.openclaw;
  if (!isRecord(openclaw)) return false;
  return typeof openclaw.status === "string" && openclaw.status.length > 0;
}

router.post(
  ["/model-credential-sync", "/byot-sync"],
  requireByotSyncInternalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isValidPayload(req.body)) {
        res.status(400).json({ error: "username and provisioning.openclaw.status required" });
        return;
      }
      await syncModelCredentialsForCustomer(req.body, {
        applyConfigPatch: modelConfigWriter,
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
