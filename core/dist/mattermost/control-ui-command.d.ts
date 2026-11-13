import type { ChannelCommandSpec, ManagedChannelHost } from "../channel-host/types.js";
export declare const CONTROL_UI_COMMAND_TRIGGER = "ui";
export declare const CONTROL_UI_COMMAND_PATH = "/internal/mattermost/commands/control-ui";
export declare function controlUiCommandUrl(namespace: string | undefined): string;
export declare function controlUiCommandSpec(teamId: string, url: string): ChannelCommandSpec;
export interface ControlUiCommandConvergence {
    created: number;
    updated: number;
    present: number;
    skipped: number;
    failed: number;
}
export declare function convergeControlUiCommands(input: {
    host: Pick<ManagedChannelHost, "listTeamIds" | "ensureCommand">;
    url: string;
    isWorkspaceTeam(teamId: string): Promise<boolean>;
    log(message: string, meta?: Record<string, unknown>): void;
}): Promise<ControlUiCommandConvergence>;
