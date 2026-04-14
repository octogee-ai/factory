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
