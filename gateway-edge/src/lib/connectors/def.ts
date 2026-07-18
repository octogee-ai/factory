import type { ConnectorId, ConnectorMeta } from "@octogee/shared/types/connectors";
import { CONNECTOR_CATALOG } from "@octogee/shared/types/connectors";

export interface ConnectorOAuthWebDef {
  authorizeUrl: string;
  tokenUrl: string;
  // RFC 7009 token revocation endpoint. Set for providers that support it
  // (Google) so disconnect / account-deletion can relinquish the grant at the
  // authority, not just locally. Omit for providers without one (Microsoft
  // identity has no RFC 7009 endpoint) — revocation is then a documented no-op.
  revocationUrl?: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  redirectUriEnv: string;
  pkce?: boolean;
  extraAuthParams?: Record<string, string>;
}

export interface ConnectorDeviceDef {
  codeUrl: string;
  tokenUrl: string;
  clientIdEnv: string;
}

export interface ConnectorIdentity {
  accountLabel: string;
}

export interface ConnectorProbeResult {
  probe: string;
  detail: string;
}

export interface ConnectorDef {
  meta: ConnectorMeta;
  oauth?: ConnectorOAuthWebDef;
  device?: ConnectorDeviceDef;
  capabilityRequestScopes?: (capability: string) => string[] | null;
  fetchIdentity: (accessToken: string) => Promise<ConnectorIdentity>;
  deepProbe?: (accessToken: string, grantedScopes?: string[]) => Promise<ConnectorProbeResult>;
  validateFields?: (fields: Record<string, string>) => Promise<ConnectorIdentity>;
}

export function catalogMeta(id: ConnectorId): ConnectorMeta {
  const meta = CONNECTOR_CATALOG.find((m) => m.id === id);
  if (!meta) {
    throw new Error(`Connector ${id} is missing from CONNECTOR_CATALOG`);
  }
  return meta;
}
