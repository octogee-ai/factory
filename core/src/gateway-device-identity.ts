

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateIdentity, type DeviceIdentity } from "@octogee/shared/types/device-identity";

export * from "@octogee/shared/types/device-identity";

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
