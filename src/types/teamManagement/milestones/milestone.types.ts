// Path: src/types/teamManagement/milestones/milestone.types.ts
// ============================================================================
// Milestone Types (TeamWork Planning Object)
// ----------------------------------------------------------------------------
// ✅ PURPOSE
// - Milestone is a "plan item" for a member under a WorkItem.
// - MemberActivity is the "timeline log" that can reference milestoneId.
// - This keeps heavy activity logs out of the plan layer.
// ============================================================================

import { Types } from "mongoose";

// ----------------------------------------------------------------------------
// Enums
// ----------------------------------------------------------------------------
export const MILESTONE_STATUS = [
  "planned",
  "active",
  "done",
  "missed",
  "cancelled",
] as const;

export type MilestoneStatus = (typeof MILESTONE_STATUS)[number];

export const MILESTONE_PRIORITY = ["low", "medium", "high", "urgent"] as const;
export type MilestonePriority = (typeof MILESTONE_PRIORITY)[number];

// ----------------------------------------------------------------------------
// Evidence packet (same field contract style you already use)
// ----------------------------------------------------------------------------
export interface MilestoneEvidence {
  label: string;
  relPath: string;
  url: string;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  uploadedAt: Date;
}

// ----------------------------------------------------------------------------
// Milestone DB shape (server-side)
// ----------------------------------------------------------------------------
export interface MilestoneDto {
  // Relations
  _id: Types.ObjectId;
  workItemId: Types.ObjectId;
  teamId: Types.ObjectId;

  // Owner (member who planned this)
  userId: Types.ObjectId;

  // Audit
  createdByUserId: Types.ObjectId;
  updatedByUserId?: Types.ObjectId;

  requestId?: string;
  source?: "rest" | "ws" | "system";

  // Planning fields (calendar style)
  title: string;
  notes?: string;

  startAt: Date;
  endAt: Date;
  allDay: boolean;
  timezone?: string;

  status: MilestoneStatus;
  priority: MilestonePriority;

  // Optional progress target impact
  // Example: milestone completion sets progressAfter=60
  progressTarget?: number; // 0..100

  // Optional tags (lightweight)
  tags?: string[];

  // Optional evidence (if you allow milestone-level evidence)
  evidence?: MilestoneEvidence[];

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
