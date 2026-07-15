export declare function slugify(name: string): string;
export declare function generatePersonalSlug(): string;
export declare function copyDirSync(src: string, dest: string): void;
export declare function applyTemplatePlaceholders(template: string, vars: Record<string, string>): string;
export declare const BUSINESS_TYPE_TEMPLATES: Record<string, string>;
export declare function getTemplateForBusinessType(businessType: string): string;
export declare const MIME_TYPES: Record<string, string>;
