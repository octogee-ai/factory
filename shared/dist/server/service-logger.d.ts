export interface LogContext {
    builderSlug?: string;
    gatewayId?: string;
    category?: string;
    operationId?: string;
    phase?: string;
    status?: "pending" | "running" | "done" | "succeeded" | "failed" | "skipped";
    durationMs?: number;
    [key: string]: unknown;
}
export type ServiceLogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export interface ServiceLogger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    fatal(message: string, fields?: Record<string, unknown>): void;
    child(fields: LogContext): ServiceLogger;
}
export declare function withLogContext<T>(fields: LogContext, fn: () => T): T;
export declare function setLogContext(fields: LogContext): void;
export declare function createServiceLogger(service: string, options?: {
    debug?: boolean;
}): ServiceLogger;
