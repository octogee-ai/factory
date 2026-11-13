export type ChannelSessionModelOperation = {
    operation: "getSessionModel";
    agentId: string;
} | {
    operation: "listModels";
    agentId: string;
} | {
    operation: "listModelsByProvider";
    agentId: string;
    provider: string;
} | {
    operation: "setSessionModel";
    agentId: string;
    modelRef: string;
} | {
    operation: "resetSessionModel";
    agentId: string;
};
export declare function parseChannelSessionModelOperation(value: unknown): ChannelSessionModelOperation | null;
export declare function channelSessionModelCommand(operation: ChannelSessionModelOperation): string;
