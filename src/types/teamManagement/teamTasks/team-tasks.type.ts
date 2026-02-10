// Path: src/types/team-tasks.type.ts
import { Types } from "mongoose";

import type {
  Address,
  GeoLocation,
  ISODateString,
  TaskAuditMeta,
  TaskBlockedWindow,
  TaskCompletionConfirmation,
  TaskPriority,
  TaskRuntimeMetrics,
  TaskStatus,
  TaskTiming,
  TeamDomain,
} from "../../../models/teamManagement/teamManagement.model";

import type {
  TaskDeadlinePolicy,
  TaskEvidence,
  TaskUrgencyLevel,
} from "../../../models/teamManagement/teamTasks/teamTask.model";

// ─────────────────────────────────────────────────────────────────────────────
// Load mode + pagination + sorting
// ─────────────────────────────────────────────────────────────────────────────

export type TeamTaskLoadMode = "minimal" | "advanced";

export interface PaginationInput {
  limit: number;
  pageIndex: number;
}

export interface TeamTaskSortInput {
  sortBy: "createdAt" | "updatedAt" | "priority" | "status" | "dueAt";
  sortDir: "asc" | "desc";
}

export type LeanUserLite = {
  _id: Types.ObjectId;
  username?: string;
  role?: string;
  email?: string;
};

// ✅ Lean object shape (NOT Document)
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

  plannedStartAt?: string; // stored as string (often "" in schema)
  plannedEndAt?: string;

  timing: TaskTiming;

  deadlinePolicy?: TaskDeadlinePolicy;

  metrics?: TaskRuntimeMetrics;

  blockedWindows?: TaskBlockedWindow[];
  assigneeHistory?: unknown[]; // keep unknown unless you export the entry type publicly
  completionConfirmation?: TaskCompletionConfirmation;

  evidence?: TaskEvidence[];

  notes?: string;
  labels?: string[];

  audit?: TaskAuditMeta;

  createdAt: string;
  updatedAt: string;

  // advanced enrich (aggregate only)
  assignedMemberUsernames?: string[];
  captainUsername?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Filters + key values
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamTaskFilterInput {
  teamCode?: string;
  teamMongoId?: string;

  domain?: TeamDomain;

  status?: TaskStatus;
  priority?: TaskPriority;

  country?: string;
  city?: string;

  // ✅ DEADLINE POLICY due range
  dueFrom?: ISODateString;
  dueTo?: ISODateString;

  createdFrom?: ISODateString;
  createdTo?: ISODateString;

  q?: string;

  assignedMemberId?: string;
  captainUserId?: string;

  label?: string;
}

export interface TeamTaskKeyValues {
  domains: ReadonlyArray<TeamDomain>;
  statuses: ReadonlyArray<TaskStatus>;
  priorities: ReadonlyArray<TaskPriority>;
  distinctLabels?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Create / Update inputs (aligned to model)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateTeamTaskInput {
  id: string;

  teamCode: string;
  teamMongoId: string;

  domain: TeamDomain;

  name: string;
  description?: string;

  location?: GeoLocation;
  address?: Address;

  assignedMembers?: string[];
  assignedTaskCaptain?: string;

  workItemMongoIds?: string[]; // optional cache
  workItemCount?: number;      // optional cache override

  status?: TaskStatus;
  priority?: TaskPriority;

  plannedStartAt?: ISODateString;
  plannedEndAt?: ISODateString;

  timing?: TaskTiming;

  deadlinePolicy?: {
    dueAt?: ISODateString | null;
    breachAt?: ISODateString | null;
    urgency?: TaskUrgencyLevel | null;
  };

  metrics?: TaskRuntimeMetrics;

  blockedWindows?: TaskBlockedWindow[];
  completionConfirmation?: TaskCompletionConfirmation;

  evidence?: TaskEvidence[];

  notes?: string;
  labels?: string[];

  audit?: TaskAuditMeta;
}

export interface UpdateTeamTaskInput {
  name?: string;
  description?: string;

  location?: GeoLocation | null;
  address?: Address | null;

  assignedMembers?: string[] | null;
  assignedTaskCaptain?: string | null;

  workItemMongoIds?: string[] | null;
  workItemCount?: number | null;

  status?: TaskStatus;
  domain?: TeamDomain;
  priority?: TaskPriority;

  plannedStartAt?: ISODateString | null;
  plannedEndAt?: ISODateString | null;

  timing?: TaskTiming | null;

  deadlinePolicy?: {
    dueAt?: ISODateString | null;
    breachAt?: ISODateString | null;
    urgency?: TaskUrgencyLevel | null;
  } | null;

  metrics?: TaskRuntimeMetrics | null;

  blockedWindows?: TaskBlockedWindow[] | null;
  completionConfirmation?: TaskCompletionConfirmation | null;

  notes?: string | null;
  labels?: string[] | null;

  audit?: TaskAuditMeta | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DTO
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamTaskDto {
  mongoId: string;

  id: string;

  teamCode: string;
  teamMongoId: string;

  domain: TeamDomain;

  name: string;
  description: string;

  location?: GeoLocation;
  address?: Address;

  assignedMembers: string[];
  assignedTaskCaptain?: string;

  workItemMongoIds?: string[];
  workItemCount: number;

  status: TaskStatus;
  priority: TaskPriority;

  plannedStartAt?: ISODateString;
  plannedEndAt?: ISODateString;

  timing: TaskTiming;

  deadlinePolicy?: {
    dueAt?: ISODateString | null;
    breachAt?: ISODateString | null;
    urgency?: TaskUrgencyLevel | null;
  };

  metrics?: TaskRuntimeMetrics;

  blockedWindows?: TaskBlockedWindow[];
  completionConfirmation?: TaskCompletionConfirmation;

  evidence?: TaskEvidence[];

  notes?: string;
  labels: string[];

  audit?: TaskAuditMeta;

  createdAt: ISODateString;
  updatedAt: ISODateString;

  assignedMemberUsernames?: string[];
  captainUsername?: string;
}

export interface ListResult<T> {
  items: T[];
  other: { total: number };
}

export interface TaskUserLiteDto {
  mongoId: string;
  username: string;
  role?: string;
  email?: string;
}

export interface TaskUsersResult {
  members: TaskUserLiteDto[];
  captain: TaskUserLiteDto | null;
}
