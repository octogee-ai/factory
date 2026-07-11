export type ModelCredentialActiveStaticProviderId =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'grok'
  | 'minimax'
  | 'openai-compatible';

export type ModelCredentialConnectorOnlyProviderId = 'gemini';

export type ModelCredentialStaticProviderId =
  | ModelCredentialActiveStaticProviderId
  | ModelCredentialConnectorOnlyProviderId;

export type ModelCredentialOAuthProviderId = 'openai-codex' | 'claude-cli';

export type ModelCredentialProviderId =
  | ModelCredentialStaticProviderId
  | ModelCredentialOAuthProviderId;

export const MODEL_CREDENTIAL_MODES = [
  'api_key',
  'token',
  'oauth',
] as const;

export type ModelCredentialMode = typeof MODEL_CREDENTIAL_MODES[number];

export type ModelCredentialSubscriptionProviderId = 'openai' | 'anthropic';

export type ModelCredentialOAuthGatewayFlow = 'device-auth' | 'claude-sso';

export type ModelCredentialStateStatus =
  | 'active'
  | 'needs_reauth'
  | 'missing'
  | 'invalid'
  | 'sync_pending';

export type ModelCredentialStateReasonCode =
  | 'ok'
  | 'missing_credential'
  | 'invalid_expires'
  | 'expired'
  | 'unresolved_ref'
  | 'no_model';

export type ModelCredentialCaptureMethod =
  | 'api-key'
  | 'device-oauth'
  | 'sso-oauth';

export type ModelCredentialStaticStorage = {
  kind: 'secret-manager';
  secretNamePrefix: 'byok';
};

export type ModelCredentialConnectorOnlyStorage = {
  kind: 'connector-secret';
  pathTemplate: 'users/{uid}/secrets/{provider}';
};

export type ModelCredentialOAuthStorage = {
  kind: 'oauth-secret-manager';
  secretNamePrefix: 'byosub';
};

export type ModelCredentialStorage =
  | ModelCredentialStaticStorage
  | ModelCredentialConnectorOnlyStorage
  | ModelCredentialOAuthStorage;

export type ModelCredentialActiveStaticMaterialization =
  | { kind: 'auth-profile'; writesAuthJson: false }
  | { kind: 'custom-openai-provider'; writesAuthJson: false };

export type ModelCredentialConnectorOnlyMaterialization = {
  kind: 'connector-only';
  writesAuthJson: false;
};

export type ModelCredentialStaticMaterialization =
  | ModelCredentialActiveStaticMaterialization
  | ModelCredentialConnectorOnlyMaterialization;

export type ModelCredentialOAuthMaterialization = {
  kind: 'oauth-profile-store';
  writesAuthJson: boolean;
};

export type ModelCredentialMaterialization =
  | ModelCredentialStaticMaterialization
  | ModelCredentialOAuthMaterialization;

export type ModelCredentialBaseUrl =
  | { kind: 'none' }
  | { kind: 'canonical'; value: string }
  | { kind: 'user'; requiresHttps: true };

export interface ModelCredentialModel {
  required: boolean;
}

export interface ModelCredentialOpenClawBase {
  authProvider: string;
  configProfileId: string | null;
  storeProfileId: string | null;
}

export type ModelCredentialStaticOpenClaw = ModelCredentialOpenClawBase & {
  secretRefAllowed: true;
};

export type ModelCredentialOAuthOpenClaw = ModelCredentialOpenClawBase & {
  secretRefAllowed: false;
};

export type ModelCredentialConnectorOnlyOpenClaw = ModelCredentialOpenClawBase & {
  secretRefAllowed: false;
};

export type ModelCredentialOpenClaw =
  | ModelCredentialStaticOpenClaw
  | ModelCredentialConnectorOnlyOpenClaw
  | ModelCredentialOAuthOpenClaw;

export interface ModelCredentialDefaults {
  model: string | null;
}

export interface ModelCredentialOAuthRuntime {
  subscriptionProvider: ModelCredentialSubscriptionProviderId;
  secretProvider: ModelCredentialSubscriptionProviderId;
  gatewayFlow: ModelCredentialOAuthGatewayFlow;
}

export interface ModelCredentialCatalogBase<Id extends ModelCredentialProviderId> {
  id: Id;
  displayName: string;
  captureMethods: readonly ModelCredentialCaptureMethod[];
  implemented: boolean;
  baseUrl: ModelCredentialBaseUrl;
  model: ModelCredentialModel;
  defaults: ModelCredentialDefaults;
}

