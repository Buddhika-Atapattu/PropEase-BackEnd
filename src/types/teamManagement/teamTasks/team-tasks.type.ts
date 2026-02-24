// Path: src/models/teamManagement/teamTask.types.ts
// =============================================================================
// Team Task — Types & Contracts (Standalone)
// -----------------------------------------------------------------------------
// ✅ Purpose:
// - Own ALL task-domain enums + structures (status, priority, timing, metrics...)
// - Keep TeamTask model independent from TeamManagement model internals
// - Reuse TEAM_DOMAINS from teamManagement.types.ts (single source of truth)
// =============================================================================

import type { Types } from "mongoose";
import type { User } from "../../../models/user.model";
import type { Address, GeoLocation, ISODateString } from "../../common"; // already stable primitive there
import type { FileMetaBase, TeamDomain, } from "../teamMain/teamManagement.types";

// ─────────────────────────────────────────────
// Deadline policy (formerly SLA)
// ─────────────────────────────────────────────

/**
 * Urgency level = impact of missing deadline (not execution order).
 */
export type TaskUrgencyLevel = "low" | "medium" | "high" | "critical";

/**
 * Deadline policy = expectation rules.
 * - dueAt:     expected completion deadline
 * - breachAt:  hard breach threshold (optional)
 * - urgency:   impact level if missed
 */
export interface TaskDeadlinePolicy {
  dueAt?: string | null;
  breachAt?: string | null;
  urgency?: TaskUrgencyLevel | null;
}

// ─────────────────────────────────────────────
// Task enums (missing from TeamManagement v2)
// ─────────────────────────────────────────────
export const TASK_STATUSES = [
  "draft",
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
  "completed_pending_confirmation",
] as const;

export type TaskStatus = ( typeof TASK_STATUSES )[ number ];

export const TASK_PRIORITIES = [ "low", "medium", "high", "critical" ] as const;
export type TaskPriority = ( typeof TASK_PRIORITIES )[ number ];

// ─────────────────────────────────────────────
// Task timing (anchors for KPI / lifecycle)
// ─────────────────────────────────────────────
export interface TaskTiming {
  createdAt?: ISODateString | null;
  updatedAt?: ISODateString | null;

  firstResponseAt?: ISODateString | null;
  startedAt?: ISODateString | null;

  lastBlockedAt?: ISODateString | null;

  completedAt?: ISODateString | null;
  confirmedAt?: ISODateString | null;

  cancelledAt?: ISODateString | null;
}

// ─────────────────────────────────────────────
// Task runtime metrics (KPI-ready)
// ─────────────────────────────────────────────
export interface TaskRuntimeMetrics {
  effortPoints?: number;
  complexity?: number;

  estimatedMinutes?: number;
  actualMinutes?: number;

  reopenedCount?: number;
  rejectedCount?: number;

  customerSatisfactionScore?: number;
  supervisorQualityScore?: number;
}

// ─────────────────────────────────────────────
// Audit meta (security + analytics)
// ─────────────────────────────────────────────
export type WorkSource = "ui" | "system" | "automation" | "import";

export interface TaskAuditMeta {
  source?: WorkSource;

  requestId?: string;
  deviceId?: string;

  createdByUserId?: Types.ObjectId;
  createdByUsername?: string;

  lastUpdatedByUserId?: Types.ObjectId;
  lastUpdatedByUsername?: string;
}

// ─────────────────────────────────────────────
// Blocked window (explain why task paused)
// ─────────────────────────────────────────────
export interface TaskBlockedWindow {
  from: ISODateString;
  to?: ISODateString | null;

  reason?: string | null;

  setByUserId?: Types.ObjectId;
  setByUsername?: string;
}

// ─────────────────────────────────────────────
// Assignee history (who, when, why)
// ─────────────────────────────────────────────
export interface TaskAssigneeHistoryEntry {
  userId: Types.ObjectId;
  username: string;

  from: ISODateString;
  to?: ISODateString | null;

  changedByUserId?: Types.ObjectId;
  changedByUsername?: string;

  reason?: string | null;
}

// ─────────────────────────────────────────────
// Completion confirmation (align to your FE concept)
// ─────────────────────────────────────────────
export type CompletionSignerRole = "customer" | "supervisor";

export type CompletionConfirmationStatus =
  | "not_required"
  | "pending"
  | "rejected"
  | "confirmed";

export interface TaskCompletionSignature {
  role: CompletionSignerRole;

  signerUserId?: Types.ObjectId;
  signerUsername?: string;
  signerName?: string;

  signatureFile?: FileMetaBase;
  signatureUrl?: string;
  signatureStorageKey?: string;

  signedAt?: ISODateString;
}

export interface TaskCompletionConfirmation {
  status: CompletionConfirmationStatus;

  requiredRoles?: CompletionSignerRole[];
  signatures?: TaskCompletionSignature[];

