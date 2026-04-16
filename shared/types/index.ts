/**
 * Shared type definitions used across app, workspace-api, functions, and scripts.
 */

// Project types
export type {
  Project,
  ProjectVisibility,
  ProjectStatus,
  ProjectProvisioningState,
  ProjectCanvasMode,
  ProjectType,
} from './project';

// Agent types
export type {
  Agent,
  AgentMattermost,
} from './agent';

// Workspace types
export type {
  Workspace,
  WorkspaceVisibility,
  WorkspaceMattermost,
  WorkspaceGitea,
} from './workspace';

// Workspace vibe taxonomy + per-type typing phrases (coach personalization).
export type { WorkspaceType } from './workspaceType';
export {
  WORKSPACE_TYPES,
  DEFAULT_WORKSPACE_TYPE,
  DEFAULT_TYPING_PHRASES_BY_TYPE,
  isWorkspaceType,
} from './workspaceType';

// Channel types (Firestore pointer to MM channel)
export type {
  Channel,
  ChannelKind,
  ChannelMattermost,
} from './channel';

// Member types (workspace + project membership subcollection)
export type {
  Member,
  MemberRole,
} from './member';

// Notification types
export type {
  NotificationCategory,
  DeliveryChannel,
  NotificationAction,
  InboxDocument,
} from './notifications';

