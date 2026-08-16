export const GOOGLE_CAPABILITY_CATALOG_VERSION = 1;

export type GoogleCapabilityAuthMode =
  | "user-oauth"
  | "workspace-domain-wide-delegation"
  | "service-account"
  | "api-key"
  | "separate-oauth"
  | "octogee-workflow";

export type GoogleCapabilityApprovalClass = "read" | "write" | "destructive" | "high-risk";

export type GoogleCapabilityAvailability = "active" | "catalogued";

export interface GoogleCapabilityDefinition {
  id: string;
  title: string;
  tagline: string;
  authMode: GoogleCapabilityAuthMode;
  scopes: readonly string[];
  approvalClass: GoogleCapabilityApprovalClass;
  availability: GoogleCapabilityAvailability;
  commandFamilies: readonly string[];
}

export interface OctogeeControlledCommandFamily {
  id: string;
  commandFamilies: readonly string[];
  reason: string;
}

const active = "active" as const;
const catalogued = "catalogued" as const;
const userOAuth = "user-oauth" as const;

export const GOOGLE_CAPABILITY_CATALOG = [
  {
    id: "calendar",
    title: "Google Calendar",
    tagline: "Your agent reads your schedule and manages your events",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    approvalClass: "write",
    availability: active,
    commandFamilies: ["calendar"],
  },
  {
    id: "gmail",
    title: "Gmail",
    tagline: "Your agent reads, triages, drafts and sends email; it cannot permanently delete messages",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    approvalClass: "high-risk",
    availability: active,
    commandFamilies: ["gmail"],
  },
  {
    id: "drive",
    title: "Google Drive",
    tagline: "Your agent works with files you share and creates its own",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    approvalClass: "write",
    availability: active,
    commandFamilies: ["drive", "docs", "sheets"],
  },
  {
    id: "tasks",
    title: "Google Tasks",
    tagline: "Your agent can read, create and complete your tasks",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/tasks"],
    approvalClass: "write",
    availability: active,
    commandFamilies: ["tasks"],
  },
  {
    id: "contacts",
    title: "Google Contacts",
    tagline: "Your agent looks up names, emails and organizations (read-only)",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
    approvalClass: "read",
    availability: active,
    commandFamilies: ["contacts", "people"],
  },
  {
    id: "drive-activity",
    title: "Drive activity",
    tagline: "Audit activity for files your account can access",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/drive.activity.readonly"],
    approvalClass: "read",
    availability: catalogued,
    commandFamilies: ["drive activity"],
  },
  {
    id: "drive-labels",
    title: "Drive labels",
    tagline: "Read Workspace Drive label definitions",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/drive.labels.readonly"],
    approvalClass: "read",
    availability: catalogued,
    commandFamilies: ["drive labels"],
  },
  {
    id: "docs",
    title: "Google Docs",
    tagline: "Create, read, edit, export and comment on documents",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"],
    approvalClass: "write",
    availability: catalogued,
    commandFamilies: ["docs"],
  },
  {
    id: "sheets",
    title: "Google Sheets",
    tagline: "Read, write, format and organize spreadsheets",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"],
    approvalClass: "write",
    availability: catalogued,
    commandFamilies: ["sheets"],
  },
  {
    id: "slides",
    title: "Google Slides",
    tagline: "Create, edit, export and organize presentations",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/presentations"],
    approvalClass: "write",
    availability: catalogued,
    commandFamilies: ["slides"],
  },
  {
    id: "forms",
    title: "Google Forms",
    tagline: "Create and manage forms and responses",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/forms.body", "https://www.googleapis.com/auth/forms.responses.readonly"],
    approvalClass: "write",
    availability: catalogued,
    commandFamilies: ["forms"],
  },
  {
    id: "meet",
    title: "Google Meet",
    tagline: "Create and manage meeting spaces and their records",
    authMode: userOAuth,
    scopes: [
      "https://www.googleapis.com/auth/meetings.space.created",
      "https://www.googleapis.com/auth/meetings.space.readonly",
      "https://www.googleapis.com/auth/meetings.space.settings",
    ],
    approvalClass: "write",
    availability: catalogued,
    commandFamilies: ["meet"],
  },
  {
    id: "chat",
    title: "Google Chat",
    tagline: "Read and send direct messages, spaces, threads and reactions",
    authMode: userOAuth,
    scopes: [
      "https://www.googleapis.com/auth/chat.spaces",
      "https://www.googleapis.com/auth/chat.messages",
      "https://www.googleapis.com/auth/chat.memberships",
      "https://www.googleapis.com/auth/chat.users.readstate.readonly",
      "https://www.googleapis.com/auth/chat.messages.reactions.create",
      "https://www.googleapis.com/auth/chat.messages.reactions.readonly",
    ],
    approvalClass: "high-risk",
    availability: catalogued,
    commandFamilies: ["chat"],
  },
  {
    id: "classroom",
    title: "Google Classroom",
    tagline: "Manage courses, coursework, rosters and submissions",
    authMode: userOAuth,
    scopes: [
      "https://www.googleapis.com/auth/classroom.courses",
      "https://www.googleapis.com/auth/classroom.rosters",
      "https://www.googleapis.com/auth/classroom.coursework.students",
      "https://www.googleapis.com/auth/classroom.coursework.me",
      "https://www.googleapis.com/auth/classroom.courseworkmaterials",
      "https://www.googleapis.com/auth/classroom.announcements",
      "https://www.googleapis.com/auth/classroom.topics",
      "https://www.googleapis.com/auth/classroom.guardianlinks.students",
      "https://www.googleapis.com/auth/classroom.profile.emails",
      "https://www.googleapis.com/auth/classroom.profile.photos",
    ],
    approvalClass: "high-risk",
    availability: catalogued,
    commandFamilies: ["classroom"],
  },
  {
    id: "appscript",
    title: "Google Apps Script",
    tagline: "Manage projects and run explicitly authorized deployed functions",
    authMode: userOAuth,
    scopes: [
      "https://www.googleapis.com/auth/script.projects",
      "https://www.googleapis.com/auth/script.deployments",
      "https://www.googleapis.com/auth/script.processes",
    ],
    approvalClass: "high-risk",
    availability: catalogued,
    commandFamilies: ["appscript"],
  },
  {
    id: "analytics",
    title: "Google Analytics",
    tagline: "Read GA4 account summaries and reports",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    approvalClass: "read",
    availability: catalogued,
    commandFamilies: ["analytics"],
  },
  {
    id: "search-console",
    title: "Google Search Console",
    tagline: "Read search performance and manage sitemaps for verified sites",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/webmasters"],
    approvalClass: "write",
    availability: catalogued,
    commandFamilies: ["searchconsole"],
  },
  {
    id: "youtube",
    title: "YouTube",
    tagline: "Read channel data and manage authorized playlists, comments and subscriptions",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
    approvalClass: "high-risk",
    availability: catalogued,
    commandFamilies: ["youtube"],
  },
  {
    id: "photos",
    title: "Google Photos",
    tagline: "Access app-created and explicitly user-selected media",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata"],
    approvalClass: "read",
    availability: catalogued,
    commandFamilies: ["photos"],
  },
  {
    id: "photos-picker",
    title: "Google Photos Picker",
    tagline: "Import only media a Builder explicitly selects",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/photospicker.mediaitems.readonly"],
    approvalClass: "read",
    availability: catalogued,
    commandFamilies: ["photos picker"],
  },
  {
    id: "sites",
    title: "Google Sites",
    tagline: "Read and manage Drive-backed Sites files",
    authMode: userOAuth,
    scopes: ["https://www.googleapis.com/auth/drive"],
    approvalClass: "write",
    availability: catalogued,
    commandFamilies: ["sites"],
  },
  {
    id: "groups",
    title: "Workspace groups",
    tagline: "Read Cloud Identity group and membership information",
    authMode: "workspace-domain-wide-delegation",
    scopes: ["https://www.googleapis.com/auth/cloud-identity.groups.readonly"],
    approvalClass: "read",
    availability: catalogued,
    commandFamilies: ["groups"],
  },
  {
    id: "keep",
    title: "Google Keep",
    tagline: "Manage Workspace Keep notes through an organization connection",
    authMode: "workspace-domain-wide-delegation",
    scopes: ["https://www.googleapis.com/auth/keep"],
    approvalClass: "high-risk",
    availability: catalogued,
    commandFamilies: ["keep"],
  },
  {
    id: "admin-directory",
    title: "Workspace Admin Directory",
    tagline: "Manage Workspace users, groups and organizational units",
    authMode: "workspace-domain-wide-delegation",
    scopes: [
      "https://www.googleapis.com/auth/admin.directory.user",
      "https://www.googleapis.com/auth/admin.directory.group",
      "https://www.googleapis.com/auth/admin.directory.group.member",
    ],
    approvalClass: "destructive",
    availability: catalogued,
    commandFamilies: ["admin"],
  },
  {
    id: "maps",
    title: "Google Maps",
    tagline: "Use constrained Maps APIs with a separately budgeted project key",
    authMode: "api-key",
    scopes: [],
    approvalClass: "read",
    availability: catalogued,
    commandFamilies: ["maps"],
  },
  {
    id: "zoom",
    title: "Zoom",
    tagline: "Create and manage Zoom meetings through a separate Zoom connection",
    authMode: "separate-oauth",
    scopes: [],
    approvalClass: "high-risk",
    availability: catalogued,
    commandFamilies: ["zoom"],
  },
  {
    id: "backup-export",
    title: "Google data export",
    tagline: "Run encrypted export and recovery workflows outside the agent runtime",
    authMode: "octogee-workflow",
    scopes: [],
    approvalClass: "destructive",
    availability: catalogued,
    commandFamilies: ["backup", "batch"],
  },
] as const satisfies readonly GoogleCapabilityDefinition[];

