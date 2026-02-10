// ============================================================================
// Path: src/KPIs/dtos/kpi-team-task-event.dto.ts
// ============================================================================
// Task Event Fact (Append-only)
// ----------------------------------------------------------------------------
// Purpose:
//   Track lifecycle events for deep analytics:
//     - assigned
//     - status_changed
//     - completed
//     - reopened
//     - cancelled
//
// Append-only: each event is immutable.
// ============================================================================

import type { KpiTaskStatus, KpiTaskCategory, KpiTaskPriority, KpiAssigneeScope } from './kpi-team-task-fact.dto';

export type KpiTaskEventType =
  | 'assigned'
  | 'status_changed'
  | 'evidence_added'
  | 'completed'
  | 'reopened'
  | 'cancelled';

export interface KpiTeamTaskEventDto {
  orgId: string;
  branchId?: string;
  regionId?: string;

  assigneeScope: KpiAssigneeScope;
  teamId?: string;
  memberId?: string;

  propertyId?: string;

  taskId: string;
  eventId: string;

  eventType: KpiTaskEventType;
  status: KpiTaskStatus;

  category: KpiTaskCategory;
  priority?: KpiTaskPriority | undefined;

  occurredAtISO: string;

  // Optional note for audit (only set if exists)
  note?: string;
}
