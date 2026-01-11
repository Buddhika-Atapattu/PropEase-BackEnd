// ============================================================================
// Path: src/KPIs/dtos/kpi-maintenance-event.dto.ts
// ============================================================================

export type KpiMaintenanceEventType = 'opened' | 'in_progress' | 'completed' | 'closed';

export interface KpiMaintenanceEventDto {
  orgId: string;
  branchId?: string;
  regionId?: string;

  teamId?: string;
  memberId: string;
  propertyId?: string;

  ticketId: string;

  eventType: KpiMaintenanceEventType;
  slaMinutes: number;

  priority?: 'low' | 'medium' | 'high' | 'urgent';

  occurredAtISO: string;
}
