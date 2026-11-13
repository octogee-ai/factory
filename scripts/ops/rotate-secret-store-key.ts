import { rotateRuntimeSecretStoreKey } from "@octogee/core/secret-store";

async function main(): Promise<void> {
  const [confirmation, extra] = process.argv.slice(2);
  if (confirmation !== "--apply" || extra !== undefined) {
    throw new Error("Usage: npm run rotate-secret-store-key -- --apply");
  }
  if ((process.env.SECRET_STORE_BACKEND ?? "postgres") !== "postgres") {
    throw new Error("key rotation requires the PostgreSQL secret store");
  }
  const targetId = process.env.DEPLOYMENT_TARGET_ID;
  if (!targetId) throw new Error("DEPLOYMENT_TARGET_ID is required");
  if (!process.env.SECRET_STORE_ROOT_KEY) throw new Error("SECRET_STORE_ROOT_KEY is required");
  if (!process.env.SECRET_STORE_PREVIOUS_ROOT_KEY) {
    throw new Error("SECRET_STORE_PREVIOUS_ROOT_KEY is required");
  }
  const { rotated } = await rotateRuntimeSecretStoreKey(targetId);
  process.stdout.write(JSON.stringify({ targetId, rotated }) + "\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
