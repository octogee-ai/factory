export declare function isGatewayImageTag(value: string): boolean;
export declare function gatewayHeartbeatMatchesImageTag(heartbeatVersion: string | null | undefined, imageTag: string): boolean;
export declare const IMAGE_TAG_PATTERN: {
    test: typeof isGatewayImageTag;
};
