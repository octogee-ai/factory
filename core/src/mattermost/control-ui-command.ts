import type { ChannelCommandSpec, ManagedChannelHost } from "../channel-host/types.js";

export const CONTROL_UI_COMMAND_TRIGGER = "ui";
export const CONTROL_UI_COMMAND_PATH = "/internal/mattermost/commands/control-ui";

const CALLBACK_ROUTER_PORT = 3001;
const KUBERNETES_NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function controlUiCommandUrl(namespace: string | undefined): string {
  if (!namespace || !KUBERNETES_NAMESPACE.test(namespace)) {
    throw new Error("K8S_NAMESPACE must name the platform namespace to register the /ui command");
  }
  return `http://mattermost-callback-router.${namespace}.svc.cluster.local:${CALLBACK_ROUTER_PORT}${CONTROL_UI_COMMAND_PATH}`;
}

export function controlUiCommandSpec(teamId: string, url: string): ChannelCommandSpec {
  return {
    teamId,
    trigger: CONTROL_UI_COMMAND_TRIGGER,
    url,
    displayName: "Control UI",
    description: "Open the OpenClaw Control UI of your isolated gateway",
    autocompleteDescription: "Get a one-time link to your OpenClaw Control UI (isolated gateways only)",
  };
}

export interface ControlUiCommandConvergence {
  created: number;
  updated: number;
  present: number;
  skipped: number;
  failed: number;
}

export async function convergeControlUiCommands(input: {
  host: Pick<ManagedChannelHost, "listTeamIds" | "ensureCommand">;
  url: string;
  isWorkspaceTeam(teamId: string): Promise<boolean>;
  log(message: string, meta?: Record<string, unknown>): void;
}): Promise<ControlUiCommandConvergence> {
  const summary: ControlUiCommandConvergence = { created: 0, updated: 0, present: 0, skipped: 0, failed: 0 };
  for (const teamId of await input.host.listTeamIds()) {
    try {
      if (!await input.isWorkspaceTeam(teamId)) {
        summary.skipped += 1;
        continue;
      }
      summary[await input.host.ensureCommand(controlUiCommandSpec(teamId, input.url))] += 1;
    } catch (error) {
      summary.failed += 1;
      input.log("[mattermost] /ui command convergence failed for a team", {
        teamId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
