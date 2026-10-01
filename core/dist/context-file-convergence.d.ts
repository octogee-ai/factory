import { type TierResolvable } from "@octogee/shared/types/billing";
export declare const UNKNOWN_TIME_ZONE = "unknown";
export declare function reassertUserTimeZoneLine(customerDir: string, timeZone: string | null): boolean;
export declare function reassertConvergedContextFiles(slug: string, customerDir: string, userData: TierResolvable & {
    timeZone?: unknown;
}, vars?: Record<string, string>): string[];
export declare function reassertConvergedContextFilesForSlug(userData: TierResolvable & {
    username?: unknown;
    timeZone?: unknown;
}, customersDir?: string): string[];
