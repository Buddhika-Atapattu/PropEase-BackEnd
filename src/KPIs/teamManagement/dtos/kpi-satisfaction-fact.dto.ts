// ============================================================================
// Path: src/KPIs/dtos/kpi-satisfaction-fact.dto.ts
// ============================================================================

export interface KpiSatisfactionFactDto {
  orgId: string;
  branchId?: string;
  regionId?: string;

  teamId?: string;
  agentId: string;

  rating: number; // 1..5
  comment?: string;

  submittedAtISO: string;
}
