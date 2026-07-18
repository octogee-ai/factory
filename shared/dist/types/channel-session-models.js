const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
const AGENT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,255})$/;
function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}
export function parseChannelSessionModelOperation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const body = value;
    if (typeof body.agentId !== "string" || !AGENT_ID.test(body.agentId))
        return null;
    switch (body.operation) {
        case "getSessionModel":
        case "listModels":
        case "resetSessionModel":
            return exactKeys(body, ["operation", "agentId"]) ? body : null;
        case "listModelsByProvider":
            return exactKeys(body, ["operation", "agentId", "provider"]) && typeof body.provider === "string" && IDENTIFIER.test(body.provider)
                ? body : null;
        case "setSessionModel": {
            if (!exactKeys(body, ["operation", "agentId", "modelRef"]) || typeof body.modelRef !== "string")
                return null;
            const parts = body.modelRef.split("/");
            return parts.length === 2 && parts.every((part) => IDENTIFIER.test(part)) ? body : null;
        }
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
