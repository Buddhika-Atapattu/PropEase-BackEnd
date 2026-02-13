// Path: src/types/teamManagement/memberActivities/memberActivities.types.ts
import { Types } from 'mongoose';


// ----------------------------------------------------------------------------
// Enums
// ----------------------------------------------------------------------------
export const MEMBER_ACTIVITY_TYPE = [
    "milestone", // planned target/milestone in calendar form
    "progress_update", // numeric progress updates
    "status_change", // assigned -> in_progress -> blocked -> completed
    "blocker_reported",
    "evidence_added",
    "note",
] as const;

export type MemberActivityType = ( typeof MEMBER_ACTIVITY_TYPE )[ number ];

export const MEMBER_ACTIVITY_STATUS = [
    "planned",
    "active",
    "done",
    "missed",
    "cancelled",
] as const;

export type MemberActivityStatus = ( typeof MEMBER_ACTIVITY_STATUS )[ number ];

// ----------------------------------------------------------------------------
// Evidence packet (same concept as WorkItemEvidence)
// ----------------------------------------------------------------------------
export interface MemberActivityEvidence {
    label: string;
    relPath: string;
    url: string;
    mimeType: string;
    originalName: string;
    sizeBytes: number;
    uploadedAt: Date | string;
}

// ----------------------------------------------------------------------------
// Blocker structure (kept simple but expandable)
// ----------------------------------------------------------------------------
export interface MemberActivityBlocker {
    title: string; // e.g. "Waiting for vendor confirmation"
    details?: string;
    severity: "low" | "medium" | "high";
    reportedAt: Date;
    resolvedAt?: Date;
}

// ----------------------------------------------------------------------------
// MemberActivity document shape
// ----------------------------------------------------------------------------
export interface MemberActivityDto {
    _id: Types.ObjectId;
    // Relations
    workItemId: Types.ObjectId;
    teamId: Types.ObjectId;
    userId: Types.ObjectId; // owner member (the planner)

    // Audit
    createdByUserId: Types.ObjectId; // usually same as userId; captain can also create on behalf
    requestId?: string;
    source?: "rest" | "ws" | "system";

    // Activity classification
    type: MemberActivityType;

    // Calendar event fields (Google Calendar style)
    title: string;
    notes?: string;

    startAt: Date;
    endAt: Date;
    allDay: boolean;
    timezone?: string;

    status: MemberActivityStatus;

    // Optional progress impact (used for progress_update / milestone done)
    progressBefore?: number; // 0..100
    progressAfter?: number; // 0..100

    // Optional milestone identifier (helps editing a specific milestone series)
    milestoneId?: string;

    // Evidence / blockers
    evidence?: MemberActivityEvidence[];
    blockers?: MemberActivityBlocker[];

    // Governance timestamps
    createdAt: Date;
    updatedAt: Date;
}
