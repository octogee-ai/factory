export type NativeMobileState = 'pending' | 'reserved' | 'awaiting-operator' | 'active' | 'revoked';
export interface NativeMobileDevice {
  id: string;
  gatewayId: string;
  state: NativeMobileState | 'expired';
  createdAt: number;
  lastConnectedAt?: number;
}
export interface NativeMobileSetup {
  id: string;
  gatewayId: string;
  setupCode: string;
  qrDataUrl: string;
  expiresAt: number;
}
export interface NativeMobileBinding {
  id: string;
  uid: string;
  gatewayId: string;
  workspaceSlug: string;
  allocation: string;
  state: NativeMobileState;
  setupExpiresAt: number;
  bootstrapHash?: string;
  deviceId?: string;
  publicKey?: string;
  nodeTokenIssuedAtMs?: number;
  httpTokens: Array<{ hash: string; scopes: string[]; issuedAtMs: number }>;
}
