export declare const GOOGLE_CAPABILITY_CATALOG_VERSION = 1;
export type GoogleCapabilityAuthMode = "user-oauth" | "workspace-domain-wide-delegation" | "service-account" | "api-key" | "separate-oauth" | "octogee-workflow";
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
export declare const GOOGLE_CAPABILITY_CATALOG: readonly [{
    readonly id: "calendar";
    readonly title: "Google Calendar";
    readonly tagline: "Your agent reads your schedule and manages your events";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/calendar.events"];
    readonly approvalClass: "write";
    readonly availability: "active";
    readonly commandFamilies: readonly ["calendar"];
}, {
    readonly id: "gmail";
    readonly title: "Gmail";
    readonly tagline: "Your agent reads, triages, drafts and sends email; it cannot permanently delete messages";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/gmail.modify"];
    readonly approvalClass: "high-risk";
    readonly availability: "active";
    readonly commandFamilies: readonly ["gmail"];
}, {
    readonly id: "drive";
    readonly title: "Google Drive";
    readonly tagline: "Your agent works with files you share and creates its own";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/drive.file"];
    readonly approvalClass: "write";
    readonly availability: "active";
    readonly commandFamilies: readonly ["drive", "docs", "sheets"];
}, {
    readonly id: "tasks";
    readonly title: "Google Tasks";
    readonly tagline: "Your agent can read, create and complete your tasks";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/tasks"];
    readonly approvalClass: "write";
    readonly availability: "active";
    readonly commandFamilies: readonly ["tasks"];
}, {
    readonly id: "contacts";
    readonly title: "Google Contacts";
    readonly tagline: "Your agent looks up names, emails and organizations (read-only)";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/contacts.readonly"];
    readonly approvalClass: "read";
    readonly availability: "active";
    readonly commandFamilies: readonly ["contacts", "people"];
}, {
    readonly id: "drive-activity";
    readonly title: "Drive activity";
    readonly tagline: "Audit activity for files your account can access";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/drive.activity.readonly"];
    readonly approvalClass: "read";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["drive activity"];
}, {
    readonly id: "drive-labels";
    readonly title: "Drive labels";
    readonly tagline: "Read Workspace Drive label definitions";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/drive.labels.readonly"];
    readonly approvalClass: "read";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["drive labels"];
}, {
    readonly id: "docs";
    readonly title: "Google Docs";
    readonly tagline: "Create, read, edit, export and comment on documents";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"];
    readonly approvalClass: "write";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["docs"];
}, {
    readonly id: "sheets";
    readonly title: "Google Sheets";
    readonly tagline: "Read, write, format and organize spreadsheets";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"];
    readonly approvalClass: "write";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["sheets"];
}, {
    readonly id: "slides";
    readonly title: "Google Slides";
    readonly tagline: "Create, edit, export and organize presentations";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/presentations"];
    readonly approvalClass: "write";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["slides"];
}, {
    readonly id: "forms";
    readonly title: "Google Forms";
    readonly tagline: "Create and manage forms and responses";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/forms.body", "https://www.googleapis.com/auth/forms.responses.readonly"];
    readonly approvalClass: "write";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["forms"];
}, {
    readonly id: "meet";
    readonly title: "Google Meet";
    readonly tagline: "Create and manage meeting spaces and their records";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/meetings.space.created", "https://www.googleapis.com/auth/meetings.space.readonly", "https://www.googleapis.com/auth/meetings.space.settings"];
    readonly approvalClass: "write";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["meet"];
}, {
    readonly id: "chat";
    readonly title: "Google Chat";
    readonly tagline: "Read and send direct messages, spaces, threads and reactions";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/chat.spaces", "https://www.googleapis.com/auth/chat.messages", "https://www.googleapis.com/auth/chat.memberships", "https://www.googleapis.com/auth/chat.users.readstate.readonly", "https://www.googleapis.com/auth/chat.messages.reactions.create", "https://www.googleapis.com/auth/chat.messages.reactions.readonly"];
    readonly approvalClass: "high-risk";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["chat"];
}, {
    readonly id: "classroom";
    readonly title: "Google Classroom";
    readonly tagline: "Manage courses, coursework, rosters and submissions";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/classroom.courses", "https://www.googleapis.com/auth/classroom.rosters", "https://www.googleapis.com/auth/classroom.coursework.students", "https://www.googleapis.com/auth/classroom.coursework.me", "https://www.googleapis.com/auth/classroom.courseworkmaterials", "https://www.googleapis.com/auth/classroom.announcements", "https://www.googleapis.com/auth/classroom.topics", "https://www.googleapis.com/auth/classroom.guardianlinks.students", "https://www.googleapis.com/auth/classroom.profile.emails", "https://www.googleapis.com/auth/classroom.profile.photos"];
    readonly approvalClass: "high-risk";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["classroom"];
}, {
    readonly id: "appscript";
    readonly title: "Google Apps Script";
    readonly tagline: "Manage projects and run explicitly authorized deployed functions";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/script.projects", "https://www.googleapis.com/auth/script.deployments", "https://www.googleapis.com/auth/script.processes"];
    readonly approvalClass: "high-risk";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["appscript"];
}, {
    readonly id: "analytics";
    readonly title: "Google Analytics";
    readonly tagline: "Read GA4 account summaries and reports";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/analytics.readonly"];
    readonly approvalClass: "read";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["analytics"];
}, {
    readonly id: "search-console";
    readonly title: "Google Search Console";
    readonly tagline: "Read search performance and manage sitemaps for verified sites";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/webmasters"];
    readonly approvalClass: "write";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["searchconsole"];
}, {
    readonly id: "youtube";
    readonly title: "YouTube";
    readonly tagline: "Read channel data and manage authorized playlists, comments and subscriptions";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/youtube.force-ssl"];
    readonly approvalClass: "high-risk";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["youtube"];
}, {
    readonly id: "photos";
    readonly title: "Google Photos";
    readonly tagline: "Access app-created and explicitly user-selected media";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata"];
    readonly approvalClass: "read";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["photos"];
}, {
    readonly id: "photos-picker";
    readonly title: "Google Photos Picker";
    readonly tagline: "Import only media a Builder explicitly selects";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/photospicker.mediaitems.readonly"];
    readonly approvalClass: "read";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["photos picker"];
}, {
    readonly id: "sites";
    readonly title: "Google Sites";
    readonly tagline: "Read and manage Drive-backed Sites files";
    readonly authMode: "user-oauth";
    readonly scopes: readonly ["https://www.googleapis.com/auth/drive"];
    readonly approvalClass: "write";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["sites"];
}, {
    readonly id: "groups";
    readonly title: "Workspace groups";
    readonly tagline: "Read Cloud Identity group and membership information";
    readonly authMode: "workspace-domain-wide-delegation";
    readonly scopes: readonly ["https://www.googleapis.com/auth/cloud-identity.groups.readonly"];
    readonly approvalClass: "read";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["groups"];
}, {
    readonly id: "keep";
    readonly title: "Google Keep";
    readonly tagline: "Manage Workspace Keep notes through an organization connection";
    readonly authMode: "workspace-domain-wide-delegation";
    readonly scopes: readonly ["https://www.googleapis.com/auth/keep"];
    readonly approvalClass: "high-risk";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["keep"];
}, {
    readonly id: "admin-directory";
    readonly title: "Workspace Admin Directory";
    readonly tagline: "Manage Workspace users, groups and organizational units";
    readonly authMode: "workspace-domain-wide-delegation";
    readonly scopes: readonly ["https://www.googleapis.com/auth/admin.directory.user", "https://www.googleapis.com/auth/admin.directory.group", "https://www.googleapis.com/auth/admin.directory.group.member"];
    readonly approvalClass: "destructive";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["admin"];
}, {
    readonly id: "maps";
    readonly title: "Google Maps";
    readonly tagline: "Use constrained Maps APIs with a separately budgeted project key";
    readonly authMode: "api-key";
    readonly scopes: readonly [];
    readonly approvalClass: "read";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["maps"];
}, {
    readonly id: "zoom";
    readonly title: "Zoom";
    readonly tagline: "Create and manage Zoom meetings through a separate Zoom connection";
    readonly authMode: "separate-oauth";
    readonly scopes: readonly [];
    readonly approvalClass: "high-risk";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["zoom"];
}, {
    readonly id: "backup-export";
    readonly title: "Google data export";
    readonly tagline: "Run encrypted export and recovery workflows outside the agent runtime";
    readonly authMode: "octogee-workflow";
    readonly scopes: readonly [];
    readonly approvalClass: "destructive";
    readonly availability: "catalogued";
    readonly commandFamilies: readonly ["backup", "batch"];
}];
export type GoogleCatalogCapabilityId = (typeof GOOGLE_CAPABILITY_CATALOG)[number]["id"];
export declare const GOOGLE_ACTIVE_PERSONAL_CAPABILITIES: readonly Extract<(typeof GOOGLE_CAPABILITY_CATALOG)[number], {
    availability: "active";
    authMode: "user-oauth";
}>[];
export declare const OCTOGEE_CONTROLLED_GOG_COMMAND_FAMILIES: readonly [{
    readonly id: "credential-lifecycle";
    readonly commandFamilies: readonly ["auth", "login", "logout", "config", "status"];
    readonly reason: "Octogee owns OAuth clients, refresh tokens, service credentials and safety controls.";
}, {
    readonly id: "generic-api";
    readonly commandFamilies: readonly ["api"];
    readonly reason: "Every provider operation must have a reviewed typed contract, approval class and safe preview.";
}, {
    readonly id: "local-runtime";
    readonly commandFamilies: readonly ["completion", "schema", "time", "open", "version", "update"];
    readonly reason: "These are local CLI behaviors, not connected-service capabilities.";
}];
export declare function googleCapabilityDefinition(id: string): GoogleCapabilityDefinition | undefined;
