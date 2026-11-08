import { type UserEntitlementInputs } from "@octogee/shared/types/user-entitlements";
export declare const UNKNOWN_TIME_ZONE = "unknown";
export declare function reassertUserTimeZoneLine(customerDir: string, timeZone: string | null): boolean;
export declare function reassertConvergedContextFiles(slug: string, customerDir: string, userData: UserEntitlementInputs & {
    timeZone?: unknown;
}, vars?: Record<string, string>): string[];
export declare function reassertConvergedContextFilesForSlug(userData: UserEntitlementInputs & {
    username?: unknown;
    timeZone?: unknown;
}, customersDir?: string): string[];