export interface ModelCredentialActiveStaticCatalogEntry
  extends ModelCredentialCatalogBase<ModelCredentialActiveStaticProviderId> {
  modes: readonly ['api_key'];
  activeSlotEligible: true;
  connectorOnlyUntilRouted?: never;
  storage: ModelCredentialStaticStorage;
  materialization: ModelCredentialActiveStaticMaterialization;
  openclaw: ModelCredentialStaticOpenClaw;
}

export interface ModelCredentialConnectorOnlyCatalogEntry
  extends ModelCredentialCatalogBase<ModelCredentialConnectorOnlyProviderId> {
  modes: readonly ['api_key'];
  activeSlotEligible: false;
  connectorOnlyUntilRouted: true;
  storage: ModelCredentialConnectorOnlyStorage;
  materialization: ModelCredentialConnectorOnlyMaterialization;
  openclaw: ModelCredentialConnectorOnlyOpenClaw;
}

export interface ModelCredentialOAuthCatalogEntry
  extends ModelCredentialCatalogBase<ModelCredentialOAuthProviderId> {
  modes: readonly ['oauth'];
  activeSlotEligible: true;
  connectorOnlyUntilRouted?: never;
  storage: ModelCredentialOAuthStorage;
  materialization: ModelCredentialOAuthMaterialization;
  openclaw: ModelCredentialOAuthOpenClaw;
  oauth: ModelCredentialOAuthRuntime;
}

export type ModelCredentialStaticCatalogEntry =
  | ModelCredentialActiveStaticCatalogEntry
  | ModelCredentialConnectorOnlyCatalogEntry;

export type ModelCredentialCatalogEntry =
  | ModelCredentialStaticCatalogEntry
  | ModelCredentialOAuthCatalogEntry;

export interface ModelCredentialStateBase {
  active: boolean;
  provider: ModelCredentialProviderId;
  mode: ModelCredentialMode;
  status: ModelCredentialStateStatus;
  reasonCode: ModelCredentialStateReasonCode;
  secretName: string;
  addedAt?: unknown;
  lastUsedAt: unknown | null;
  lastProbeAt?: unknown;
  lastSyncAt?: unknown;
}

export interface ModelCredentialApiKeyState extends ModelCredentialStateBase {
  provider: ModelCredentialActiveStaticProviderId;
  mode: 'api_key';
  fingerprint: string;
  keyHash: string;
  baseUrl?: string;
  model?: string;
}

export interface ModelCredentialOAuthState extends ModelCredentialStateBase {
  provider: ModelCredentialOAuthProviderId;
  mode: 'oauth';
}

export type ModelCredentialState =
  | ModelCredentialApiKeyState
  | ModelCredentialOAuthState;

const STATIC_SECRET_STORAGE = {
  kind: 'secret-manager',
  secretNamePrefix: 'byok',
} as const satisfies ModelCredentialStaticStorage;

const OAUTH_SECRET_STORAGE = {
  kind: 'oauth-secret-manager',
  secretNamePrefix: 'byosub',
} as const satisfies ModelCredentialOAuthStorage;

const CONNECTOR_SECRET_STORAGE = {
  kind: 'connector-secret',
  pathTemplate: 'users/{uid}/secrets/{provider}',
} as const satisfies ModelCredentialConnectorOnlyStorage;

