// @ts-expect-error resolved by the OpenClaw runtime
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { setTimeout as sleep } from "node:timers/promises";
import { bootstrapWorkspaceIdentities, workspaceOwnerClaimed } from "@octogee/core/openclaw-workspace-bootstrap";

export default definePluginEntry({
  id: "octogee-identity-tools",
  name: "Octogee Workspace Identity Initialization",
  register(api: OpenClawPluginApi) {
    let controller: AbortController;
    let work: Promise<void>;
    api.registerService({
      id: "octogee-workspace-identities",
      start: () => {
        controller = new AbortController();
        work = (async () => {
          while (!controller.signal.aborted) {
            try {
              if (await bootstrapWorkspaceIdentities({ request: api.runtime.gateway.request }) === "complete") return;
              while (!controller.signal.aborted && !workspaceOwnerClaimed()) {
                await sleep(1000, undefined, { signal: controller.signal }).catch(() => {});
              }
              continue;
            } catch (error) {
              api.logger.error(`Workspace identity initialization failed: ${String(error)}`);
            }
            await sleep(5000, undefined, { signal: controller.signal }).catch(() => {});
          }
        })();
      },
      stop: async () => { controller.abort(); await work; },
    });
  },
});
