/**
 * NuCrew Data Types
 * 
 * Shared type definitions for all NuCrew data models.
 * Used by dashboard, hooks, agents, and Cloud Functions.
 */

// Common types
export type {
  Activity,
  ActivityType,
  Address,
  BaseDocument,
  CrewMember,
  LeadSource,
} from './common';

// Lead types
export type {
  Lead,
  LeadStatus,
  LeadFilters,
} from './lead';

// Customer types
export type {
  Customer,
  CustomerStatus,
  CustomerFilters,
} from './customer';

// Job types
export type {
  Job,
  JobStatus,
  JobFilters,
} from './job';

// Invoice types
export type {
  Invoice,
  InvoiceStatus,
  InvoiceFilters,
  InvoiceLineItem,
} from './invoice';

// Task types
export type {
  Task,
  TaskStatus,
  TaskRelation,
  TaskFilters,
  Priority,
} from './task';
