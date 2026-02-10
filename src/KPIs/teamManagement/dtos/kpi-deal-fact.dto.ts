// ============================================================================
// Path: src/KPIs/dtos/kpi-deal-fact.dto.ts
// ============================================================================

export type KpiDealType = 'sale' | 'rent';
export type KpiDealStatus = 'won' | 'lost' | 'cancelled';

export interface KpiDealFactDto {
  orgId: string;
  branchId?: string;
  regionId?: string;

  teamId?: string;
  agentId: string;
  propertyId?: string;

  dealType: KpiDealType;
  status: KpiDealStatus;

  propertyType?: string;

  dealValue: number;
  commissionAmount: number;
  currencyCode: string;

  closedAtISO: string;
}
