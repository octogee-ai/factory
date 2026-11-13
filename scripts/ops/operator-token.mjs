#!/usr/bin/env node
// Print a short-lived operator token for the fleet Admin API: operator-token.mjs <private-key.pem> [operator]
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { signOperatorToken } from "../../core/dist/operator-token.js";

const [keyFile, subject = userInfo().username] = process.argv.slice(2);
if (!keyFile) {
  console.error("Usage: operator-token.mjs <private-key.pem> [operator]");
  process.exit(2);
}
process.stdout.write(`${signOperatorToken({ privateKey: readFileSync(keyFile, "utf8"), subject })}\n`);
