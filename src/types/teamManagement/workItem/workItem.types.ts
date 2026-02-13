// Path: src/types/teamManagement/workItem/workItem.types.ts
import { Types } from 'mongoose';

// ----------------------------------------------------------------------------
// Enums (as const arrays for strict typing without TS enum runtime cost)
// ----------------------------------------------------------------------------
export const WORK_ITEM_STATUS = [
    "assigned",
    "in_progress",
    "blocked",
    "completed",
    "cancelled",
] as const;

export type WorkItemStatus = ( typeof WORK_ITEM_STATUS )[ number ];

export const WORK_ITEM_PRIORITY = [ "low", "medium", "high", "urgent" ] as const;
export type WorkItemPriority = ( typeof WORK_ITEM_PRIORITY )[ number ];

export const DEADLINE_POLICY = [ "soft", "hard" ] as const;
export type DeadlinePolicy = ( typeof DEADLINE_POLICY )[ number ];

// ----------------------------------------------------------------------------
// Evidence packet (keep minimal + stable; align fields with your FileUploader packet)
// ----------------------------------------------------------------------------
export interface WorkItemEvidence {
    label: string; // e.g. "Completion photo", "Invoice", "Menu confirmation"
    relPath: string; // e.g. "public/uploads/teamManagement/workItems/<...>/file.jpg"
    url: string; // FE-friendly URL (whatever your server serves)
    mimeType: string;
    originalName: string;
    sizeBytes: number;
    uploadedAt: Date;
}

// ----------------------------------------------------------------------------
// Cached per-member progress summary (tiny; fast for UI)
// ----------------------------------------------------------------------------
export interface WorkItemMemberProgress {
    userId: Types.ObjectId;
    progress: number; // 0..100
    status: WorkItemStatus;
    lastActivityAt: Date;
}

// ----------------------------------------------------------------------------
// WorkItem document shape (Lean-friendly)
// ----------------------------------------------------------------------------
// ✅ Dto should NOT extend Document
export interface WorkItemDto {
  _id: Types.ObjectId;

  workItemCode: string;
  teamId: string;

  taskId?: string;

  assignedByUserId: string;
  assignedToUserIds: string[];
  assignedAt: string;

  expectedStartAt?: string;
  expectedCompleteAt: string;
  deadlinePolicy: DeadlinePolicy;
  graceMinutes?: number;

  statusCurrent: WorkItemStatus;
  priority: WorkItemPriority;
  progressCurrent: number;
  lastActivityAt?: string;
  completedAt?: string;
  completedByUserId?: string;

  memberProgress?: Array<{
    userId: string;
    progress: number;
    status: WorkItemStatus;
    lastActivityAt: string;
  }>;

  completionEvidenceSummary?: Array<{
    label: string;
    relPath: string;
    url: string;
    mimeType: string;
    originalName: string;
    sizeBytes: number;
    uploadedAt: string;
  }>;

  createdByUserId: string;
  updatedByUserId?: string;

  createdAt: string;
  updatedAt: string;
}