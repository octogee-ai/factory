/**
 * Shared type definitions used across app, workspace-api, functions, and scripts.
 */

// Project types
export type {
  Project,
  ProjectVisibility,
  ProjectStatus,
  ProjectProvisioningState,
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

// Vibe taxonomy + deterministic display names. Single source of truth for
// the workspace's MM team display_name, workspace/project channel display
// names, and the typing-phrase personalization list per vibe. See
// WORKSPACE-NAMING-CANONICAL-SPEC.
export type { WorkspaceVibe, WorkspaceChannelKind } from './display-names';
export {
  WORKSPACE_VIBE_PRESETS,
  DEFAULT_VIBE_NOUN,
  WORKSPACE_CHANNEL_DISPLAY_NAMES,
  TYPING_PHRASES_BY_VIBE,
  DEFAULT_TYPING_PHRASES,
  isWorkspaceVibe,
  titleCaseVibe,
  computeWorkspaceDisplayName,
  computeProjectChannelDisplayName,
} from './display-names';

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

// Fleet controller types (gateway state + restore jobs + shared constants).
// Spec: docs/GATEWAY-FLEET-CONTROLLER-SPEC.md
export type {
  GatewayStatus,
  GatewayState,
  GatewayLastError,
  RestoreJobState,
  RestoreJob,
  CustomerSnapshot,
} from './fleet-controller';
export {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GATEWAY_UNREACHABLE_AFTER_MS,
  JOB_TTL_MS,
  VERIFY_ACCOUNT_TIMEOUT_MS,
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  GATEWAYS_COLLECTION,
  RESTORE_JOBS_COLLECTION,
} from './fleet-controller';