  confirmedAt?: ISODateString;
  confirmedByUserId?: Types.ObjectId;
  confirmedByUsername?: string;

  rejectedAt?: ISODateString;
  rejectedByUserId?: Types.ObjectId;
  rejectedByUsername?: string;

  rejectReason?: string;
}

// ─────────────────────────────────────────────
// Evidence (task attachments / proofs)
// ─────────────────────────────────────────────
export interface TaskEvidence {
  name: string;

  file?: FileMetaBase;

  url?: string;
  storageKey?: string;

  uploadedById?: Types.ObjectId;
  uploadedByName?: User[ "username" ];
  uploadedAt?: ISODateString;
}

// ─────────────────────────────────────────────
// Service types
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Shared “ListResult” wrapper (your typical pattern)
// ─────────────────────────────────────────────
export interface ListResult<T> {
  items: T[];
  other: {
    total: number;
  };
}

// ─────────────────────────────────────────────
// Pagination input (service-level)
// ─────────────────────────────────────────────
export interface PaginationInput {
  page: number;     // 1-based
  limit: number;    // page size
  skip?: number;     // optional override (computed if not given)
}

// ─────────────────────────────────────────────
// Sorting
// -----------------------------------------------------------------------------
// Keep explicit keys to avoid “stringly-typed” sorting
// ─────────────────────────────────────────────
export type TeamTaskSortKey =
  | "createdAt"
  | "updatedAt"
  | "name"
  | "status"
  | "priority"
  | "dueAt"
  | "workItemCount";

export type SortDirection = "asc" | "desc";

export interface TeamTaskSortInput {
  key: TeamTaskSortKey;
  dir: SortDirection;
}

// ─────────────────────────────────────────────
// Load modes (service-level)
// -----------------------------------------------------------------------------
// minimal: list cards
// full: detail view
// users: detail + resolved users (captain + members)
// advanced: future-proof (e.g., metrics, evidence heavy)
// ─────────────────────────────────────────────
export type TeamTaskLoadMode = "minimal" | "full" | "users" | "advanced";
export const TEAM_TASK_LOAD_MODES: TeamTaskLoadMode[] = [
  "minimal",
  "full",
  "users",
  "advanced",
];

// ─────────────────────────────────────────────
// Filters (service-level)
// -----------------------------------------------------------------------------
// NOTE: Keep date filters string-based (ISO) to avoid timezone surprises.
// ─────────────────────────────────────────────
export interface TeamTaskFilterInput {
  teamCode?: string;
  teamMongoId?: Types.ObjectId;

  domain?: TeamDomain;

  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority | TaskPriority[];

  assignedMemberId?: Types.ObjectId;
  assignedCaptainId?: Types.ObjectId;

  label?: string;

  text?: string; // name/description/labels search

  createdFrom?: ISODateString;
  createdTo?: ISODateString;

  updatedFrom?: ISODateString;
  updatedTo?: ISODateString;

  dueFrom?: ISODateString; // deadlinePolicy.dueAt range
  dueTo?: ISODateString;

  hasEvidence?: boolean;
  isActiveOnly?: boolean; // optional feature if you introduce soft states later
}

// ─────────────────────────────────────────────
// Lean types for service (Mongoose lean + strict-friendly)
// -----------------------------------------------------------------------------
// LeanTeamTask: what you get from .lean() on TeamTaskModel
// IMPORTANT: include _id because service often needs it.
// ─────────────────────────────────────────────
export type LeanTeamTask = {
  _id: Types.ObjectId;

  id: string;

  teamCode: string;
  teamMongoId: Types.ObjectId;
  domain: TeamDomain;

  name: string;
  description: string;

  location?: GeoLocation;

  address?: Address;

  assignedMembers?: Types.ObjectId[];
  assignedTaskCaptain?: Types.ObjectId;

  workItemMongoIds?: Types.ObjectId[];
  workItemCount: number;

  status: TaskStatus;
  priority: TaskPriority;

  plannedStartAt?: string;
  plannedEndAt?: string;

  timing: TaskTiming;

  deadlinePolicy?: TaskDeadlinePolicy;

  metrics?: TaskRuntimeMetrics;

  blockedWindows?: TaskBlockedWindow[];
  assigneeHistory?: TaskAssigneeHistoryEntry[];

  completionConfirmation?: TaskCompletionConfirmation;

  evidence?: TaskEvidence[];

  notes?: string;
  labels?: string[];

  audit?: TaskAuditMeta;

  createdAt: ISODateString;
  updatedAt: ISODateString;
};

// ─────────────────────────────────────────────
// User-lite shapes used by "getTaskUsers"
// -----------------------------------------------------------------------------
// LeanUserLite: DB lookup result from UserModel.lean()
// TaskUserLiteDto: what you send to FE (safe fields only)
// ─────────────────────────────────────────────
export type LeanUserLite = {
  _id: Types.ObjectId;
  username: string;
  fullName?: string;
  email?: string;
  phone?: string;

  // Optional: if your User model has these fields
  role?: string;
  isActive?: boolean;

  // If your user has avatar/profile picture
  imageUrl?: string;
};

