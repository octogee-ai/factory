export const AGENT_IMPORT_FORMAT_VERSION = 1;
export const AGENT_IMPORT_AUTHORIZATION_INTENTS = [
    "source_listing",
    "preview",
    "apply",
    "status",
    "abandon",
    "rollback",
];
export function isAgentImportAuthorizationIntent(value) {
    return typeof value === "string" &&
        AGENT_IMPORT_AUTHORIZATION_INTENTS.includes(value);
}
export class AgentImportConfigError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "AgentImportConfigError";
    }
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}
function trimmedString(value, max) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : undefined;
}
function boundedInteger(value, min, max) {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
        ? value
        : undefined;
}
function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
function activeHours(value) {
    const source = record(value);
    if (!source || Object.keys(source).some((key) => !["start", "end", "timezone"].includes(key))) {
        return undefined;
    }
    const result = compact({
        start: trimmedString(source.start, 20),
        end: trimmedString(source.end, 20),
        timezone: trimmedString(source.timezone, 100),
    });
    return Object.keys(result).length > 0 ? result : undefined;
}
function safeHeartbeat(defaults, agent) {
    const defaultHeartbeat = record(defaults.heartbeat) ?? {};
    const agentHeartbeat = record(agent.heartbeat) ?? {};
    const merged = { ...defaultHeartbeat, ...agentHeartbeat };
    const result = compact({
        every: trimmedString(merged.every, 40),
        activeHours: activeHours(merged.activeHours),
        lightContext: typeof merged.lightContext === "boolean" ? merged.lightContext : undefined,
    });
    return Object.keys(result).length > 0 ? result : undefined;
}
function safeModel(value) {
    if (typeof value === "string") {
        const primary = trimmedString(value, 240);
        return primary ? { primary } : undefined;
    }
    const source = record(value);
    if (!source)
        return undefined;
    const primary = trimmedString(source.primary, 240);
    const fallbacks = Array.isArray(source.fallbacks)
        ? source.fallbacks.flatMap((entry) => {
            const fallback = trimmedString(entry, 240);
            return fallback ? [fallback] : [];
        }).slice(0, 20)
        : undefined;
    const result = compact({ primary, fallbacks: fallbacks?.length ? fallbacks : undefined });
    return Object.keys(result).length > 0 ? result : undefined;
}
function portableAgent(config, agent) {
    const agents = record(config.agents) ?? {};
    const defaults = record(agents.defaults) ?? {};
    const identity = record(agent.identity) ?? {};
    const sourceOpenClawVersion = trimmedString(record(config.meta)?.lastTouchedVersion, 100);
    const id = trimmedString(agent.id, 160);
    const result = compact({
        sourceAgentId: id,
        sourceOpenClawVersion,
        name: trimmedString(agent.name, 80),
        persona: trimmedString(agent.persona, 4_000),
        identity: (() => {
            const safe = compact({
                name: trimmedString(identity.name, 80),
                emoji: trimmedString(identity.emoji, 32),
            });
            return Object.keys(safe).length > 0 ? safe : undefined;
        })(),
        heartbeat: safeHeartbeat(defaults, agent),
        bootstrapMaxChars: boundedInteger(own(agent, "bootstrapMaxChars") ?? defaults.bootstrapMaxChars, 1, 200_000),
        bootstrapTotalMaxChars: boundedInteger(own(agent, "bootstrapTotalMaxChars") ?? defaults.bootstrapTotalMaxChars, 1, 500_000),
        thinkingDefault: trimmedString(own(agent, "thinkingDefault") ?? defaults.thinkingDefault, 40),
        verboseDefault: trimmedString(own(agent, "verboseDefault") ?? defaults.verboseDefault, 40),
        timeoutSeconds: boundedInteger(own(agent, "timeoutSeconds") ?? defaults.timeoutSeconds, 1, 3_600),
        requestedModel: safeModel(own(agent, "model") ?? defaults.model),
    });
    return result;
}
function valueType(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    return typeof value;
}
const CREDENTIAL_SEGMENTS = new Set([
    "apikey", "api_key", "authkey", "authtoken", "cookie", "credential", "credentials", "key",
    "oauth", "passphrase", "password", "privatekey", "private_key", "secret", "secrets",
    "sharedkey", "token",
]);
const PLATFORM_ROOTS = new Set([
    "bindings", "channels", "cron", "discovery", "env", "gateway", "hooks", "logging",
    "nodes", "plugins", "sessions", "tools",
]);
const HOST_FIELDS = new Set(["agentdir", "workspace", "workspacedir", "statepath", "homedir"]);
const PORTABLE_AGENT_FIELDS = new Set([
    "id", "name", "persona", "identity", "heartbeat", "bootstrapmaxchars", "bootstraptotalmaxchars",
    "thinkingdefault", "verbosedefault", "timeoutseconds", "model",
]);
const FORBIDDEN_DOCTOR_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const OMIT_DOCTOR_VALUE = Symbol("omit-doctor-value");
function credentialKey(key) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");
    return CREDENTIAL_SEGMENTS.has(normalized) ||
        /(?:token|secret|password|passwd|credential|credentials|cookie|authorization|authheader|oauth|bearer|auth)$/.test(normalized) ||
        /(?:apikey|privatekey|accesskey|signingkey|encryptionkey|clientkey|webhookkey)$/.test(normalized);
}
function blockedDoctorKey(key, depth, remaining) {
    const normalized = key.toLowerCase().replace(/-/g, "");
    return depth > 20 || remaining <= 0 || FORBIDDEN_DOCTOR_KEYS.has(normalized) ||
        credentialKey(key) || sensitiveInventoryKey(key) ||
        HOST_FIELDS.has(normalized) || PLATFORM_ROOTS.has(normalized);
}
function doctorArray(value, depth, budget) {
    return value.flatMap((entry) => {
        const sanitized = doctorValue(entry, "", depth + 1, budget);
        return sanitized === OMIT_DOCTOR_VALUE ? [] : [sanitized];
    });
}
function doctorObject(value, depth, budget) {
    const result = {};
    for (const [childKey, entry] of Object.entries(value)) {
        const sanitized = doctorValue(entry, childKey, depth + 1, budget);
        if (sanitized !== OMIT_DOCTOR_VALUE)
            result[childKey] = sanitized;
    }
    return result;
}
function doctorValue(value, key, depth, budget) {
    if (blockedDoctorKey(key, depth, budget.remaining))
        return OMIT_DOCTOR_VALUE;
    budget.remaining -= 1;
    if (Array.isArray(value))
        return doctorArray(value, depth, budget);
    const source = record(value);
    if (source)
        return doctorObject(source, depth, budget);
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return value;
    if (typeof value === "number")
        return Number.isFinite(value) ? value : OMIT_DOCTOR_VALUE;
    return OMIT_DOCTOR_VALUE;
}
function doctorCandidate(config, agent) {
    const defaults = record(record(config.agents)?.defaults);
    const budget = { remaining: 5_000 };
    const sanitizedAgent = doctorValue(agent, "", 0, budget);
    const sanitizedDefaults = defaults ? doctorValue(defaults, "", 0, budget) : undefined;
    const sourceOpenClawVersion = trimmedString(record(config.meta)?.lastTouchedVersion, 100);
    return compact({
        meta: sourceOpenClawVersion ? { lastTouchedVersion: sourceOpenClawVersion } : undefined,
        agents: compact({
            defaults: record(sanitizedDefaults) && Object.keys(sanitizedDefaults).length > 0
                ? sanitizedDefaults
                : undefined,
            list: [sanitizedAgent],
        }),
    });
}
function normalizedPathSegments(path) {
    return path.split("[").join(".").split("]").join(".").split(".")
        .filter(Boolean)
        .map((part) => part.toLowerCase().replace(/-/g, ""));
}
function inventoryClassification(path, sourcePrefix) {
    const rawSegments = path.split("[").join(".").split("]").join(".").split(".").filter(Boolean);
    if (rawSegments.some(sensitiveInventoryKey))
        return "credential";
    const segments = normalizedPathSegments(path);
    if (segments.some(credentialKey)) {
        return "credential";
    }
    if (segments.some((segment) => HOST_FIELDS.has(segment)))
        return "host";
    const root = segments[0] ?? "";
    if (PLATFORM_ROOTS.has(root))
        return "platform";
    if (path.startsWith(`${sourcePrefix}.`)) {
        const relative = path.slice(sourcePrefix.length + 1).toLowerCase().replace(/[-_]/g, "");
        const root = relative.split(".", 1)[0].split("[", 1)[0];
        const portableLeaf = /^(?:id|name|persona|bootstrapmaxchars|bootstraptotalmaxchars|thinkingdefault|verbosedefault|timeoutseconds)$/u.test(relative) ||
            /^identity(?:\.(?:name|emoji))?$/u.test(relative) ||
            /^heartbeat(?:\.(?:every|lightcontext))?$/u.test(relative) ||
            /^heartbeat\.activehours(?:\.(?:start|end|timezone))?$/u.test(relative) ||
            /^model(?:\.primary|\.fallbacks(?:\[\d+\])?)?$/u.test(relative);
        return PORTABLE_AGENT_FIELDS.has(root) && portableLeaf ? "customer" : "unknown";
    }
    return "unknown";
}
function inventoryEntries(value, path, sourcePrefix, entries, sourcePath = path) {
    const object = record(value);
    if (object && Object.keys(object).length > 0) {
        for (const key of Object.keys(object).sort()) {
            const safeKey = sensitiveInventoryKey(key) ? "$key" : key;
            inventoryEntries(object[key], path ? `${path}.${safeKey}` : safeKey, sourcePrefix, entries, sourcePath ? `${sourcePath}.${key}` : key);
        }
        return;
    }
    if (Array.isArray(value) && value.length > 0) {
        value.forEach((entry, index) => inventoryEntries(entry, `${path}[${index}]`, sourcePrefix, entries, `${sourcePath}[${index}]`));
        return;
    }
    entries.push({
        path,
        valueType: valueType(value),
        classification: inventoryClassification(sourcePath, sourcePrefix),
        sourceAgent: sourcePath === sourcePrefix || sourcePath.startsWith(`${sourcePrefix}.`) || sourcePath.startsWith(`${sourcePrefix}[`),
    });
}
export function buildAgentImportConfigArtifacts(source, selectedAgentId) {
    const config = record(source);
    if (!config)
        throw new AgentImportConfigError("invalid_source_config", "openclaw.json must contain an object");
    const list = record(config.agents)?.list;
    if (!Array.isArray(list)) {
        throw new AgentImportConfigError("source_agent_not_found", "openclaw.json has no agents.list");
    }
    const matches = list.flatMap((entry, index) => {
        const agent = record(entry);
        return agent?.id === selectedAgentId ? [{ agent, index }] : [];
    });
    if (matches.length === 0) {
        throw new AgentImportConfigError("source_agent_not_found", `source agent ${selectedAgentId} was not found`);
    }
    if (matches.length !== 1) {
        throw new AgentImportConfigError("source_agent_ambiguous", `source agent ${selectedAgentId} is duplicated`);
    }
    const selected = matches[0];
    const portable = portableAgent(config, selected.agent);
    const inventory = [];
    inventoryEntries(config, "", `agents.list[${selected.index}]`, inventory);
    const boundedInventory = inventory.length <= 500
        ? inventory
        : [
            ...inventory.slice(0, 499),
            {
                path: `$inventory.truncated[${inventory.length - 499}]`,
                valueType: "number",
                classification: "unknown",
                sourceAgent: false,
            },
        ];
    return {
        formatVersion: AGENT_IMPORT_FORMAT_VERSION,
        portableAgent: portable,
        configInventory: boundedInventory,
        doctorCandidate: doctorCandidate(config, selected.agent),
    };
}
function exactKeys(value, keys, code = "invalid_config_artifact") {
    if (Object.keys(value).some((key) => !keys.includes(key))) {
        throw new AgentImportConfigError(code, "config artifact contains an unknown field");
    }
}
function assertNoCredentialKeys(value) {
    if (Array.isArray(value)) {
        value.forEach(assertNoCredentialKeys);
        return;
    }
    const object = record(value);
    if (!object)
        return;
    for (const [key, entry] of Object.entries(object)) {
        const normalized = key.toLowerCase().replace(/-/g, "");
        if (credentialKey(key) || normalized === "env" || sensitiveInventoryKey(key)) {
            throw new AgentImportConfigError("unsafe_config_artifact", "credential-bearing config path is forbidden");
        }
        assertNoCredentialKeys(entry);
    }
}
const KNOWN_SECRET_PATTERNS = [
    /\bsk-[\w-]{20,}/u,
    /\bgh[pousr]_[A-Za-z\d]{30,}/u,
    /\bgithub_pat_\w{20,}/u,
    /\bxox[baprs]-[\w-]{20,}/u,
    /\bAKIA[\dA-Z]{16}\b/u,
    /\bAIza[\w-]{30,}/u,
];
function knownSecretValue(value) {
    return KNOWN_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}
