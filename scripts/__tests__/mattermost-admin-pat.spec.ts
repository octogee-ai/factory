import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const helper = path.join(repoRoot, "scripts/lib/mattermost-admin-pat.sh");
const username = "octogee-admin";
const userId = "admin-user-id";
const patId = "platform-pat-id";
const platformPat = "platform-pat-token";
const sessionToken = "admin-login-session";
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

function validate(input: {
  token: string;
  tokenId?: string;
  tokenFingerprint?: string;
  accessToken?: Record<string, unknown>;
}) {
  const admin = JSON.stringify({ id: userId, username, roles: "system_admin system_user" });
  const accessToken = JSON.stringify(input.accessToken ?? {
    id: patId,
    user_id: userId,
    description: "octogee platform admin PAT",
    is_active: true,
  });
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", [
    'source "$1"',
    "curl() {",
    '  case "$*" in',
    '    *"/users/me"*) printf "%s" "$MM_ME_RESPONSE" ;;',
    '    *"/users/tokens/"*) printf "%s" "$MM_PAT_RESPONSE" ;;',
    "    *) return 99 ;;",
    "  esac",
    "}",
    'mm_admin_pat_is_valid "$2" "$3" "$4" "$5" "$6" https://mattermost.test',
  ].join("\n"), "--", helper, input.token, username, userId, input.tokenId ?? patId, input.tokenFingerprint ?? fingerprint(platformPat)], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, MM_ME_RESPONSE: admin, MM_PAT_RESPONSE: accessToken },
  });
  return result;
}

describe("Mattermost platform admin PAT validation", () => {
  it("accepts the tracked active PAT", () => {
    expect(validate({ token: platformPat }).status).toBe(0);
  });

  it("rejects an authenticated admin login session with a PAT record", () => {
    expect(validate({ token: sessionToken }).status).not.toBe(0);
  });

  it("rejects missing PAT provenance before accepting the bearer", () => {
    expect(validate({ token: platformPat, tokenId: "" }).status).not.toBe(0);
  });
});
