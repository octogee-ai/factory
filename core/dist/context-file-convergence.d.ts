export declare const UNKNOWN_TIME_ZONE = "unknown";
export declare function reassertUserTimeZoneLine(customerDir: string, timeZone: string | null): boolean;
export interface ConvergedContextFileInputs {
    planInputs: Record<string, unknown>;
    timeZone?: unknown;
}
export declare function reassertConvergedContextFiles(slug: string, customerDir: string, userData: ConvergedContextFileInputs, vars?: Record<string, string>): string[];
export declare function reassertConvergedContextFilesForSlug(userData: ConvergedContextFileInputs & {
    username?: unknown;
}, usersDir?: string): string[];
