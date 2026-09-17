export declare const PLATFORM_CONVERGED_CONTEXT_FILES: Set<string>;
export type TemplateTier = "free" | "trial" | "paid";
export declare function templateTierForName(tier: string): TemplateTier;
export declare function listTierTemplateFiles(tier: string): string[];
export declare function readTierTemplateFile(tier: string, filename: string, vars: Record<string, string>): string;
export declare function writeTierTemplateFiles(customerDir: string, tier: string, templateVars: Record<string, string>): string[];
