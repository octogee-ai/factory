import { AsyncLocalStorage } from "node:async_hooks";
import { stripVTControlCharacters } from "node:util";
import pino from "pino";
import { redactSecrets, redactStructuredSecrets } from "../types/secret-redaction.js";
const context = new AsyncLocalStorage();
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, warning: 30, error: 40, fatal: 50, critical: 50 };
const RESERVED = new Set(["severity", "level", "timestamp", "time", "message", "msg", "service", "pid", "hostname"]);
export function withLogContext(fields, fn) {
    return context.run({ ...context.getStore(), ...fields }, fn);
}
export function setLogContext(fields) {
    const active = context.getStore();
    if (!active)
        throw new Error("Log context must be established before adding fields");
    Object.assign(active, fields);
}
function serializeFields(value, seen = new WeakSet()) {
    if (value === null || typeof value !== "object")
        return value;
    if (seen.has(value))
        return "[Circular]";
    seen.add(value);
    const fields = value instanceof Error
        ? { ...value, name: value.name, message: value.message, stack: value.stack, ...(value.cause === undefined ? {} : { cause: value.cause }) }
        : value;
    const result = Array.isArray(fields)
        ? fields.map(field => serializeFields(field, seen))
        : Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, serializeFields(field, seen)]));
    seen.delete(value);
    return result;
}
export function createServiceLogger(service, options = {}) {
    const sink = (method) => ({ write: (line) => { console[method](line.trimEnd()); } });
    const output = pino({
        level: "debug", base: { service }, messageKey: "message",
        timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
        formatters: { level: level => ({ severity: { warn: "WARNING", fatal: "CRITICAL" }[level] ?? level.toUpperCase() }) },
    }, pino.multistream([
        { level: "debug", stream: sink("log") },
        { level: "warn", stream: sink("warn") },
        { level: "error", stream: sink("error") },
    ], { dedupe: true }));
    const make = (bindings) => {
        const emit = (level, message, fields = {}) => {
            const configured = (process.env.LOG_LEVEL ?? (options.debug ? "debug" : "info")).toLowerCase();
            if (LEVEL_RANK[configured] === undefined)
                throw new Error(`Invalid LOG_LEVEL '${configured}'`);
            if (LEVEL_RANK[level] < LEVEL_RANK[configured])
                return;
            const merged = { ...(process.env.GATEWAY_ID ? { gatewayId: process.env.GATEWAY_ID } : {}), ...bindings, ...context.getStore(), ...fields };
            const safe = Object.fromEntries(Object.entries(merged).filter(([key]) => !RESERVED.has(key)));
            const redaction = { keepLongTokens: process.env.LOG_KEEP_LONG_IDENTIFIERS === "true" };
            const redacted = redactStructuredSecrets(serializeFields(safe), redaction);
            for (const key of ["builderSlug", "gatewayId", "operationId", "sourceGateway", "targetGateway", "requestId"]) {
                const value = safe[key];
                if (typeof value === "string" && /^[a-zA-Z0-9_.:-]+$/.test(value))
                    redacted[key] = value;
            }
            const migrationId = safe.migrationId;
            if (typeof migrationId === "string" && /^mig-[a-zA-Z0-9_.:-]+$/.test(migrationId))
                redacted.migrationId = migrationId;
            output[level](redacted, redactSecrets(stripVTControlCharacters(message), redaction));
        };
        return {
            debug: (message, fields) => emit("debug", message, fields),
            info: (message, fields) => emit("info", message, fields),
            warn: (message, fields) => emit("warn", message, fields),
            error: (message, fields) => emit("error", message, fields),
            fatal: (message, fields) => emit("fatal", message, fields),
            child: fields => make({ ...bindings, ...fields }),
        };
    };
    return make({});
}
