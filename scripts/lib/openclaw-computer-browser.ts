type JsonObject = Record<string, unknown>;

function objectAt(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (value === undefined) {
    const object: JsonObject = {};
    parent[key] = object;
    return object;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenClaw computer browser requires object ${key}`);
  }
  return value as JsonObject;
}

function stringList(parent: JsonObject, key: string): string[] {
  const value = parent[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`OpenClaw computer browser requires string array ${key}`);
  }
  return value;
}

export const DESKTOP_TOOLS = ["browser", "computer", "nodes", "file-transfer", "ollama"] as const;
export const GATEWAY_HOST_DESKTOP_AUTH_DIR = "/run/octogee-desktop-vnc";
export const COMPUTER_SKILLS_DIR = "/opt/octogee/skills/computer";
const FILE_TRANSFER_NODE_COMMANDS = [
  "file.stat",
  "file.fetch",
  "dir.list",
  "dir.fetch",
  "file.create",
  "file.write",
  "workspace.memory",
  "workspace.skills",
] as const;

function builderComputer(env: NodeJS.ProcessEnv): boolean {
  return env.GATEWAY_CLASS === "builder" && env.GATEWAY_RUNTIME_KIND === "gce-vm";
}

export function applyComputerBrowserAgentPolicy(
  agent: JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!builderComputer(env)) return;
  const ownerSlug = env.GATEWAY_BUILDER_SLUG?.trim();
  const ownerCoach = ownerSlug && agent.id === `octogee-${ownerSlug}-coach`;
  if (ownerCoach) {
    const tools = agent.tools;
    if (!tools || typeof tools !== "object" || Array.isArray(tools)) return;
    const policy = tools as JsonObject;
    policy.profile = "full";
    Reflect.deleteProperty(policy, "allow");
    const deny = stringList(policy, "deny").filter((tool) => !DESKTOP_TOOLS.includes(tool as typeof DESKTOP_TOOLS[number]));
    if (deny.length > 0) policy.deny = deny;
    else Reflect.deleteProperty(policy, "deny");
    return;
  }
  const tools = objectAt(agent, "tools");
  tools.deny = [...new Set([...stringList(tools, "deny"), ...DESKTOP_TOOLS])];
}

export function applyOpenClawComputerBrowserConfig(
  config: JsonObject,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!builderComputer(env)) return false;
  const before = JSON.stringify(config);
  Object.assign(objectAt(objectAt(config, "desktop"), "host"), {
    enabled: true,
    managed: false,
    port: 5901,
    passwordFile: `${GATEWAY_HOST_DESKTOP_AUTH_DIR}/password`,
  });
  const browser = objectAt(config, "browser");
  Object.assign(browser, {
    enabled: true,
    defaultProfile: "computer",
    headless: false,
    attachOnly: true,
    cdpUrl: "http://127.0.0.1:9222",
  });
  objectAt(browser, "profiles").computer = {
    driver: "openclaw",
    cdpUrl: "http://127.0.0.1:9222",
    attachOnly: true,
  };
  const plugins = objectAt(config, "plugins");
  plugins.allow = [...new Set([...stringList(plugins, "allow"), "browser", "cua-computer", "file-transfer", "ollama"])];
  const entries = objectAt(plugins, "entries");
  for (const id of ["browser", "file-transfer", "ollama"]) objectAt(entries, id).enabled = true;
  const fileTransfer = objectAt(objectAt(entries, "file-transfer"), "config");
  const filePolicy = objectAt(objectAt(fileTransfer, "nodes"), "octogee-desktop");
  if (filePolicy.ask === undefined) filePolicy.ask = "on-miss";
  const discovery = objectAt(objectAt(objectAt(entries, "ollama"), "config"), "discovery");
  if (discovery.enabled === undefined) discovery.enabled = false;
  const tools = objectAt(config, "tools");
  tools.profile = "full";
  Reflect.deleteProperty(tools, "allow");
  const skillLoad = objectAt(objectAt(config, "skills"), "load");
  skillLoad.extraDirs = [...new Set([...stringList(skillLoad, "extraDirs"), COMPUTER_SKILLS_DIR])];
  const nodes = objectAt(objectAt(config, "gateway"), "nodes");
  nodes.browser = { mode: "off" };
  const commands = objectAt(nodes, "commands");
  commands.allow = [...new Set([...stringList(commands, "allow"), ...FILE_TRANSFER_NODE_COMMANDS])];
  Reflect.deleteProperty(commands, "deny");
  const agents = objectAt(config, "agents");
  if (agents.list !== undefined) {
    if (!Array.isArray(agents.list)) throw new Error("OpenClaw computer browser requires agents.list array");
    for (const agent of agents.list) applyComputerBrowserAgentPolicy(agent, env);
  }
  if (agents.entries !== undefined) {
    for (const [id, agent] of Object.entries(objectAt(agents, "entries"))) {
      if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
        throw new Error(`OpenClaw computer browser requires object agent ${id}`);
      }
      const entry = agent as JsonObject;
      const policy: JsonObject = { ...entry, id };
      applyComputerBrowserAgentPolicy(policy, env);
      entry.tools = policy.tools;
    }
  }
  return before !== JSON.stringify(config);
}
