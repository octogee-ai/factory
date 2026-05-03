/**
 * The 6 vibes a Builder picks at onboarding. Stored lowercase to match the
 * codebase's slug/enum conventions; TitleCase is only ever a display transform.
 * Any stored value outside this set falls back to the default noun "Workspace"
 * for display_name and DEFAULT_TYPING_PHRASES for the typing indicator.
 */
export const WORKSPACE_VIBE_PRESETS = [
  "office",
  "garage",
  "shop",
  "studio",
  "clubhouse",
  "crib",
] as const;

export type WorkspaceVibe = (typeof WORKSPACE_VIBE_PRESETS)[number];

/** Noun used when no valid vibe is selected or the vibe picker is skipped. */
export const DEFAULT_VIBE_NOUN = "Workspace";

/** Type guard at API/data boundaries. */
export function isWorkspaceVibe(v: unknown): v is WorkspaceVibe {
  return (
    typeof v === "string" &&
    (WORKSPACE_VIBE_PRESETS as readonly string[]).includes(v)
  );
}

/**
 * Display-only: "office" → "Office", "garage" → "Garage", …  Unknown inputs
 * fall back to the default noun ("Workspace"). Never writes to storage —
 * storage values are the lowercase presets only.
 */
export function titleCaseVibe(vibe: string | null | undefined): string {
  if (!isWorkspaceVibe(vibe)) return DEFAULT_VIBE_NOUN;
  return vibe.charAt(0).toUpperCase() + vibe.slice(1);
}

/**
 * Compute the MM team display_name for a workspace.
 *
 * Rules (in order):
 *   1. firstName + known vibe → "{firstName}'s {TitleCase(vibe)}"
 *   2. firstName only         → "{firstName}'s Workspace"
 *   3. no firstName           → "{slug}'s Workspace" (and vibe still honored if known)
 *
 * Throws if slug is missing — slug is identity and must always be present.
 */
export function computeWorkspaceDisplayName(params: {
  slug: string;
  firstName?: string | null;
  vibe?: string | null;
}): string {
  const { slug, firstName, vibe } = params;

  const trimmedSlug = typeof slug === "string" ? slug.trim() : "";
  if (trimmedSlug.length === 0) {
    throw new Error("computeWorkspaceDisplayName: slug is required");
  }

  const noun = isWorkspaceVibe(vibe) ? titleCaseVibe(vibe) : DEFAULT_VIBE_NOUN;

  const trimmedFirstName = typeof firstName === "string" ? firstName.trim() : "";
  const owner = trimmedFirstName.length > 0 ? trimmedFirstName : trimmedSlug;

  return `${owner}'s ${noun}`;
}

/**
 * Display names for the three workspace channels. Spec §Naming rules:
 *   general → "General"
 *   admin   → "Admin"  (no "— {slug}" suffix)
 *   coach   → "Coach"  (rendered as DM in the UI by convention)
 */
export const WORKSPACE_CHANNEL_DISPLAY_NAMES = {
  general: "General",
  admin: "Admin",
  coach: "Coach",
} as const;

export type WorkspaceChannelKind = keyof typeof WORKSPACE_CHANNEL_DISPLAY_NAMES;

/**
 * Compute the display_name for a project channel.
 *
 *   "{projectName} General"       for the auto-created default channel
 *   "{projectName} {channelName}" for any future per-project channel
 *
 * The prefix lets the sidebar group channels under their project by
 * convention (match-and-strip), without storing any per-channel grouping
 * metadata.
 */
export function computeProjectChannelDisplayName(params: {
  projectName: string;
  channelName: string;
}): string {
  const trimmedProject =
    typeof params.projectName === "string" ? params.projectName.trim() : "";
  const trimmedChannel =
    typeof params.channelName === "string" ? params.channelName.trim() : "";

  if (trimmedProject.length === 0) {
    throw new Error("computeProjectChannelDisplayName: projectName is required");
  }
  if (trimmedChannel.length === 0) {
    throw new Error("computeProjectChannelDisplayName: channelName is required");
  }

  return `${trimmedProject} ${trimmedChannel}`;
}

/**
 * Per-vibe phrase lists used by the typing indicator. Seeded into
 * `systemTypingPhrases/{vibe}` at first-boot by scripts/seed-typing-phrases.ts
 * and editable from the admin Phrase Manager. Clients also fall back to this
 * map locally when the Firestore doc is absent.
 *
 * Spec: CHAT-POLISH-SPEC §B4 / D4.
 */
export const TYPING_PHRASES_BY_VIBE: Record<WorkspaceVibe, readonly string[]> = {
  office: ["analyzing", "crunching the numbers", "strategizing", "briefing"],
  garage: ["tinkering", "soldering", "hacking", "duct-taping"],
  shop: ["measuring twice", "sawing", "sanding", "finishing"],
  studio: ["drafting", "sketching", "composing", "dreaming up something"],
  clubhouse: ["rallying the crew", "plotting", "kicking ideas around", "vibing"],
  crib: ["chilling", "noodling", "vibing", "kicking ideas around"],
};

/**
 * Fallback phrase list used when a workspace has no `vibe` set (pre-selection
 * or skipped). Keeps the typing indicator non-silent for the default
 * "Workspace" noun.
 */
export const DEFAULT_TYPING_PHRASES: readonly string[] = [
  "philosophizing",
  "vibing",
  "Clauding",
  "dreaming up something",
  "cooking",
];