export const MODEL_CREDENTIAL_CATALOG = [
  {
    id: 'openai',
    displayName: 'OpenAI API key',
    modes: ['api_key'],
    captureMethods: ['api-key'],
    implemented: true,
    activeSlotEligible: true,
    storage: STATIC_SECRET_STORAGE,
    materialization: { kind: 'auth-profile', writesAuthJson: false },
    baseUrl: { kind: 'none' },
    model: { required: false },
    openclaw: {
      authProvider: 'openai',
      configProfileId: 'openai:default',
      storeProfileId: 'openai:default',
      secretRefAllowed: true,
    },
    defaults: { model: 'openai/gpt-5' },
  },
  {
    id: 'openai-codex',
    displayName: 'ChatGPT subscription',
    modes: ['oauth'],
    captureMethods: ['device-oauth'],
    implemented: true,
    activeSlotEligible: true,
    storage: OAUTH_SECRET_STORAGE,
    materialization: { kind: 'oauth-profile-store', writesAuthJson: true },
    oauth: {
      subscriptionProvider: 'openai',
      secretProvider: 'openai',
      gatewayFlow: 'device-auth',
    },
    baseUrl: { kind: 'none' },
    model: { required: false },
    openclaw: {
      authProvider: 'openai-codex',
      configProfileId: 'openai-codex',
      storeProfileId: 'openai-codex:default',
      secretRefAllowed: false,
    },
    defaults: { model: 'openai/gpt-5.5' },
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic API key',
    modes: ['api_key'],
    captureMethods: ['api-key'],
    implemented: true,
    activeSlotEligible: true,
    storage: STATIC_SECRET_STORAGE,
    materialization: { kind: 'auth-profile', writesAuthJson: false },
    baseUrl: { kind: 'none' },
    model: { required: false },
    openclaw: {
      authProvider: 'anthropic',
      configProfileId: 'anthropic:default',
      storeProfileId: 'anthropic:default',
      secretRefAllowed: true,
    },
    defaults: { model: null },
  },
  {
    id: 'claude-cli',
    displayName: 'Claude subscription',
    modes: ['oauth'],
    captureMethods: ['sso-oauth'],
    implemented: true,
    activeSlotEligible: true,
    storage: OAUTH_SECRET_STORAGE,
    materialization: { kind: 'oauth-profile-store', writesAuthJson: false },
    oauth: {
      subscriptionProvider: 'anthropic',
      secretProvider: 'anthropic',
      gatewayFlow: 'claude-sso',
    },
    baseUrl: { kind: 'none' },
    model: { required: false },
    openclaw: {
      authProvider: 'claude-cli',
      configProfileId: 'anthropic:claude-cli',
      storeProfileId: 'anthropic:claude-cli',
      secretRefAllowed: false,
    },
    defaults: { model: 'claude-cli/claude-opus-4-8' },
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    modes: ['api_key'],
    captureMethods: ['api-key'],
    implemented: true,
    activeSlotEligible: true,
    storage: STATIC_SECRET_STORAGE,
    materialization: { kind: 'custom-openai-provider', writesAuthJson: false },
    baseUrl: { kind: 'canonical', value: 'https://openrouter.ai/api/v1' },
    model: { required: true },
    openclaw: {
      authProvider: 'openrouter',
      configProfileId: null,
      storeProfileId: null,
      secretRefAllowed: true,
    },
    defaults: { model: null },
  },
  {
    id: 'grok',
    displayName: 'Grok',
    modes: ['api_key'],
    captureMethods: ['api-key'],
    implemented: true,
    activeSlotEligible: true,
    storage: STATIC_SECRET_STORAGE,
    materialization: { kind: 'custom-openai-provider', writesAuthJson: false },
    baseUrl: { kind: 'canonical', value: 'https://api.x.ai/v1' },
    model: { required: true },
    openclaw: {
      authProvider: 'grok',
      configProfileId: null,
      storeProfileId: null,
      secretRefAllowed: true,
    },
    defaults: { model: null },
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    modes: ['api_key'],
    captureMethods: ['api-key'],
    implemented: true,
    activeSlotEligible: true,
    storage: STATIC_SECRET_STORAGE,
    materialization: { kind: 'custom-openai-provider', writesAuthJson: false },
    baseUrl: { kind: 'canonical', value: 'https://api.minimax.io/v1' },
    model: { required: true },
    openclaw: {
      authProvider: 'minimax',
      configProfileId: null,
      storeProfileId: null,
      secretRefAllowed: true,
    },
    defaults: { model: null },
  },
  {
    id: 'openai-compatible',
    displayName: 'Custom OpenAI-compatible',
    modes: ['api_key'],
    captureMethods: ['api-key'],
    implemented: true,
    activeSlotEligible: true,
    storage: STATIC_SECRET_STORAGE,
    materialization: { kind: 'custom-openai-provider', writesAuthJson: false },
    baseUrl: { kind: 'user', requiresHttps: true },
    model: { required: true },
    openclaw: {
      authProvider: 'openai-compatible',
      configProfileId: null,
      storeProfileId: null,
      secretRefAllowed: true,
    },
    defaults: { model: null },
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    modes: ['api_key'],
    captureMethods: ['api-key'],
    implemented: true,
    activeSlotEligible: false,
    connectorOnlyUntilRouted: true,
    storage: CONNECTOR_SECRET_STORAGE,
    materialization: { kind: 'connector-only', writesAuthJson: false },
    baseUrl: { kind: 'none' },
    model: { required: false },
    openclaw: {
      authProvider: 'gemini',
      configProfileId: null,
      storeProfileId: null,
      secretRefAllowed: false,
    },
    defaults: { model: null },
  },
] as const satisfies readonly ModelCredentialCatalogEntry[];

export const MODEL_CREDENTIAL_STATIC_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'openrouter',
  'grok',
  'minimax',
  'openai-compatible',
] as const satisfies readonly ModelCredentialActiveStaticProviderId[];

export const MODEL_CREDENTIAL_CONNECTOR_ONLY_PROVIDER_IDS = [
  'gemini',
] as const satisfies readonly ModelCredentialConnectorOnlyProviderId[];

export const MODEL_CREDENTIAL_OAUTH_PROVIDER_IDS = [
  'openai-codex',
  'claude-cli',
] as const satisfies readonly ModelCredentialOAuthProviderId[];

