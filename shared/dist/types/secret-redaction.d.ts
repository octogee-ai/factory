export interface RedactionOptions {
    keepLongTokens?: boolean;
}
export declare function redactSecrets(value: string, options?: RedactionOptions): string;
export declare function redactStructuredSecrets(value: unknown, options?: RedactionOptions): unknown;
