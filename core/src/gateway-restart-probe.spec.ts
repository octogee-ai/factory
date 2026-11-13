import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createRestartDriverDeps } from "./gateway-restart-probe.js";

afterEach(() => vi.unstubAllEnvs());

it("refuses a linked restart configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-restart-config-"));
  try {
    await writeFile(join(root, "config.json"), JSON.stringify({ gateway: { port: 0 } }));
    const config = join(root, "linked.json");
    await symlink(join(root, "config.json"), config);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", config);
    await expect(createRestartDriverDeps(fileURLToPath(new URL("../package.json", import.meta.url))))
      .rejects.toMatchObject({ code: "ELOOP" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
