export declare const PLATFORM_CONVERGED_CONTEXT_FILES: Set<string>;
export declare const USER_OWNED_CONTEXT_FILES: Set<string>;
export declare function listTierTemplateFiles(templateKey: string): string[];
export declare function readTierTemplateFile(templateKey: string, filename: string, vars: Record<string, string>): string;
export declare function writeTierTemplateFiles(customerDir: string, templateKey: string, templateVars: Record<string, string>): string[];
