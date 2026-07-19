export declare const W9_CANDIDATE_IMAGE_TAG_PATTERN: RegExp;
export declare function isW9CandidateImageTag(value: unknown): value is string;
export declare function isGatewayImageTag(value: string): boolean;
export declare function gatewayHeartbeatMatchesImageTag(heartbeatVersion: string | null | undefined, imageTag: string): boolean;
export declare const IMAGE_TAG_PATTERN: {
    test: typeof isGatewayImageTag;
};
