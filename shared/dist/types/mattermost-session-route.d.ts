export type MattermostSessionPeerKind = 'channel' | 'group' | 'direct';
export interface MattermostSessionRoute {
    agentId: string;
    peerKind: MattermostSessionPeerKind;
    primaryChannelId: string;
    threadRootPostId?: string;
}
export interface ThreadedMattermostSessionRoute extends MattermostSessionRoute {
    peerKind: 'group' | 'direct';
    threadRootPostId: string;
}
export interface ChannelScopedMattermostSessionRoute extends MattermostSessionRoute {
    peerKind: 'channel' | 'group';
    threadRootPostId?: never;
}
export declare function parseMattermostSessionRoute(sessionKey: unknown): MattermostSessionRoute | null;
export declare function parseThreadedMattermostSessionRoute(sessionKey: unknown): ThreadedMattermostSessionRoute | null;
export declare function parseChannelScopedMattermostSessionRoute(sessionKey: unknown): ChannelScopedMattermostSessionRoute | null;
