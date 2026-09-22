#!/usr/bin/env bash

validate_ed25519_keypair() {
  printf '%s\0%s' "$1" "$2" | node -e '
    const { readFileSync } = require("node:fs");
    const { createPrivateKey, createPublicKey } = require("node:crypto");
    try {
      const [privatePem, publicPem] = readFileSync(0, "utf8").split("\0");
      if (!publicPem.includes("BEGIN PUBLIC KEY") || publicPem.includes("PRIVATE KEY")) process.exit(1);
      const privateKey = createPrivateKey(privatePem);
      const publicKey = createPublicKey(publicPem);
      const format = { type: "spki", format: "der" };
      const valid = privateKey.asymmetricKeyType === "ed25519" &&
        publicKey.asymmetricKeyType === "ed25519" &&
        createPublicKey(privateKey).export(format).equals(publicKey.export(format));
      process.exit(valid ? 0 : 1);
    } catch {
      process.exit(1);
    }
  '
}
