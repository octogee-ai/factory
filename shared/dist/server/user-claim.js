import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { USER_CLAIM_FILE, userClaimFromIdentity, parseUserClaimRecord, sameUserOwner, } from "../types/user-identity.js";
export { userClaimFromIdentity };
export const DEFAULT_OPENCLAW_DIR = "/home/node/.openclaw";
export class UserClaimError extends Error {
    constructor(message) {
        super(message);
        this.name = "UserClaimError";
    }
}
export function userClaimPath(openclawDir) {
    return path.join(openclawDir, USER_CLAIM_FILE);
}
function readClaimFile(file) {
    try {
        return readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
function parseClaimFile(file, raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new UserClaimError(`User claim ${file} is malformed`);
    }
    const record = parseUserClaimRecord(value);
    if (!record)
        throw new UserClaimError(`User claim ${file} is malformed`);
    return record;
}
export function readUserClaim(openclawDir, gatewayId) {
    const file = userClaimPath(openclawDir);
    const raw = readClaimFile(file);
    if (raw === null)
        return null;
    if (!gatewayId)
        throw new UserClaimError("GATEWAY_ID is required to read the user claim");
    const record = parseClaimFile(file, raw);
    if (record.gatewayId !== gatewayId) {
        throw new UserClaimError(`User claim ${file} belongs to gateway ${record.gatewayId}, not ${gatewayId}`);
    }
    return record;
}
function atomicWrite(file, contents) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
        writeSync(fd, contents);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    try {
        renameSync(temporary, file);
    }
    catch (error) {
        unlinkSync(temporary);
        throw error;
    }
}
export function writeUserClaim(openclawDir, record) {
    const file = userClaimPath(openclawDir);
    const raw = readClaimFile(file);
    if (raw !== null) {
        const existing = parseClaimFile(file, raw);
        if (!sameUserOwner(existing, record)) {
            throw new UserClaimError(`User claim ${file} already binds ${existing.gatewayId} to ${existing.builderSlug}; ` +
                `refusing to rebind it to ${record.gatewayId}/${record.builderSlug}`);
        }
        return existing;
    }
    const validated = parseUserClaimRecord(record);
    if (!validated)
        throw new UserClaimError(`refusing to write a malformed user claim to ${file}`);
    atomicWrite(file, `${JSON.stringify(validated)}\n`);
    return validated;
}
function rewriteClaim(openclawDir, gatewayId, purpose, update) {
    const existing = readUserClaim(openclawDir, gatewayId);
    if (!existing)
        throw new UserClaimError(`gateway ${gatewayId} has no user claim to ${purpose}`);
    const patch = update(existing);
    if (!patch)
        return existing;
    const next = parseUserClaimRecord({ ...existing, ...patch });
    if (!next)
        throw new UserClaimError(`refusing to write a malformed user claim for ${gatewayId}`);
    atomicWrite(userClaimPath(openclawDir), `${JSON.stringify(next)}\n`);
    return next;
}
export function markUserClaimOverlayApplied(openclawDir, gatewayId, appliedAt) {
    return rewriteClaim(openclawDir, gatewayId, "mark its overlay applied", (existing) => {
        if (existing.overlayAppliedAt !== null)
            return null;
        return { overlayAppliedAt: appliedAt };
    });
}
function openclawDirOf(env) {
    return env.OPENCLAW_DIR?.trim() || DEFAULT_OPENCLAW_DIR;
}
export function readUserClaimFromEnv(env = process.env) {
    return readUserClaim(openclawDirOf(env), env.GATEWAY_ID?.trim());
}
export function userClaimSlug(env = process.env) {
    return readUserClaimFromEnv(env)?.builderSlug ?? null;
}
export function userClaimOverlaySlug(env = process.env) {
    const claim = readUserClaimFromEnv(env);
    return claim?.overlayAppliedAt != null ? claim.builderSlug : null;
}
export function userClaimOwnerUid(env = process.env) {
    return readUserClaimFromEnv(env)?.ownerUid ?? null;
}
