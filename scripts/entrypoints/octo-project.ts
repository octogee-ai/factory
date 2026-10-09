import { statfs } from "node:fs/promises";
import path from "node:path";
import { isValidProjectId, isValidUsername } from "../../shared/types/identity.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { createBrokeredProjectBlobHydrator } from "../lib/project-blob-materialization.js";

try {
  const [command, project, ...paths] = process.argv.slice(2);
  const slug = process.env.GATEWAY_BUILDER_SLUG ?? "";
  const gatewayId = process.env.GATEWAY_ID ?? "";
  if (command !== "restore" || !isValidProjectId(project ?? "") || paths.length === 0 || !isValidUsername(slug) || !gatewayId) throw new Error("usage: octo-project restore <project> <asset-path> [asset-path ...]");
  const destination = path.join(process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers", slug, project ? `projects/${project}` : "");
  const space = await statfs(destination);
  const hydrate = createBrokeredProjectBlobHydrator(createFleetBrokerClient(gatewayId));
  const result = await hydrate({ slug, project, destination, paths, maxBytes: Math.max(0, space.bavail * space.bsize - 128 * 1024 * 1024), preserveExisting: true });
  console.log(`Restored ${result.files} assets (${result.bytes} bytes). Existing local files retained.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
