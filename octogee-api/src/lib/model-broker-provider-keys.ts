import type { Firestore } from "firebase-admin/firestore";

import type {
  ModelBrokerProvider,
  ModelBrokerTokenRecord,
} from "./model-broker-tokens.js";
import { readSecret as defaultReadSecret } from "../../../scripts/lib/secret-manager.js";

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
  db: Pick<Firestore, "collection">;
  platformKey?: string;
  readSecret?: (name: string) => Promise<string>;
}

type AnthropicConfiguredCredentialResolution =
  | { kind: "platform" }
  | { kind: "deny" }
  | { kind: "owner_model_credential"; secretName: string };

export type AnthropicModelCredentialResolution =
  | { kind: "fallback" }
  | AnthropicConfiguredCredentialResolution;

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

function byotRecord(
  configData: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  return objectRecord(configData?.byot);
}

function modelCredentialRecord(
  configData: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  return objectRecord(configData?.modelCredential);
}

function expectedAnthropicSecretName(slug: string): string {
  return `byok-${slug}-anthropic`;
}

export function configuredAnthropicModelCredentialResolution(
  userData: Record<string, unknown> | undefined,
  configData: Record<string, unknown> | undefined,
): AnthropicModelCredentialResolution {
  const credential = modelCredentialRecord(configData);
  if (!credential) return { kind: "fallback" };
  if (
    credential.active !== true ||
    credential.provider !== "anthropic" ||
    credential.mode !== "api_key"
  ) {
    return { kind: "platform" };
  }
  const slug = ownerSlug(userData);
  if (!slug) return { kind: "deny" };
  const expected = expectedAnthropicSecretName(slug);
  return credential.secretName === expected
    ? { kind: "owner_model_credential", secretName: expected }
    : { kind: "deny" };
}

function configuredAnthropicByotResolution(
  userData: Record<string, unknown> | undefined,
  configData: Record<string, unknown> | undefined,
): AnthropicConfiguredCredentialResolution {
  if (userData?.byotActive !== true) return { kind: "platform" };
  const byot = byotRecord(configData);
  if (byot?.provider !== "anthropic") return { kind: "platform" };
  const slug = ownerSlug(userData);
  if (!slug) return { kind: "deny" };
  const expected = expectedAnthropicSecretName(slug);
  return byot.secretName === expected
    ? { kind: "owner_model_credential", secretName: expected }
    : { kind: "deny" };
}

function platformKeyResolution(platformKey: string | undefined): ModelBrokerProviderKey | null {
  const apiKey = platformKey?.trim();
  return apiKey ? { apiKey, source: "platform" } : null;
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
    const modelCredentialResolution = configuredAnthropicModelCredentialResolution(
      userData,
      configData,
    );
    const resolution = modelCredentialResolution.kind === "fallback"
      ? configuredAnthropicByotResolution(userData, configData)
      : modelCredentialResolution;
    if (resolution.kind === "deny") return null;
    if (resolution.kind === "platform") return platformKeyResolution(deps.platformKey);

    const apiKey = (await readSecret(resolution.secretName)).trim();
    return apiKey
      ? { apiKey, source: "owner_model_credential", secretName: resolution.secretName }
      : null;
  };
}
