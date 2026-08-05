// @ts-expect-error resolved by the OpenClaw runtime
import { definePluginEntry, jsonResult } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

import {
  AccessToolError,
  type AccessBrokerOptions,
  accessApprovalStatus,
  listAccess,
  prepareAccess,
  recommendAccess,
} from "./access-client.js";

interface ToolContext {
  agentId?: unknown;
  sessionId?: unknown;
  agentAccountId?: unknown;
  messageChannel?: unknown;
  nativeChannelId?: unknown;
  requesterSenderId?: unknown;
  deliveryContext?: {
    accountId?: unknown;
    channel?: unknown;
    to?: unknown;
  };
}
interface PluginApi {
  pluginConfig?: unknown;
  registerTool: (factory: (context: ToolContext) => unknown, meta: { name: string }) => void;
  logger?: { info?: (message: string) => void };
}

function preparedOperation(operation: unknown): "grant" | "change" | "revoke" {
  if (operation === "prepare_revoke") return "revoke";
  if (operation === "prepare_change") return "change";
  return "grant";
}

function requestContextOf(ctx: ToolContext): AccessBrokerOptions["requestContext"] | null {
  const directChannel = ctx.messageChannel;
  const deliveryChannel = ctx.deliveryContext?.channel;
  if (
    typeof directChannel === "string"
    && typeof deliveryChannel === "string"
    && directChannel !== deliveryChannel
  ) return null;
  const channel = typeof directChannel === "string" ? directChannel : deliveryChannel;
  const directAccountId = ctx.agentAccountId;
  const deliveryAccountId = ctx.deliveryContext?.accountId;
  if (
    typeof directAccountId === "string"
    && typeof deliveryAccountId === "string"
    && directAccountId !== deliveryAccountId
  ) return null;
  const accountId = typeof directAccountId === "string" ? directAccountId : deliveryAccountId;
  const requesterSenderId = ctx.requesterSenderId;
  const nativeChannelId = ctx.nativeChannelId;
  const to = ctx.deliveryContext?.to;
  if (
    channel !== "mattermost"
    || typeof accountId !== "string"
    || typeof requesterSenderId !== "string"
    || !/^[a-z0-9]{26}$/u.test(requesterSenderId)
    || typeof nativeChannelId !== "string"
    || !/^[a-z0-9]{26}$/u.test(nativeChannelId)
    || typeof to !== "string"
    || !/^(?:channel|user):[a-z0-9]{26}$/u.test(to)
  ) return null;
  return { channel, accountId, requesterSenderId, nativeChannelId, to };
}

export default definePluginEntry({
  id: "octogee-access-tools",
  name: "Octogee Access Tools",
  description: "Recommend and prepare owner-reviewed delegated Agent access.",
  register(api: PluginApi) {
    const config = (api.pluginConfig ?? {}) as { brokerUrl?: string; tokenPath?: string };
    api.registerTool((context) => ({
      name: "delegated_access",
      description:
        "List Agent access, recommend the narrowest role, or prepare a grant/change/revoke for the owner to approve in Octogee. This tool never activates or revokes access by itself.",
      parameters: Type.Object({
        operation: Type.Union([
          Type.Literal("list"),
          Type.Literal("recommend"),
          Type.Literal("prepare_grant"),
          Type.Literal("prepare_change"),
          Type.Literal("prepare_revoke"),
          Type.Literal("status"),
        ]),
        task: Type.Optional(Type.String()),
        granteeUid: Type.Optional(Type.String()),
        permissionSetIds: Type.Optional(Type.Array(Type.String())),
        expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        expectedRevision: Type.Optional(Type.Number()),
        reason: Type.Optional(Type.String()),
        approvalId: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, input: Record<string, unknown>) {
        const agentId = typeof context.agentId === "string" ? context.agentId : null;
        if (!agentId) return jsonResult({ error: "delegated_access requires a coach agent" });
        const requestContext = requestContextOf(context);
        if (!requestContext) {
          return jsonResult({
            error: "delegated_access requires verified Mattermost sender and route context",
            code: "request-context-required",
          });
        }
        const options = { agentId, requestContext, ...config };
        try {
          if (input.operation === "list") return jsonResult(await listAccess(options));
          if (input.operation === "recommend") {
            return jsonResult(await recommendAccess(String(input.task ?? ""), options));
          }
          if (input.operation === "status") {
            return jsonResult(await accessApprovalStatus(String(input.approvalId ?? ""), options));
          }
          const operation = preparedOperation(input.operation);
          return jsonResult(await prepareAccess({
            operation,
            granteeUid: input.granteeUid,
            permissionSetIds: input.permissionSetIds,
            expiresAt: input.expiresAt ?? null,
            expectedRevision: input.expectedRevision,
            reason: input.reason,
            sessionId: typeof context.sessionId === "string" ? context.sessionId : "unknown-session",
          }, options));
        } catch (error) {
          const code = error instanceof AccessToolError ? error.code : "error";
          const message = error instanceof Error ? error.message : String(error);
          return jsonResult({ error: message, code });
        }
      },
    }), { name: "delegated_access" });
    api.logger?.info?.("[access-tools] delegated_access registered");
  },
});
