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

// Notification types
export type {
  NotificationCategory,
  DeliveryChannel,
  NotificationAction,
  InboxDocument,
} from './notifications';
