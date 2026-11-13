import { mattermostAccountIdForAgentId, parseAgentId } from "./identity.js";
export const PLATFORM_MATTERMOST_BASE_URL = "${MM_URL}";
const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;
const PLATFORM_OWNED_CONNECTION_KEYS = ["network", "interactions", "callbackBaseUrl"];
function objectValue(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function resolvesPlatformBaseUrl(existing, env) {
    const platformUrl = env.MM_URL;
    return typeof platformUrl === "string" && platformUrl !== "" && existing?.baseUrl === platformUrl;
}
export function mattermostAccountEndpointsForTarget(current, accounts, platformOwned, env = process.env) {
    const channels = objectValue(objectValue(current)?.channels);
    const mattermost = objectValue(channels?.mattermost);
    const currentAccounts = objectValue(mattermost?.accounts);
    return Object.fromEntries(Object.entries(accounts).map(([accountId, rawAccount]) => {
        const account = objectValue(rawAccount);
        if (!account)
            return [accountId, rawAccount];
        const existing = objectValue(currentAccounts?.[accountId]);
        let baseUrl = PLATFORM_MATTERMOST_BASE_URL;
        if (platformOwned) {
            if (resolvesPlatformBaseUrl(existing, env))
                baseUrl = existing.baseUrl;
        }
        else if (existing && Object.prototype.hasOwnProperty.call(existing, "baseUrl")) {
            baseUrl = existing.baseUrl;
        }
        else if (Object.prototype.hasOwnProperty.call(account, "baseUrl")) {
            baseUrl = account.baseUrl;
        }
        return [accountId, { ...account, baseUrl }];
    }));
}
export function managedMattermostAccounts(config) {
    const result = new Map();
    const agents = objectValue(config.agents);
    if (!agents)
        return result;
    const addAgent = (agentId) => {
        const parsed = parseAgentId(agentId);
        if (parsed.kind !== "coach" && parsed.kind !== "project")
            return;
        const accountId = mattermostAccountIdForAgentId(agentId);
        if (accountId)
            result.set(accountId, parsed.kind);
    };
    if (Array.isArray(agents.list)) {
        for (const entry of agents.list) {
            const agent = objectValue(entry);
            if (typeof agent?.id === "string")
                addAgent(agent.id);
        }
    }
    const entries = objectValue(agents.entries);
    if (entries) {
        for (const agentId of Object.keys(entries))
            addAgent(agentId);
    }
    return result;
}
export function mattermostAccountSecretRef(accountId) {
    return {
        source: "file",
        provider: "octogee-mattermost",
        id: `/${accountId.replace(/~/gu, "~0").replace(/\//gu, "~1")}`,
    };
}
function singleOwnerAllowFrom(value) {
    return Array.isArray(value) && value.length === 1
        && typeof value[0] === "string" && MATTERMOST_ID_RE.test(value[0]);
}
function allowFromPermitted(account, platformOwned) {
    if (!Object.prototype.hasOwnProperty.call(account, "allowFrom"))
        return true;
    return !platformOwned && singleOwnerAllowFrom(account.allowFrom);
}
function platformAgentAccountPolicySatisfied(account, platformOwned) {
    return account.dmPolicy === "disabled" && allowFromPermitted(account, platformOwned);
}
function enforcePlatformAgentAccountPolicy(account, platformOwned) {
    account.dmPolicy = "disabled";
    if (!allowFromPermitted(account, platformOwned))
        delete account.allowFrom;
}
function secretRefMatches(value, accountId) {
    const ref = objectValue(value);
    const expected = mattermostAccountSecretRef(accountId);
    return ref !== null
        && Object.keys(ref).length === Object.keys(expected).length
        && Object.entries(expected).every(([key, expectedValue]) => ref[key] === expectedValue);
}
export function platformAgentMattermostAccountsProjected(config, accounts, platformOwned) {
    const managed = managedMattermostAccounts(config);
    return Object.entries(accounts).every(([accountId, rawAccount]) => {
        const account = objectValue(rawAccount);
        if (!platformOwned)
            return !managed.has(accountId) || (account !== null && platformAgentAccountPolicySatisfied(account, false));
        return managed.has(accountId)
            && account !== null
            && secretRefMatches(account.botToken, accountId)
            && account.baseUrl === PLATFORM_MATTERMOST_BASE_URL
            && platformAgentAccountPolicySatisfied(account, true)
            && PLATFORM_OWNED_CONNECTION_KEYS.every((key) => !Object.prototype.hasOwnProperty.call(account, key));
    });
}
export function projectPlatformAgentMattermostAccounts(config, accounts, platformOwned) {
    const managed = managedMattermostAccounts(config);
    for (const [accountId, rawAccount] of Object.entries(accounts)) {
        const account = objectValue(rawAccount);
        if (!platformOwned) {
            if (managed.has(accountId) && account)
                enforcePlatformAgentAccountPolicy(account, false);
            continue;
        }
        if (!managed.has(accountId) || !account) {
            delete accounts[accountId];
            continue;
        }
        account.botToken = mattermostAccountSecretRef(accountId);
        account.baseUrl = PLATFORM_MATTERMOST_BASE_URL;
        enforcePlatformAgentAccountPolicy(account, true);
        for (const key of PLATFORM_OWNED_CONNECTION_KEYS)
            delete account[key];
    }
}
