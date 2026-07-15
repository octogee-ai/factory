import { type TierResolvable } from "@octogee/shared/types/billing";
export declare function reassertConvergedContextFiles(slug: string, customerDir: string, userData: TierResolvable, vars?: Record<string, string>): string[];
export declare function reassertConvergedContextFilesForSlug(userData: TierResolvable & {
    username?: unknown;
}, customersDir?: string): string[];