export type GoogleCatalogCapabilityId = (typeof GOOGLE_CAPABILITY_CATALOG)[number]["id"];

export const GOOGLE_ACTIVE_PERSONAL_CAPABILITIES = GOOGLE_CAPABILITY_CATALOG.filter(
  (capability) => capability.availability === active && capability.authMode === userOAuth,
) as readonly Extract<(typeof GOOGLE_CAPABILITY_CATALOG)[number], { availability: "active"; authMode: "user-oauth" }>[];

export const OCTOGEE_CONTROLLED_GOG_COMMAND_FAMILIES = [
  {
    id: "credential-lifecycle",
    commandFamilies: ["auth", "login", "logout", "config", "status"],
    reason: "Octogee owns OAuth clients, refresh tokens, service credentials and safety controls.",
  },
  {
    id: "generic-api",
    commandFamilies: ["api"],
    reason: "Every provider operation must have a reviewed typed contract, approval class and safe preview.",
  },
  {
    id: "local-runtime",
    commandFamilies: ["completion", "schema", "time", "open", "version", "update"],
    reason: "These are local CLI behaviors, not connected-service capabilities.",
  },
] as const satisfies readonly OctogeeControlledCommandFamily[];

export function googleCapabilityDefinition(id: string): GoogleCapabilityDefinition | undefined {
  return GOOGLE_CAPABILITY_CATALOG.find((capability) => capability.id === id);
}
