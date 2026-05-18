/**
 * Provisioner device-identity = the canonical shared crypto core +
 * on-disk persistence. The crypto/payload/signature logic lives in
 * shared/types/device-identity.ts (single source, shared with chat-proxy
 * which has no persistence layer). This module adds only what the
 * gateway provisioner needs on top: a stable identity file under
 * ~/.octogee/provisioner so the device survives pod restarts. It
 * re-exports the core so existing scripts importers keep a single
 * import.
 *
 * Spec: docs/specs/CHAT-PROXY-SHARED-IMPORTS-SPEC.md (Stage 2).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateIdentity, type DeviceIdentity } from "../../shared/types/device-identity.js";

export * from "../../shared/types/device-identity.js";

interface StoredIdentity {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

function resolveDefaultIdentityPath(): string {
  const override = process.env.OCTOGEE_PROVISIONER_IDENTITY_PATH;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".octogee", "provisioner", "device.json");
}

export function loadOrCreateDeviceIdentity(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch { /* */ }

  const identity = generateIdentity();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch { /* */ }
  return identity;
}
