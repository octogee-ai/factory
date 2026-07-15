import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  mattermostAccountSecretRef,
  mattermostAccountSecretsPath,
  mattermostProjectAccountSecretChange,
  readMattermostAccountSecret,
  updateMattermostAccountSecrets,
} from "../lib/mattermost-account-secrets.js";

const dirs: string[] = [];

function tempOpenClawDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-mm-account-secrets-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Mattermost account SecretRefs", () => {
  it("removes disabled and unminted project PATs while setting active accounts", () => {
    expect(mattermostProjectAccountSecretChange("alice", [
      { projectId: "orbit", enabled: true, token: "pat-orbit" },
      { projectId: "nova", enabled: false, token: "pat-nova" },
      { projectId: "empty", enabled: true, token: null },
    ])).toEqual({
      set: { "alice-proj-orbit": "pat-orbit" },
      remove: ["alice-proj-nova", "alice-proj-empty"],
    });
  });

  it("uses JSON Pointer ids with the platform file provider", () => {
    expect(mattermostAccountSecretRef("ceckert/coach~blue")).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/ceckert~1coach~0blue",
    });
  });

  it("atomically persists tokens outside system_config with mode 0600", async () => {
    const openclawDir = tempOpenClawDir();

    await updateMattermostAccountSecrets(openclawDir, {
      set: { "ceckert-coach": "coach-pat" },
    });

    const secretPath = mattermostAccountSecretsPath(openclawDir);
    expect(secretPath).not.toContain("system_config");
    expect(JSON.parse(fs.readFileSync(secretPath, "utf8"))).toEqual({
      "ceckert-coach": "coach-pat",
    });
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(secretPath))).toEqual(["mattermost-accounts.json"]);
  });

  it("serializes overlapping updates without losing either account", async () => {
    const openclawDir = tempOpenClawDir();

    await Promise.all([
      updateMattermostAccountSecrets(openclawDir, { set: { "alice-coach": "pat-a" } }),
      updateMattermostAccountSecrets(openclawDir, { set: { "bob-coach": "pat-b" } }),
    ]);

    expect(JSON.parse(fs.readFileSync(mattermostAccountSecretsPath(openclawDir), "utf8"))).toEqual({
      "alice-coach": "pat-a",
      "bob-coach": "pat-b",
    });
  });

  it("removes retired accounts while preserving siblings", async () => {
    const openclawDir = tempOpenClawDir();
    await updateMattermostAccountSecrets(openclawDir, {
      set: { "alice-coach": "pat-a", "bob-coach": "pat-b" },
    });

    await updateMattermostAccountSecrets(openclawDir, {
      remove: ["alice-coach"],
      removePrefixes: ["alice-proj-"],
    });

    await expect(readMattermostAccountSecret(openclawDir, "alice-coach")).resolves.toBeNull();
    await expect(readMattermostAccountSecret(openclawDir, "bob-coach")).resolves.toBe("pat-b");
  });
});