function tokenEntropy(value) {
    const counts = new Map();
    for (const character of value)
        counts.set(character, (counts.get(character) ?? 0) + 1);
    return [...counts.values()].reduce((entropy, count) => {
        const probability = count / value.length;
        return entropy - probability * Math.log2(probability);
    }, 0);
}
function highEntropyCredential(value) {
    const candidates = [];
    let start = -1;
    for (let index = 0; index <= value.length; index += 1) {
        const character = value[index] ?? "";
        const allowed = /[\w+/=-]/u.test(character);
        if (allowed && start < 0)
            start = index;
        if (!allowed && start >= 0) {
            if (index - start >= 40)
                candidates.push(value.slice(start, index));
            start = -1;
        }
    }
    return candidates.some((candidate) => /[a-z]/u.test(candidate) && /[A-Z]/u.test(candidate) && /\d/u.test(candidate) && tokenEntropy(candidate) >= 4.5);
}
function looksLikeEmail(value) {
    if ([...value].some((character) => character.trim() === ""))
        return false;
    const at = value.indexOf("@");
    const dot = value.lastIndexOf(".");
    return at > 0 && at === value.lastIndexOf("@") && dot > at + 1 && dot < value.length - 1;
}
function sensitiveInventoryKey(value) {
    return knownSecretValue(value) || highEntropyCredential(value) || looksLikeEmail(value);
}
function sensitiveInventoryPath(value) {
    return value.includes("@") || sensitiveInventoryKey(value) ||
        value.split("[").join(".").split("]").join(".").split(".").filter(Boolean).some(sensitiveInventoryKey);
}
function assertNoCredentialValues(value) {
    if (typeof value === "string" && (knownSecretValue(value) || highEntropyCredential(value))) {
        throw new AgentImportConfigError("unsafe_config_artifact", "credential-like config value is forbidden");
    }
    if (Array.isArray(value)) {
        value.forEach(assertNoCredentialValues);
        return;
    }
    const object = record(value);
    if (object)
        Object.values(object).forEach(assertNoCredentialValues);
}
function validatePortable(value) {
    const portable = record(value);
    if (!portable)
        throw new AgentImportConfigError("invalid_config_artifact", "portableAgent must be an object");
    exactKeys(portable, [
        "sourceAgentId", "sourceOpenClawVersion", "name", "persona", "identity", "heartbeat",
        "bootstrapMaxChars", "bootstrapTotalMaxChars", "thinkingDefault", "verboseDefault",
        "timeoutSeconds", "requestedModel",
    ]);
    const sourceAgentId = trimmedString(portable.sourceAgentId, 160);
    if (!sourceAgentId)
        throw new AgentImportConfigError("invalid_config_artifact", "sourceAgentId is required");
    const synthetic = {
        meta: { lastTouchedVersion: portable.sourceOpenClawVersion },
        agents: { list: [{
                    id: sourceAgentId,
                    name: portable.name,
                    persona: portable.persona,
                    identity: portable.identity,
                    heartbeat: portable.heartbeat,
                    bootstrapMaxChars: portable.bootstrapMaxChars,
                    bootstrapTotalMaxChars: portable.bootstrapTotalMaxChars,
                    thinkingDefault: portable.thinkingDefault,
                    verboseDefault: portable.verboseDefault,
                    timeoutSeconds: portable.timeoutSeconds,
                    model: portable.requestedModel,
                }] },
    };
    const rebuilt = buildAgentImportConfigArtifacts(synthetic, sourceAgentId).portableAgent;
    if (stableJson(rebuilt) !== stableJson(portable)) {
        throw new AgentImportConfigError("invalid_config_artifact", "portableAgent contains an invalid value");
    }
    return rebuilt;
}
function validateInventory(value) {
    if (!Array.isArray(value) || value.length > 500) {
        throw new AgentImportConfigError("invalid_config_artifact", "configInventory must be a bounded array");
    }
    return value.map((raw) => {
        const entry = record(raw);
        if (!entry)
            throw new AgentImportConfigError("invalid_config_artifact", "inventory entry must be an object");
        exactKeys(entry, ["path", "valueType", "classification", "sourceAgent"]);
        if (typeof entry.path !== "string" || entry.path.length > 512 ||
            !["array", "boolean", "null", "number", "object", "string"].includes(String(entry.valueType)) ||
            !["credential", "host", "customer", "platform", "unknown"].includes(String(entry.classification)) ||
            typeof entry.sourceAgent !== "boolean") {
            throw new AgentImportConfigError("invalid_config_artifact", "inventory entry is invalid");
        }
        if (sensitiveInventoryPath(entry.path)) {
            throw new AgentImportConfigError("unsafe_config_artifact", "inventory path contains credential-like data");
        }
        return entry;
    });
}
export function validateAgentImportConfigArtifacts(value) {
    const artifacts = record(value);
    if (!artifacts)
        throw new AgentImportConfigError("invalid_config_artifact", "config artifacts must be an object");
    exactKeys(artifacts, ["formatVersion", "portableAgent", "configInventory", "doctorCandidate"]);
    if (artifacts.formatVersion !== AGENT_IMPORT_FORMAT_VERSION) {
        throw new AgentImportConfigError("invalid_config_artifact", "unsupported config artifact version");
    }
    assertNoCredentialKeys(artifacts.portableAgent);
    assertNoCredentialKeys(artifacts.doctorCandidate);
    assertNoCredentialValues(artifacts.portableAgent);
    assertNoCredentialValues(artifacts.doctorCandidate);
    const portable = validatePortable(artifacts.portableAgent);
    const inventory = validateInventory(artifacts.configInventory);
    const candidate = record(artifacts.doctorCandidate);
    const candidateList = record(candidate?.agents)?.list;
    const candidateAgent = Array.isArray(candidateList) && candidateList.length === 1
        ? record(candidateList[0])
        : null;
    if (!candidate || !candidateAgent || candidateAgent.id !== portable.sourceAgentId) {
        throw new AgentImportConfigError("invalid_config_artifact", "doctorCandidate must contain only the selected agent");
    }
    const expectedCandidate = doctorCandidate(candidate, candidateAgent);
    if (stableJson(expectedCandidate) !== stableJson(artifacts.doctorCandidate)) {
        throw new AgentImportConfigError("unsafe_config_artifact", "doctorCandidate contains a forbidden or non-canonical field");
    }
    const candidatePortable = portableAgent(candidate, candidateAgent);
    if (stableJson(candidatePortable) !== stableJson(portable)) {
        throw new AgentImportConfigError("unsafe_config_artifact", "doctorCandidate does not match portableAgent");
    }
    return {
        formatVersion: AGENT_IMPORT_FORMAT_VERSION,
        portableAgent: portable,
        configInventory: inventory,
        doctorCandidate: expectedCandidate,
    };
}
function runtimeEntries(portable) {
    const entries = [
        ["heartbeat", portable.heartbeat],
        ["bootstrapMaxChars", portable.bootstrapMaxChars],
        ["bootstrapTotalMaxChars", portable.bootstrapTotalMaxChars],
        ["thinkingDefault", portable.thinkingDefault],
        ["verboseDefault", portable.verboseDefault],
        ["timeoutSeconds", portable.timeoutSeconds],
    ];
    return entries.filter((entry) => entry[1] !== undefined);
}
function runtimeDecisionPaths(path, value) {
    const object = record(value);
    if (!object)
        return [path];
    return Object.entries(object).flatMap(([key, entry]) => runtimeDecisionPaths(`${path}.${key}`, entry));
}
function plannedRuntime(portable, doctorSafe) {
    const runtimePatch = {};
    const decisions = [];
    for (const [path, value] of runtimeEntries(portable)) {
        const paths = runtimeDecisionPaths(path, value);
        const disposition = doctorSafe ? "apply" : "manual_review";
        const reason = doctorSafe
            ? "validated by current OpenClaw doctor"
            : "current OpenClaw could not validate the source config";
        if (doctorSafe)
            runtimePatch[path] = structuredClone(value);
        decisions.push(...paths.map((decisionPath) => ({ path: decisionPath, disposition, reason })));
    }
    return { runtimePatch, decisions };
}
function modelDecisions(portable) {
    const decisions = [];
    if (portable.requestedModel?.primary) {
        decisions.push({
            path: "model.primary",
            disposition: "reauth_then_apply",
            reason: "model selection requires a new Octogee credential",
        });
    }
    if (portable.requestedModel?.fallbacks?.length) {
        decisions.push({
            path: "model.fallbacks",
            disposition: "reauth_then_apply",
            reason: "fallback models require new Octogee credentials",
        });
    }
    return decisions;
}
function droppedConfigReason(classification) {
    if (classification === "credential")
        return "credentials are never imported";
    if (classification === "unknown")
        return "field is not in the portable allowlist";
    return "field is owned by the source host or Octogee platform";
}
function appendDroppedConfigDecisions(decisions, inventory) {
    const seen = new Set(decisions.map((entry) => entry.path));
    for (const entry of inventory) {
        if (entry.classification === "customer" || seen.has(entry.path))
            continue;
        decisions.push({
            path: entry.path,
            disposition: entry.classification === "unknown" ? "drop_unsupported" : "drop_platform",
            reason: droppedConfigReason(entry.classification),
        });
        seen.add(entry.path);
    }
}
function reauthenticationRequirements(portable, inventory) {
    const requirements = [
        ...(portable.requestedModel?.primary ? ["models"] : []),
        ...(inventory.some((entry) => entry.path.startsWith("channels.")) ? ["channels"] : []),
        ...(inventory.some((entry) => entry.path.toLowerCase().includes("github")) ? ["github"] : []),
    ];
    return [...new Set(requirements)];
}
export function planAgentImportConfig(input, options) {
    const artifacts = validateAgentImportConfigArtifacts(input);
    const portable = artifacts.portableAgent;
    const doctorSafe = options.doctorOutcome === "migrated" || options.doctorOutcome === "unchanged";
    const identity = compact({
        name: portable.name ?? portable.identity?.name,
        persona: portable.persona,
        emoji: portable.identity?.emoji,
    });
    const planned = plannedRuntime(portable, doctorSafe);
    planned.decisions.push({
        path: "skipBootstrap",
        disposition: "apply",
        reason: options.workspacePolicy.preserveConvergedContextFiles
            ? "OpenClaw converges house-only context files"
            : "Builder-owned context files must not be recreated after import",
    });
    const decisions = Object.keys(identity).map((path) => ({
        path: `identity.${path}`,
        disposition: "apply",
        reason: "portable identity field",
    }));
    decisions.push(...planned.decisions, ...modelDecisions(portable));
    appendDroppedConfigDecisions(decisions, artifacts.configInventory);
    return {
        analyzer: "octogee-policy-v1",
        doctorOutcome: options.doctorOutcome,
        effectiveOutcome: agentImportConfigOutcome(portable, planned.runtimePatch),
        identity,
        workspaceRuntimePatch: {
            skipBootstrap: !options.workspacePolicy.preserveConvergedContextFiles,
        },
        runtimePatch: planned.runtimePatch,
        decisions,
        reauth: reauthenticationRequirements(portable, artifacts.configInventory),
    };
}
function agentImportConfigOutcome(portable, runtimePatch) {
    if (Object.keys(runtimePatch).length > 0)
        return "applied";
    return runtimeEntries(portable).length === 0 ? "unchanged" : "safe_baseline";
}
const ARCHIVE_METADATA = new Set([
    "manifest.json", "portable-agent.json", "config-inventory.json", "doctor-candidate.json",
]);
const BLOCKED_WORKSPACE_SEGMENTS = new Set([
    ".git", ".ssh", ".openclaw", ".aws", ".azure", ".kube", ".docker",
]);
const SENSITIVE_WORKSPACE_DIRECTORY = /^(?:credentials?|secrets?|sessions?|auth[-_]?profiles?)$/;
const OPENCLAW_CONFIG_BACKUP = /^openclaw\.json(?:[._-].+|~)$/;
const RUNTIME_WORKSPACE_FILES = new Set(["openclaw-workspace-state.json"]);
function hasControlCharacter(value) {
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code <= 31 || code === 127)
            return true;
    }
    return false;
}
function safeRelativePath(path) {
    if (!path || path.length > 2_048 || hasControlCharacter(path) || path.includes("\\"))
        return null;
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
        return null;
    const segments = path.split("/");
    return segments.some((segment) => !segment || segment === "." || segment === "..") ? null : segments;
}
export function classifyAgentImportArchivePath(path) {
    if (ARCHIVE_METADATA.has(path))
        return "metadata";
    const segments = safeRelativePath(path);
    if (!segments)
        return null;
    if (segments[0] === "workspace")
        return classifyWorkspaceArchivePath(segments.slice(1));
    return segments[0] === "git" ? classifyGitArchivePath(segments.slice(1).join("/")) : null;
}
function classifyWorkspaceArchivePath(relative) {
    if (relative.length === 0)
        return null;
    const lowered = relative.map((segment) => segment.toLowerCase());
    if (lowered.some((segment) => BLOCKED_WORKSPACE_SEGMENTS.has(segment)))
        return null;
    if (lowered.some((segment) => SENSITIVE_WORKSPACE_DIRECTORY.test(segment)))
        return null;
    if (lowered.some((segment) => segment === ".env" || segment.startsWith(".env.")))
        return null;
    const leaf = lowered[lowered.length - 1];
    if (leaf === "openclaw.json" || OPENCLAW_CONFIG_BACKUP.test(leaf) ||
        [".npmrc", ".pypirc", ".netrc", ".git-credentials", "application_default_credentials.json"].includes(leaf) ||
        lowered.some((segment, index) => segment === ".config" && lowered[index + 1] === "gcloud"))
        return null;
    if (relative.length === 1 && RUNTIME_WORKSPACE_FILES.has(leaf))
        return null;
    if (relative.length === 1 && /^(credentials?|secrets?)([._-].*)?$/.test(leaf))
        return null;
    if (/(^|[._-])(id_rsa|id_ed25519|private[-_.]?key)([._-]|$)/.test(leaf))
        return null;
    return "workspace";
}
function classifyGitArchivePath(relative) {
    if (["HEAD", "packed-refs"].includes(relative))
        return "git";
    if (/^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$/.test(relative))
        return "git";
    if (/^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(relative))
        return "git";
    if (/^objects\/pack\/pack-[0-9a-f]{40}\.(pack|idx)$/.test(relative))
        return "git";
    return null;
}
function stableValue(value) {
    if (Array.isArray(value))
        return value.map(stableValue);
    const object = record(value);
    if (!object)
        return value;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, stableValue(object[key])]));
}
function stableJson(value) {
    return JSON.stringify(stableValue(value));
}
export function buildAgentImportApprovalInput(fields) {
    return stableJson(fields);
}
