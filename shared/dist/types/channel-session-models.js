import { isValidModelRef } from "./agent-models.js";
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
const AGENT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,255})$/;
function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}
function isOperationBody(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasValidAgentId(body) {
    return typeof body.agentId === "string" && AGENT_ID.test(body.agentId);
}
function parseSimpleOperation(body) {
    return exactKeys(body, ["operation", "agentId"]) ? body : null;
}
function parseProviderOperation(body) {
    const valid = exactKeys(body, ["operation", "agentId", "provider"])
        && typeof body.provider === "string"
        && IDENTIFIER.test(body.provider);
    return valid ? body : null;
}
function parseSetOperation(body) {
    const valid = exactKeys(body, ["operation", "agentId", "modelRef"])
        && typeof body.modelRef === "string"
        && isValidModelRef(body.modelRef);
    return valid ? body : null;
}
export function parseChannelSessionModelOperation(value) {
    if (!isOperationBody(value) || !hasValidAgentId(value))
        return null;
    const body = value;
    switch (body.operation) {
        case "getSessionModel":
        case "listModels":
        case "resetSessionModel":
            return parseSimpleOperation(body);
        case "listModelsByProvider":
            return parseProviderOperation(body);
        case "setSessionModel":
            return parseSetOperation(body);
        default:
            return null;
    }
}
export function channelSessionModelCommand(operation) {
    switch (operation.operation) {
        case "getSessionModel": return "/status";
        case "listModels": return "/models";
        case "listModelsByProvider": return `/models ${operation.provider}`;
        case "setSessionModel": return `/model ${operation.modelRef}`;
        case "resetSessionModel": return "/model default";
    }
}
