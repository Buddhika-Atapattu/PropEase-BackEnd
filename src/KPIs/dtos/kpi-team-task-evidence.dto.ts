// ============================================================================
// Path: src/KPIs/dtos/kpi-team-task-evidence.dto.ts
// ============================================================================
// Task Evidence Fact (Append-only)
// ----------------------------------------------------------------------------
// Purpose:
//   Every evidence upload becomes a fact.
//   Enables KPIs like:
//     - evidence compliance %
//     - average evidence per completed task
//     - completed without evidence (risk KPI)
//
// This fact is append-only (do NOT upsert).
// ============================================================================

export type KpiEvidenceType = 'image' | 'pdf' | 'doc' | 'link' | 'text' | 'other';

export interface KpiTeamTaskEvidenceDto {
  orgId: string;
  branchId?: string;
  regionId?: string;

  // Assignee scope context
  teamId?: string;
  memberId?: string;

  propertyId?: string;

  // Identity
  taskId: string;
  evidenceId: string;

  // Evidence metadata
  evidenceType: KpiEvidenceType;
  // Keep it light: store file meta or external URL reference (not raw file bytes).
  ref: string; // file path, URL, or storage key

  submittedAtISO: string;
}
