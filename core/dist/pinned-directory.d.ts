export declare function withPinnedDirectory<T>(root: string, parts: readonly string[], use: (location: string, assertCurrent: () => Promise<void>) => Promise<T>, create?: boolean): Promise<T>;
