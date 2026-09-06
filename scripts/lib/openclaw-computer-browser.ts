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

export const DESKTOP_TOOLS = ["browser", "computer"] as const;
export const DESKTOP_NODE_DENIED_COMMANDS = [
  "system.run",
  "system.run.prepare",
  "system.which",
  "system.execApprovals.get",
  "system.execApprovals.set",
  "terminal.upload",
  "fs.listDir",
  "browser.proxy",
  "browser.proxy.upload.v1",
  "mcp.tools.call.v1",
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
  if (ownerCoach) return;
  const tools = objectAt(agent, "tools");
  tools.deny = [...new Set([...stringList(tools, "deny"), ...DESKTOP_TOOLS])];
}

export function applyOpenClawComputerBrowserConfig(
  config: JsonObject,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!builderComputer(env)) return false;
  const before = JSON.stringify(config);
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
  plugins.allow = [...new Set([...stringList(plugins, "allow"), "browser"])];
  objectAt(objectAt(plugins, "entries"), "browser").enabled = true;
  const tools = objectAt(config, "tools");
  tools.alsoAllow = [...new Set([...stringList(tools, "alsoAllow"), ...DESKTOP_TOOLS])];
  const commands = objectAt(objectAt(objectAt(config, "gateway"), "nodes"), "commands");
  commands.deny = [...new Set([...stringList(commands, "deny"), ...DESKTOP_NODE_DENIED_COMMANDS])];
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