export interface TaskUserLiteDto {
  userId: string;       // stringify for FE
  username: string;

  fullName?: string;
  email?: string;
  phone?: string;

  role?: string;
  isActive?: boolean;

  imageUrl?: string;
}

// Result returned by service for task-user lookups
export interface TaskUsersResult {
  captain?: TaskUserLiteDto | null;
  members: TaskUserLiteDto[];
  other: {
    memberTotal: number;
  };
}

// ─────────────────────────────────────────────
// DTO returned to FE (what your WS also emits ideally)
// -----------------------------------------------------------------------------
// Keep DTO as string IDs (FE-friendly), but preserve important objects.
// ─────────────────────────────────────────────
export interface TeamTaskDto {
  taskMongoId: string;  // from _id
  id: string;

  teamCode: string;
  teamMongoId: string;
  domain: TeamDomain;

  name: string;
  description: string;

  location?: LeanTeamTask[ "location" ];
  address?: LeanTeamTask[ "address" ];

  assignedMembers?: string[];
  assignedTaskCaptain?: string;

  workItemMongoIds?: string[];
  workItemCount: number;

  status: TaskStatus;
  priority: TaskPriority;

  plannedStartAt?: string;
  plannedEndAt?: string;

  timing: TaskTiming;

  deadlinePolicy?: TaskDeadlinePolicy;

  metrics?: TaskRuntimeMetrics;

  blockedWindows?: TaskBlockedWindow[];
  assigneeHistory?: TaskAssigneeHistoryEntry[];

  completionConfirmation?: TaskCompletionConfirmation;

  evidence?: TaskEvidence[];

  notes?: string;
  labels?: string[];

  audit?: TaskAuditMeta;

  createdAt: ISODateString;
  updatedAt: ISODateString;
}

// ─────────────────────────────────────────────
// Create / Update inputs
// -----------------------------------------------------------------------------
// Create: enforce required essentials, keep everything else optional
// Update: all optional, service decides $set/$unset
// ─────────────────────────────────────────────
export interface CreateTeamTaskInput {
  id: string;

  teamCode: string;
  teamMongoId: Types.ObjectId;
  domain: TeamDomain;

  name: string;
  description: string;

  location?: GeoLocation;
  address?: Address;

  assignedMembers?: Types.ObjectId[];
  assignedTaskCaptain?: Types.ObjectId;

  /**
   * Optional cache:
   * - Useful for quickly listing member work items under this TeamTask.
   * - True relationship should still live in WorkItem.teamTaskMongoId (child -> parent).
   */
  workItemMongoIds?: Types.ObjectId[];
  workItemCount: number;

  status: TaskStatus;
  priority: TaskPriority;

  plannedStartAt?: string;
  plannedEndAt?: string;

  timing: TaskTiming;

  deadlinePolicy?: TaskDeadlinePolicy;

  metrics?: TaskRuntimeMetrics;

  blockedWindows?: TaskBlockedWindow[];
  assigneeHistory?: TaskAssigneeHistoryEntry[];

  completionConfirmation?: TaskCompletionConfirmation;

  evidence?: TaskEvidence[];

  notes?: string;
  labels?: string[];

  audit?: TaskAuditMeta;

  createdAt: string;
  updatedAt: string;
}

export interface UpdateTeamTaskInput {
  name?: string;
  description?: string;
  domain?: TeamDomain | null;

  location?: LeanTeamTask[ "location" ] | null;
  address?: LeanTeamTask[ "address" ] | null;

  assignedMembers?: Types.ObjectId[] | null;
  assignedTaskCaptain?: Types.ObjectId | null;

  plannedStartAt?: string | null;
  plannedEndAt?: string | null;

  status?: TaskStatus | null;
  priority?: TaskPriority | null;

  timing?: TaskTiming | null;

  deadlinePolicy?: TaskDeadlinePolicy | null;

  metrics?: TaskRuntimeMetrics | null;

  notes?: string | null;
  labels?: string[] | null;

  completionConfirmation?: TaskCompletionConfirmation | null;

  audit?: TaskAuditMeta | null;
}

// ─────────────────────────────────────────────
// Key-values payload for dropdowns/autocomplete
// -----------------------------------------------------------------------------
// Used for "key-values" endpoint: list minimal id+name
// ─────────────────────────────────────────────
export interface TeamTaskKeyValues {
  taskMongoId: string;
  id: string;
  name: string;
  status: TaskStatus;
  priority: TaskPriority;
  domain: TeamDomain;
  updatedAt: ISODateString;
}

export interface TeamTaskKeyValuesMetaDto {
  domains: ReadonlyArray<TeamDomain>;
  statuses: ReadonlyArray<TaskStatus>;
  priorities: ReadonlyArray<TaskPriority>;

  distinctLabels?: string[];
}