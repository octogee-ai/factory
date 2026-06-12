import * as crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import type { ConnectorCaptureMethod } from "@shared/types/connectors.js";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";
import { db, FieldValue, Timestamp } from "../lib/db.js";
import { encryptSecret, decryptSecret } from "../lib/kms.js";
import { sanitizeReturnUrl, buildOAuthRedirect } from "../lib/redirect-validation.js";
import {
  generateConnectState,
  verifyConnectState,
  type ConnectStatePayload,
} from "../lib/connect-state.js";
import {
  getConnector,
  connectorRedirectUri,
  type ConnectorDef,
} from "../lib/connectors/index.js";
import {
  readConnectorClientCreds,
  getFreshAccessToken,
  type ConnectorClientCreds,
} from "../lib/connector-tokens.js";

const router = Router();
const APP_URL = process.env.APP_URL || "https://octogee.com";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

function flowsCol() {
  return db.collection("connectFlows");
}

function userCol(uid: string, sub: "secrets" | "integrations") {
  return db.collection("users").doc(uid).collection(sub);
}

function grantedScopes(def: ConnectorDef, clientSource?: "platform" | "per-user"): string[] {
  return clientSource === "platform" && def.meta.platformScopes
    ? def.meta.platformScopes
    : def.meta.scopes;
}