export const MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS = [
  'openai',
  'anthropic',
] as const satisfies readonly ModelCredentialSubscriptionProviderId[];

const SAFE_BYOSUB_UID = /^[A-Za-z0-9_-]+$/;

export interface UserByosubCredentialRef {
  provider: ModelCredentialSubscriptionProviderId;
  secretName: string;
}

export interface UserByosubCredentialRefs {
  refs: UserByosubCredentialRef[];
  skipped: string[];
}

export function byosubSecretNameForUser(
  uid: string,
  provider: ModelCredentialSubscriptionProviderId,
): string | null {
  return SAFE_BYOSUB_UID.test(uid) ? `byosub-${uid}-${provider}` : null;
}

// eslint-disable-next-line complexity
export function resolveUserByosubCredentialRefs(
  uid: string,
  integration: unknown,
): UserByosubCredentialRefs {
  const providers =
    integration && typeof integration === 'object' && !Array.isArray(integration)
      ? (integration as { providers?: unknown }).providers
      : undefined;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return { refs: [], skipped: [] };
  }

  const providerSet = providers as Record<string, unknown>;
  const refs: UserByosubCredentialRef[] = [];
  const skipped: string[] = [];
  for (const provider of MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS) {
    const raw = providerSet[provider];
    if (raw === undefined) continue;
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      (raw as { provider?: unknown }).provider !== provider
    ) {
      skipped.push(`${provider}: malformed provider leaf`);
      continue;
    }
    const leaf = raw as { connected?: unknown; status?: unknown };
    if (leaf.connected === false && (leaf.status === 'needs_reauth' || leaf.status === 'disconnected' || leaf.status === 'pending')) {
      continue;
    }
    if (leaf.connected !== true || leaf.status !== 'connected') {
      skipped.push(`${provider}: malformed provider leaf`);
      continue;
    }
    const secretName = byosubSecretNameForUser(uid, provider);
    if (!secretName) {
      skipped.push(`${provider}: unsafe user id`);
      continue;
    }
    refs.push({ provider, secretName });
  }
  return { refs, skipped };
}

export function modelCredentialEntryById(
  id: ModelCredentialProviderId,
): ModelCredentialCatalogEntry {
  const entry = MODEL_CREDENTIAL_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Unknown model credential provider: ${id}`);
  }
  return entry;
}

function isModelCredentialOAuthEntry(
  entry: ModelCredentialCatalogEntry,
): entry is ModelCredentialOAuthCatalogEntry {
  return entry.modes[0] === 'oauth';
}

export function modelCredentialOAuthEntryByProviderId(
  id: ModelCredentialOAuthProviderId,
): ModelCredentialOAuthCatalogEntry {
  const entry = (MODEL_CREDENTIAL_CATALOG as readonly ModelCredentialCatalogEntry[]).find(
    (candidate): candidate is ModelCredentialOAuthCatalogEntry =>
      isModelCredentialOAuthEntry(candidate) && candidate.id === id,
  );
  if (!entry) {
    throw new Error(`Unknown OAuth model credential provider: ${id}`);
  }
  return entry;
}

export function modelCredentialOAuthEntryBySubscriptionProvider(
  provider: string,
): ModelCredentialOAuthCatalogEntry | null {
  return (MODEL_CREDENTIAL_CATALOG as readonly ModelCredentialCatalogEntry[]).find(
    (entry): entry is ModelCredentialOAuthCatalogEntry =>
      isModelCredentialOAuthEntry(entry) && entry.oauth.subscriptionProvider === provider,
  ) ?? null;
}

export function modelCredentialApiKeyState(args: {
  provider: ModelCredentialActiveStaticProviderId;
  secretName: string;
  fingerprint: string;
  keyHash: string;
  baseUrl?: string;
  model?: string;
  addedAt?: unknown;
}): ModelCredentialApiKeyState {
  return {
    active: true,
    provider: args.provider,
    mode: 'api_key',
    status: 'active',
    reasonCode: 'ok',
    secretName: args.secretName,
    fingerprint: args.fingerprint,
    keyHash: args.keyHash,
    ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.addedAt !== undefined ? { addedAt: args.addedAt } : {}),
    lastUsedAt: null,
  };
}

export function modelCredentialOAuthState(args: {
  provider: ModelCredentialOAuthProviderId;
  secretName: string;
  addedAt?: unknown;
}): ModelCredentialOAuthState {
  return {
    active: true,
    provider: args.provider,
    mode: 'oauth',
    status: 'active',
    reasonCode: 'ok',
    secretName: args.secretName,
    ...(args.addedAt !== undefined ? { addedAt: args.addedAt } : {}),
    lastUsedAt: null,
  };
}
