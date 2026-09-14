export const METADATA_BASE = "http://169.254.169.254/computeMetadata/v1";
export const ACCESS_TOKEN_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

export interface InstanceIdentity {
  instanceId: string;
  instanceName: string;
  zone: string;
}

export interface MetadataClient {
  identityToken(audience: string): Promise<string>;
  accessToken(): Promise<string>;
  instanceIdentity(): Promise<InstanceIdentity>;
  attribute(key: string): Promise<string | null>;
}

export function createMetadataClient(fetchImpl: typeof fetch = fetch): MetadataClient {
  async function get(path: string): Promise<Response> {
    return fetchImpl(`${METADATA_BASE}/${path}`, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) });
  }
  async function text(path: string): Promise<string> {
    const res = await get(path);
    if (!res.ok) throw new Error(`metadata ${path}: HTTP ${res.status}`);
    return (await res.text()).trim();
  }
  return {
    identityToken: (audience) =>
      text(`instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`),
    async accessToken() {
      const res = await get(`instance/service-accounts/default/token?scopes=${encodeURIComponent(ACCESS_TOKEN_SCOPES.join(","))}`);
      if (!res.ok) throw new Error(`metadata access token: HTTP ${res.status} ${(await res.text()).trim()}`);
      const body = (await res.json()) as { access_token?: string };
      if (!body.access_token) throw new Error("metadata access token: empty response");
      return body.access_token;
    },
    async instanceIdentity() {
      const [instanceId, instanceName, zonePath] = await Promise.all([text("instance/id"), text("instance/name"), text("instance/zone")]);
      return { instanceId, instanceName, zone: zonePath.split("/").at(-1) ?? zonePath };
    },
    async attribute(key) {
      const res = await get(`instance/attributes/${encodeURIComponent(key)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`metadata attribute ${key}: HTTP ${res.status}`);
      return (await res.text()).trim();
    },
  };
}