async function storeConnectorTokens(args: {
  uid: string;
  def: ConnectorDef;
  tokens: TokenResponse;
  accountLabel: string;
  captureMethod: ConnectorCaptureMethod;
  clientSource?: "platform" | "per-user";
}): Promise<void> {
  const { uid, def, tokens, accountLabel, captureMethod, clientSource } = args;
  const encryptedAccessToken = await encryptSecret(tokens.access_token);
  const encryptedRefreshToken = tokens.refresh_token
    ? await encryptSecret(tokens.refresh_token)
    : null;

  await userCol(uid, "secrets").doc(def.meta.id).set(
    {
      provider: def.meta.id,
      tokens: {
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
        tokenType: tokens.token_type ?? "bearer",
        clientSource: clientSource ?? null,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await userCol(uid, "integrations").doc(def.meta.id).set({
    provider: def.meta.id,
    status: "connected",
    accountLabel,
    scopes: captureMethod === "oauth-web" ? grantedScopes(def, clientSource) : [],
    captureMethod,
    ...(clientSource === "per-user" ? { clientConfigured: true } : {}),
    connectedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info(`[connect] ${def.meta.id} connected for uid=${uid} via ${captureMethod} (${accountLabel})`);
}

async function exchangeAuthCode(
  def: ConnectorDef,
  code: string,
  creds: ConnectorClientCreds,
): Promise<TokenResponse> {
  const oauth = def.oauth!;
  const resp = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: connectorRedirectUri(def),
    }),
  });
  if (!resp.ok) {
    throw new Error(`token exchange failed: ${resp.status}`);
  }
  const tokens = (await resp.json()) as TokenResponse & { error?: string };
  if (tokens.error || !tokens.access_token) {
    throw new Error(`token exchange rejected: ${tokens.error ?? "no access_token"}`);
  }
  return tokens;
}

router.post(
  "/disconnect",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const connector = String((req.body ?? {}).connector ?? "");
      const def = getConnector(connector);
      if (!def) {
        res.status(400).json({ error: `Unknown connector: ${connector}` });
        return;
      }
      const secretRef = userCol(req.uid!, "secrets").doc(def.meta.id);
      const client =
        def.meta.clientSource === "per-user"
          ? ((await secretRef.get()).data() as { client?: unknown } | undefined)?.client
          : undefined;
      if (client) {
        await secretRef.set({
          provider: def.meta.id,
          client,
          updatedAt: FieldValue.serverTimestamp(),
        });
        await userCol(req.uid!, "integrations").doc(def.meta.id).set({
          provider: def.meta.id,
          status: "disconnected",
          clientConfigured: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        await secretRef.delete();
        await userCol(req.uid!, "integrations").doc(def.meta.id).set({
          provider: def.meta.id,
          status: "disconnected",
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

const CLIENT_FIELD_MAX = 512;

router.post(
  "/:connector/client",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def || def.meta.clientSource !== "per-user") {
        res.status(404).json({ error: "Connector does not take a per-user client" });
        return;
      }
      const { clientId, clientSecret } = (req.body ?? {}) as {
        clientId?: unknown;
        clientSecret?: unknown;
      };
      if (
        typeof clientId !== "string" ||
        clientId.trim().length === 0 ||
        clientId.length > CLIENT_FIELD_MAX ||
        typeof clientSecret !== "string" ||
        clientSecret.trim().length === 0 ||
        clientSecret.length > CLIENT_FIELD_MAX
      ) {
        res.status(400).json({ error: "clientId and clientSecret required" });
        return;
      }

      const encryptedClientId = await encryptSecret(clientId.trim());
      const encryptedClientSecret = await encryptSecret(clientSecret.trim());
      await userCol(req.uid!, "secrets").doc(def.meta.id).set(
        {
          provider: def.meta.id,
          client: { encryptedClientId, encryptedClientSecret },
          tokens: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      await userCol(req.uid!, "integrations").doc(def.meta.id).set(
        {
          provider: def.meta.id,
          status: "disconnected",
          clientConfigured: true,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      logger.info(`[connect] ${def.meta.id} per-user client saved for uid=${req.uid}`);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

async function setVerifyStatus(
  uid: string,
  def: ConnectorDef,
  patch: { status: "connected" } | { status: "error"; error: string },
): Promise<void> {
  await userCol(uid, "integrations").doc(def.meta.id).set(
    {
      provider: def.meta.id,
      ...patch,
      ...(patch.status === "connected"
        ? { error: FieldValue.delete(), verifiedAt: FieldValue.serverTimestamp() }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function verifyFieldsConnector(
  uid: string,
  def: ConnectorDef,
  res: Response,
): Promise<void> {
  const snap = await userCol(uid, "secrets").doc(def.meta.id).get();
  const encryptedFields = (snap.data() as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!encryptedFields || Object.keys(encryptedFields).length === 0) {
    res.status(422).json({ ok: false, reason: "not_connected" });
    return;
  }
  try {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(encryptedFields)) {
      if (typeof v === "string") fields[k] = await decryptSecret(v);
    }
    const identity = await def.validateFields!(fields);
    await setVerifyStatus(uid, def, { status: "connected" });
    res.json({ ok: true, accountLabel: identity.accountLabel });
  } catch (err) {
    logger.warn(`[connect] ${def.meta.id} fields verify failed for uid=${uid}: ${(err as Error).message}`);
    await setVerifyStatus(uid, def, { status: "error", error: "verify_failed" });
    res.status(502).json({ ok: false, reason: "provider_rejected" });
  }
}

async function verifyTokenConnector(
  uid: string,
  def: ConnectorDef,
  res: Response,
): Promise<void> {
  const fresh = await getFreshAccessToken(uid, def);
  if (!fresh.ok) {
    if (fresh.reason === "reauth_required") {
      await setVerifyStatus(uid, def, { status: "error", error: "reauth_required" });
      res.status(409).json({ ok: false, reason: fresh.reason });
      return;
    }
    res.status(422).json({ ok: false, reason: fresh.reason });
    return;
  }
  try {
    const identity = await def.fetchIdentity(fresh.accessToken);
    const probe = def.deepProbe ? await def.deepProbe(fresh.accessToken) : null;
    await setVerifyStatus(uid, def, { status: "connected" });
    res.json({ ok: true, accountLabel: identity.accountLabel, ...(probe ? { probe } : {}) });
  } catch (err) {
    logger.warn(`[connect] ${def.meta.id} verify failed for uid=${uid}: ${err instanceof Error ? err.message : String(err)}`);
    await setVerifyStatus(uid, def, { status: "error", error: "verify_failed" });
    res.status(502).json({ ok: false, reason: "provider_rejected" });
  }
}

router.post(
  "/:connector/verify",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def) {
        res.status(404).json({ error: "Unknown connector" });
        return;
      }
      if (def.validateFields && def.meta.captureMethods.includes("fields")) {
        await verifyFieldsConnector(req.uid!, def, res);
      } else {
        await verifyTokenConnector(req.uid!, def, res);
      }
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/:connector/auth-url",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def?.oauth) {
        res.status(404).json({ error: "Unknown connector" });
        return;
      }
      const creds = await readConnectorClientCreds(req.uid!, def);
      if (!creds) {
        if (def.meta.clientSource === "per-user") {
          res.status(422).json({
            error: `${def.meta.displayName} client not configured`,
            reason: "client_not_configured",
          });
          return;
        }
        logger.error(`[connect] ${def.meta.id} unavailable: ${def.oauth.clientIdEnv} is not set`);
        res.status(503).json({ error: `${def.meta.displayName} connection is not configured` });
        return;
      }

      const returnUrl = sanitizeReturnUrl(req.query.returnUrl as string | undefined);
      const { state, nonce, expiresAt } = generateConnectState({
        uid: req.uid!,
        connector: def.meta.id,
        returnUrl,
      });
      await flowsCol().doc(nonce).set({
        uid: req.uid!,
        connector: def.meta.id,
        kind: "oauth-web",
        clientSource: creds.source,
        createdAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromDate(expiresAt),
      });

      const params = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: connectorRedirectUri(def),
        response_type: "code",
        scope: grantedScopes(def, creds.source).join(" "),
        state,
        ...(def.oauth.extraAuthParams ?? {}),
      });
      res.json({ url: `${def.oauth.authorizeUrl}?${params}` });
    } catch (e) {
      next(e);
    }
  },
);

async function consumeFlowNonce(
  payload: ConnectStatePayload,
  connectorId: string,
): Promise<{ clientSource?: "platform" | "per-user" }> {
  return db.runTransaction(async (tx) => {
    const ref = flowsCol().doc(payload.nonce);
    const snap = await tx.get(ref);
    const flow = snap.data() as
      | { uid?: string; connector?: string; consumedAt?: unknown; clientSource?: unknown }
      | undefined;
    if (!snap.exists || !flow || flow.consumedAt || flow.uid !== payload.uid || flow.connector !== connectorId) {
      throw new Error("state nonce unknown or already consumed");
    }
    tx.set(ref, { consumedAt: FieldValue.serverTimestamp() }, { merge: true });
    return {
      clientSource:
        flow.clientSource === "platform" || flow.clientSource === "per-user"
          ? flow.clientSource
          : undefined,
    };
  });
}

router.get("/:connector/callback", async (req: Request, res: Response) => {
  const def = getConnector(req.params.connector as string);
  if (!def?.oauth) {
    res.status(404).json({ error: "Unknown connector" });
    return;
  }
  const { code, state, error: authError } = req.query as Record<string, string | undefined>;

  let payload: ConnectStatePayload;
  let flowPin: { clientSource?: "platform" | "per-user" };
  try {
    payload = verifyConnectState(String(state ?? ""));
    if (payload.connector !== def.meta.id) {
      throw new Error(`state minted for ${payload.connector}, presented to ${def.meta.id}`);
    }
    flowPin = await consumeFlowNonce(payload, def.meta.id);
  } catch (err) {
    logger.warn(`[connect] ${def.meta.id} callback rejected: ${(err as Error).message}`);
    res.redirect(`${APP_URL}/dashboard?connect_error=invalid_state`);
    return;
  }

  if (authError || !code) {
    res.redirect(
      buildOAuthRedirect(payload.returnUrl, APP_URL, {
        connect_error: authError ? "cancelled" : "invalid",
      }),
    );
    return;
  }

  try {
    const creds = await readConnectorClientCreds(payload.uid, def, flowPin.clientSource);
    if (!creds) {
      throw new Error(
        `connector client credentials missing at exchange time (pinned source: ${flowPin.clientSource ?? "unpinned"})`,
      );
    }
    const tokens = await exchangeAuthCode(def, code, creds);
    const identity = await def.fetchIdentity(tokens.access_token);
    await storeConnectorTokens({
      uid: payload.uid,
      def,
      tokens,
      accountLabel: identity.accountLabel,
      captureMethod: "oauth-web",
      clientSource: creds.source,
    });
    res.redirect(
      buildOAuthRedirect(payload.returnUrl, APP_URL, {
        [`${def.meta.id}_connected`]: "true",
        [`${def.meta.id}_account`]: identity.accountLabel,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[connect] ${def.meta.id} connect failed for uid=${payload.uid}: ${msg}`);
    try {
      await userCol(payload.uid, "integrations").doc(def.meta.id).set(
        {
          provider: def.meta.id,
          status: "error",
          error: msg.slice(0, 300),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (statusErr) {
      logger.error(`[connect] ${def.meta.id} error-status write failed for uid=${payload.uid}: ${String(statusErr)}`);
    }
    res.redirect(
      buildOAuthRedirect(payload.returnUrl, APP_URL, {
        connect_error: `${def.meta.id}_failed`,
      }),
    );
  }
});

router.post(
  "/:connector/pat",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def || !def.meta.captureMethods.includes("pat")) {
        res.status(404).json({ error: "Unknown connector or PAT capture not supported" });
        return;
      }
      const token = (req.body ?? {}).token;
      if (typeof token !== "string" || token.trim().length === 0) {
        res.status(400).json({ error: "token required" });
        return;
      }

      let accountLabel: string;
      try {
        ({ accountLabel } = await def.fetchIdentity(token.trim()));
      } catch (err) {
        logger.warn(`[connect] ${def.meta.id} PAT rejected for uid=${req.uid}: ${(err as Error).message}`);
        res.status(400).json({ error: "Token was rejected by the provider" });
        return;
      }

      await storeConnectorTokens({
        uid: req.uid!,
        def,
        tokens: { access_token: token.trim() },
        accountLabel,
        captureMethod: "pat",
      });
      res.json({ ok: true, accountLabel });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/:connector/fields",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def?.validateFields || !def.meta.captureMethods.includes("fields")) {
        res.status(404).json({ error: "Unknown connector or fields capture not supported" });
        return;
      }
      const expected = def.meta.captureFields ?? [];
      const body = ((req.body ?? {}).fields ?? {}) as Record<string, unknown>;
      const fields: Record<string, string> = {};
      for (const f of expected) {
        const v = body[f.key];
        if (typeof v !== "string" || v.trim().length === 0) {
          res.status(400).json({ error: `${f.label} is required` });
          return;
        }
        fields[f.key] = v.trim();
      }

      let accountLabel: string;
      try {
        ({ accountLabel } = await def.validateFields(fields));
      } catch (err) {
        logger.warn(`[connect] ${def.meta.id} fields rejected for uid=${req.uid}: ${(err as Error).message}`);
        res.status(400).json({ error: "The provider rejected these credentials" });
        return;
      }

      const encryptedFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        encryptedFields[k] = await encryptSecret(v);
      }
      await userCol(req.uid!, "secrets").doc(def.meta.id).set({
        provider: def.meta.id,
        fields: encryptedFields,
        updatedAt: FieldValue.serverTimestamp(),
      });
      await userCol(req.uid!, "integrations").doc(def.meta.id).set({
        provider: def.meta.id,
        status: "connected",
        accountLabel,
        scopes: [],
        captureMethod: "fields",
        connectedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.info(`[connect] ${def.meta.id} connected for uid=${req.uid} via fields (${accountLabel})`);
      res.json({ ok: true, accountLabel });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/:connector/device/start",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def?.device || !def.meta.captureMethods.includes("device")) {
        res.status(404).json({ error: "Unknown connector or device flow not supported" });
        return;
      }
      const clientId = process.env[def.device.clientIdEnv];
      if (!clientId) {
        logger.error(`[connect] ${def.meta.id} unavailable: ${def.device.clientIdEnv} is not set`);
        res.status(503).json({ error: `${def.meta.displayName} connection is not configured` });
        return;
      }

      const resp = await fetch(def.device.codeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ client_id: clientId, scope: def.meta.scopes.join(" ") }),
      });
      if (!resp.ok) {
        throw new Error(`device code request failed: ${resp.status}`);
      }
      const out = (await resp.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        expires_in: number;
        interval?: number;
      };

      const flowId = crypto.randomUUID();
      await flowsCol().doc(flowId).set({
        uid: req.uid!,
        connector: def.meta.id,
        kind: "device",
        encryptedDeviceCode: await encryptSecret(out.device_code),
        createdAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + out.expires_in * 1000),
      });

      res.json({
        flowId,
        userCode: out.user_code,
        verificationUri: out.verification_uri,
        interval: out.interval ?? 5,
        expiresIn: out.expires_in,
      });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/:connector/device/poll",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const def = getConnector(req.params.connector as string);
      if (!def?.device) {
        res.status(404).json({ error: "Unknown connector or device flow not supported" });
        return;
      }
      const flowId = (req.body ?? {}).flowId;
      if (typeof flowId !== "string" || !flowId) {
        res.status(400).json({ error: "flowId required" });
        return;
      }

      const ref = flowsCol().doc(flowId);
      const snap = await ref.get();
      const flow = snap.data() as
        | {
            uid?: string;
            connector?: string;
            kind?: string;
            encryptedDeviceCode?: string;
            consumedAt?: unknown;
          }
        | undefined;
      if (
        !snap.exists ||
        !flow ||
        flow.uid !== req.uid ||
        flow.connector !== def.meta.id ||
        flow.kind !== "device" ||
        flow.consumedAt ||
        typeof flow.encryptedDeviceCode !== "string"
      ) {
        res.status(404).json({ error: "flow not found" });
        return;
      }
      const deviceCode = await decryptSecret(flow.encryptedDeviceCode);

      const clientId = process.env[def.device.clientIdEnv];
      if (!clientId) {
        res.status(503).json({ error: `${def.meta.displayName} connection is not configured` });
        return;
      }
      const resp = await fetch(def.device.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      if (!resp.ok) {
        throw new Error(`device token poll failed: ${resp.status}`);
      }
      const out = (await resp.json()) as TokenResponse & { error?: string };

      if (out.error === "authorization_pending" || out.error === "slow_down") {
        res.json({ status: "pending" });
        return;
      }
      if (out.error || !out.access_token) {
        await ref.set({ consumedAt: FieldValue.serverTimestamp() }, { merge: true });
        logger.warn(`[connect] ${def.meta.id} device flow failed for uid=${req.uid}: ${out.error ?? "no_access_token"}`);
        res.json({ status: "failed", reason: out.error ?? "no_access_token" });
        return;
      }

      const identity = await def.fetchIdentity(out.access_token);
      await storeConnectorTokens({
        uid: req.uid!,
        def,
        tokens: out,
        accountLabel: identity.accountLabel,
        captureMethod: "device",
      });
      await ref.set({ consumedAt: FieldValue.serverTimestamp() }, { merge: true });
      res.json({ status: "connected", accountLabel: identity.accountLabel });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
