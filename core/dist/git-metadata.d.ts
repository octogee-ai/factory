export declare function findUnsafeGitMetadataEntry(gitDir: string, metadataRoot?: string): string | null;
export declare function findUnsafeUserGitMetadataEntry(userMetadataDir: string): string | null;
export declare function readGitMetadataText(file: string, limit: number, { requireReadOnly }?: {
    requireReadOnly?: boolean | undefined;
}): string | null;
