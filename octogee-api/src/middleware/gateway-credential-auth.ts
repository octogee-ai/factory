import type { NextFunction, Request, Response } from "express";

import {
  GATEWAY_CREDENTIAL_TOKEN_AUDIENCE,
  GATEWAY_CREDENTIAL_TOKEN_HEADER,
} from "@octogee/core/internal-fetch";
import { isWellFormedServiceAccountJwt } from "../../../gateway-edge/src/middleware/security.js";
import { logger as defaultLogger } from "../../../gateway-edge/src/middleware/logging.js";
import { db as defaultDb } from "../../../gateway-edge/src/lib/db.js";
import { mapSaToTenant, type BoundTenant } from "../lib/sa-to-tenant.js";
import type { Reviewer } from "../lib/token-review.js";

type GatewayBinding = Extract<BoundTenant, { kind: "gateway" }>;

export interface GatewayCredentialAuthOptions {
  reviewer: Reviewer;
  db?: Parameters<typeof mapSaToTenant>[0];
  namespace?: string;
  mapIdentity?: (identity: { namespace: string; saName: string }) => Promise<BoundTenant | null>;
  logger?: Pick<typeof defaultLogger, "warn">;
}

const FORBIDDEN = { error: "forbidden" } as const;

function exactPodMatch(
  bound: GatewayBinding,
  review: Extract<Awaited<ReturnType<Reviewer>>, { authenticated: true }>,
): boolean {
  return Boolean(
    bound.podName
    && bound.podUid
    && bound.saName
    && review.saName === bound.saName
    && review.podName === bound.podName
    && review.podUid === bound.podUid,
  );
}

export function createGatewayCredentialAuth(
  opts: GatewayCredentialAuthOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const db = opts.db ?? defaultDb;
  const namespace = opts.namespace ?? process.env.K8S_NAMESPACE ?? "octogee";
  const logger = opts.logger ?? defaultLogger;
  const mapIdentity = opts.mapIdentity ?? (async (identity) => {
    const mapped = await mapSaToTenant(db, identity, namespace);
    return mapped.attached ? mapped.tenant : null;
  });

  return (req, res, next): void => {
    const authenticate = async (): Promise<boolean> => {
      const bound = req.boundTenant;
      const token = req.get(GATEWAY_CREDENTIAL_TOKEN_HEADER) ?? "";
      if (!bound || bound.kind !== "gateway" || !isWellFormedServiceAccountJwt(token)) {
        return false;
      }
      const review = await opts.reviewer(token);
      if (
        !review.authenticated
        || !review.audiences.includes(GATEWAY_CREDENTIAL_TOKEN_AUDIENCE)
        || review.namespace !== namespace
        || !exactPodMatch(bound, review)
      ) return false;
      const credentialTenant = await mapIdentity({
        namespace: review.namespace,
        saName: review.saName,
      });
      return credentialTenant?.kind === "gateway"
        && credentialTenant.gatewayId === bound.gatewayId;
    };

    authenticate().then((authenticated) => {
      if (!authenticated) {
        res.status(403).json(FORBIDDEN);
        return;
      }
      next();
    }).catch((error) => {
      logger.warn("[gateway-credential-auth] credential TokenReview failed", { err: error });
      res.status(403).json(FORBIDDEN);
    });
  };
}
