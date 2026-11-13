export declare const IANA_TIME_ZONE_PATTERN = "^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$";
export declare const IANA_TIME_ZONE_MAX_LENGTH = 64;
export declare function parseTimeZone(value: unknown): string | null;
