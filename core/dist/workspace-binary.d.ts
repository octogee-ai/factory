export declare const WORKSPACE_BINARY_SNIFF_BYTES = 8000;
export declare const MAX_WORKSPACE_BINARY_BYTES: number;
export declare function looksLikeWorkspaceBinary(sample: Uint8Array): boolean;
export declare function isDivertableWorkspacePath(relativePath: string): boolean;
