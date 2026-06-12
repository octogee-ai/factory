import type { ConnectorId, ConnectorMeta } from "@shared/types/connectors.js";
import { CONNECTOR_CATALOG } from "@shared/types/connectors.js";

export interface ConnectorOAuthWebDef {
  authorizeUrl: string;
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  redirectUriEnv: string;
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
  fetchIdentity: (accessToken: string) => Promise<ConnectorIdentity>;
  deepProbe?: (accessToken: string) => Promise<ConnectorProbeResult>;
  validateFields?: (fields: Record<string, string>) => Promise<ConnectorIdentity>;
}

export function catalogMeta(id: ConnectorId): ConnectorMeta {
  const meta = CONNECTOR_CATALOG.find((m) => m.id === id);
  if (!meta) {
    throw new Error(`Connector ${id} is missing from CONNECTOR_CATALOG`);
  }
  return meta;
}
