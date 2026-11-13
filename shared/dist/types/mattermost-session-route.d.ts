export type MattermostSessionPeerKind = 'channel' | 'group' | 'direct';
export interface MattermostThreadSelection {
    channelId: string;
    threadRootPostId: string;
}
export declare function isMattermostPostId(value: unknown): value is string;
export declare function isMattermostThreadSelection(value: unknown): value is MattermostThreadSelection;
export interface MattermostSessionRoute {
    agentId: string;
    peerKind: MattermostSessionPeerKind;
    primaryChannelId: string;
    threadRootPostId?: string;
}
export interface ThreadedMattermostSessionRoute extends MattermostSessionRoute {
    peerKind: MattermostSessionPeerKind;
    threadRootPostId: string;
}
export interface ChannelScopedMattermostSessionRoute extends MattermostSessionRoute {
    peerKind: 'channel' | 'group';
    threadRootPostId?: never;
}
export interface ThreadedChannelMattermostSessionRoute extends ThreadedMattermostSessionRoute {
    peerKind: 'channel' | 'group';
}
export declare function parseMattermostSessionRoute(sessionKey: unknown): MattermostSessionRoute | null;
export declare function parseThreadedMattermostSessionRoute(sessionKey: unknown): ThreadedMattermostSessionRoute | null;
export declare function parseThreadedChannelMattermostSessionRoute(sessionKey: unknown): ThreadedChannelMattermostSessionRoute | null;
export declare function parseChannelScopedMattermostSessionRoute(sessionKey: unknown): ChannelScopedMattermostSessionRoute | null;
