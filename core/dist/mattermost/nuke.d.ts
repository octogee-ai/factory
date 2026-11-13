export declare function destroyMmUser(userId: string): Promise<void>;
export declare function destroyMmChannel(channelId: string): Promise<void>;
export declare function getMmUserChannels(userId: string, teamId: string): Promise<string[]>;
