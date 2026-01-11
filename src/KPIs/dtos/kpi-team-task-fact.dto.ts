// ============================================================================
// Path: src/KPIs/dtos/kpi-team-task-fact.dto.ts
// ============================================================================
// Team Task Projection Fact (Upsert)
// ----------------------------------------------------------------------------
// Purpose:
//   One document per taskId that represents the CURRENT state.
//   Used for:
//     - fast KPIs (completion rate, overdue, WIP)
//     - deadline runner scanning (warnings / overdue alerts)
//
// Timing model:
//   assignedAtISO      -> when task was assigned
//   expectedEndAtISO   -> promised end time (deadline)
//   completedAtISO     -> actual completion time (optional)
//
// Office staff support:
//   taskCategory allows tracking work not related to sales/maintenance.
// ============================================================================

export type KpiTaskStatus =
  | 'draft'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'reopened';

export type KpiTaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type KpiTaskCategory =
  | 'sales'
  | 'maintenance'
  | 'properties'
  | 'office_ops'
  | 'it_dev'
  | 'admin'
  | 'finance'
  | 'marketing'
  | 'support'
  | 'other';

export type KpiAssigneeScope = 'member' | 'team';

export interface KpiTeamTaskFactDto {
  // Org structure
  orgId: string;
  branchId?: string;
  regionId?: string;

  // Assignment scope
  assigneeScope: KpiAssigneeScope;
  teamId?: string;     // required when assigneeScope = 'team' (or when member belongs to team)
  memberId?: string;   // required when assigneeScope = 'member'

  // Optional link to property context
  propertyId?: string;

  // Identity
  taskId: string;

  // Classification
  category: KpiTaskCategory;
  status: KpiTaskStatus;
  priority?: KpiTaskPriority;

  // Timing (IMPORTANT)
  assignedAtISO: string;
  expectedEndAtISO: string;
  completedAtISO?: string;
  startedAtISO?: string;

  // Description
  title: string;
  description?: string;

  // Evidence projection (runner + KPIs can use this quickly)
  evidenceCount?: number;
  hasEvidence?: boolean;

  // Runner anti-spam fields (optional, only set by runner)
  lastWarningAtISO?: string;
  lastWarningLevel?: '75' | '90' | 'overdue';
}
