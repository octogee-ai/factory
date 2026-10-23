import type { Firestore } from "firebase-admin/firestore";
import { readGatewayAuthorization } from "@octogee/core/gateway-live-release";
import { userAssignmentMatchesGateway } from "@octogee/core/assigned-roster";

import type {
  ModelBrokerProvider,
  ModelBrokerTokenRecord,
} from "./model-broker-tokens.js";
import { readSecret as defaultReadSecret } from "@octogee/core/secret-manager";

export type ModelBrokerProviderKeySource = "platform" | "owner_model_credential";

export interface ModelBrokerProviderKey {
  apiKey: string;
  source: ModelBrokerProviderKeySource;
  secretName?: string;
}

export interface ResolveModelBrokerProviderKeyInput {
  provider: ModelBrokerProvider;
  record: ModelBrokerTokenRecord;
}

export type ModelBrokerProviderKeyResolver = (
  input: ResolveModelBrokerProviderKeyInput,
) => Promise<ModelBrokerProviderKey | null>;

export interface AnthropicProviderKeyResolverDeps {
  db: Pick<Firestore, "collection" | "doc">;
  platformKey?: string;
  readSecret?: (name: string) => Promise<string>;
}

export interface ModelBrokerProviderKeyResolverDeps {
  db: Pick<Firestore, "collection" | "doc">;
  platformKeys?: Partial<Record<ModelBrokerProvider, string | undefined>>;
  readSecret?: (name: string) => Promise<string>;
}

export type AnthropicModelCredentialResolution =
  | { kind: "platform" }
  | { kind: "deny" }
  | { kind: "owner_model_credential"; secretName: string };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ownerSlug(userData: Record<string, unknown> | undefined): string | null {
  const provisioning = objectRecord(userData?.provisioning);
  const openclaw = objectRecord(provisioning?.openclaw);
  const slug = openclaw?.slug ?? userData?.username ?? userData?.workspaceId;
  return typeof slug === "string" && SLUG_PATTERN.test(slug) ? slug : null;
}

export function configuredAnthropicModelCredentialResolution(
  userData: Record<string, unknown> | undefined,
  configData: Record<string, unknown> | undefined,
): AnthropicModelCredentialResolution {
  const credential = objectRecord(configData?.modelCredential);
  if (
    credential?.active !== true ||
    credential.provider !== "anthropic" ||
    credential.mode !== "api_key"
  ) {
    return { kind: "platform" };
  }
  const slug = ownerSlug(userData);
  if (!slug) return { kind: "deny" };
  const expected = `byok-${slug}-anthropic`;
  return credential.secretName === expected
    ? { kind: "owner_model_credential", secretName: expected }
    : { kind: "deny" };
}

function platformKeyResolution(platformKey: string | undefined): ModelBrokerProviderKey | null {
  const apiKey = platformKey?.trim();
  return apiKey ? { apiKey, source: "platform" } : null;
}

function assignedBuilderOwnsKey(
  record: ModelBrokerTokenRecord,
  userData: Record<string, unknown> | undefined,
  authorization: Awaited<ReturnType<typeof readGatewayAuthorization>>,
): boolean {
  return authorization?.config.gatewayClass === "builder" &&
    authorization.config.ownerUid === record.ownerUid &&
    userAssignmentMatchesGateway(userData, record.gatewayId, authorization.config.builderSlug);
}

export function createAnthropicProviderKeyResolver(
  deps: AnthropicProviderKeyResolverDeps,
): ModelBrokerProviderKeyResolver {
  const readSecret = deps.readSecret ?? defaultReadSecret;
  return async ({ provider, record }) => {
    if (provider !== "anthropic") return null;
    if (!record.ownerUid) return platformKeyResolution(deps.platformKey);

    const [userSnap, configSnap] = await Promise.all([
      deps.db.collection("users").doc(record.ownerUid).get(),
      deps.db.collection("users").doc(record.ownerUid).collection("system").doc("config").get(),
    ]);
    const userData = userSnap.data() as Record<string, unknown> | undefined;
    const configData = configSnap.data() as Record<string, unknown> | undefined;
    const authorization = await readGatewayAuthorization(deps.db, record.gatewayId);
    if (!authorization) return null;
    if (authorization.config.gatewayClass === "shared") return platformKeyResolution(deps.platformKey);
    if (!assignedBuilderOwnsKey(record, userData, authorization)) return null;
    const resolution = configuredAnthropicModelCredentialResolution(userData, configData);
    if (resolution.kind === "deny") return null;
    if (resolution.kind === "platform") return platformKeyResolution(deps.platformKey);

    const apiKey = (await readSecret(resolution.secretName)).trim();
    const [currentUser, currentConfig] = await Promise.all([
      deps.db.collection("users").doc(record.ownerUid).get(),
      deps.db.collection("users").doc(record.ownerUid).collection("system").doc("config").get(),
    ]);
    const current = await readGatewayAuthorization(deps.db, record.gatewayId);
    if (!assignedBuilderOwnsKey(record, currentUser.data(), current)) return null;
    const currentResolution = configuredAnthropicModelCredentialResolution(currentUser.data(), currentConfig.data());
    if (currentResolution.kind !== "owner_model_credential" || currentResolution.secretName !== resolution.secretName) return null;
    return apiKey
      ? { apiKey, source: "owner_model_credential", secretName: resolution.secretName }
      : null;
  };
}

export function createModelBrokerProviderKeyResolver(
  deps: ModelBrokerProviderKeyResolverDeps,
): ModelBrokerProviderKeyResolver {
  const anthropic = createAnthropicProviderKeyResolver({
    db: deps.db,
    platformKey: deps.platformKeys?.anthropic,
    readSecret: deps.readSecret,
  });
  return async (input) => {
    if (input.provider === "anthropic") return anthropic(input);
    if (input.provider === "openrouter") {
      return platformKeyResolution(deps.platformKeys?.openrouter);
    }
    if (input.provider === "openai") {
      return platformKeyResolution(deps.platformKeys?.openai);
    }
    return null;
  };
}
