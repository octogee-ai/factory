export const AGENT_LOOK_STYLES = ["octo", "blob", "droplet", "ghost", "star", "kit"] as const;

export type AgentLookStyle = (typeof AGENT_LOOK_STYLES)[number];

export interface AgentLook {
  style: AgentLookStyle;
  color: string;
}

const LOOK_COLOR = /^#[0-9a-f]{6}$/;

function isAgentLookStyle(value: unknown): value is AgentLookStyle {
  return typeof value === "string" && (AGENT_LOOK_STYLES as readonly string[]).includes(value);
}

function isAgentLookColor(value: unknown): value is string {
  return typeof value === "string" && LOOK_COLOR.test(value);
}

export function parseAgentLook(value: unknown): AgentLook | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { style, color } = value as Record<string, unknown>;
  return isAgentLookStyle(style) && isAgentLookColor(color) ? { style, color } : null;
}
