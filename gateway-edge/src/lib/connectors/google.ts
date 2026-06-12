import type { ConnectorDef } from "./def.js";
import { catalogMeta } from "./def.js";

export const googleConnector: ConnectorDef = {
  meta: catalogMeta("google"),
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    redirectUriEnv: "GOOGLE_OAUTH_REDIRECT_URI",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  fetchIdentity: async (accessToken) => {
    const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      throw new Error(`Google identity check failed: ${resp.status}`);
    }
    const user = (await resp.json()) as { email?: string };
    if (!user.email) {
      throw new Error("Google identity response has no email");
    }
    return { accountLabel: user.email };
  },
  deepProbe: async (accessToken) => {
    const resp = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      throw new Error(`Google Drive probe failed: ${resp.status}`);
    }
    const about = (await resp.json()) as { user?: { emailAddress?: string } };
    return { probe: "drive.about", detail: about.user?.emailAddress ?? "unknown" };
  },
};
