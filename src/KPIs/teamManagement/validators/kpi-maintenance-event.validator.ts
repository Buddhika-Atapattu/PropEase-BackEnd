// ============================================================================
// Path: src/KPIs/validators/kpi-maintenance-event.validator.ts
// ============================================================================

import { KpiBaseValidator, type ValidatorResult } from './kpi-base.validator';
import type { KpiMaintenanceEventDto } from '../dtos/kpi-maintenance-event.dto';

export class KpiMaintenanceEventValidator extends KpiBaseValidator {
  public constructor() {
    super();
  }

  public parse(payload: unknown): ValidatorResult<KpiMaintenanceEventDto> {
    const errors: string[] = [];

    if (!payload || typeof payload !== 'object') {
      return { ok: false, errors: ['Payload must be a JSON object.'] };
    }

    const p = payload as Record<string, unknown>;

    this.pushError(errors, this.isObjectIdString(p.orgId), 'orgId must be a valid ObjectId string.');
    this.pushError(errors, !p.branchId || this.isObjectIdString(p.branchId), 'branchId must be a valid ObjectId string.');
    this.pushError(errors, !p.regionId || this.isObjectIdString(p.regionId), 'regionId must be a valid ObjectId string.');

    this.pushError(errors, !p.teamId || this.isObjectIdString(p.teamId), 'teamId must be a valid ObjectId string.');
    this.pushError(errors, this.isObjectIdString(p.memberId), 'memberId must be a valid ObjectId string.');
    this.pushError(errors, !p.propertyId || this.isObjectIdString(p.propertyId), 'propertyId must be a valid ObjectId string.');

    this.pushError(errors, this.isObjectIdString(p.ticketId), 'ticketId must be a valid ObjectId string.');

    const okType =
      p.eventType === 'opened' ||
      p.eventType === 'in_progress' ||
      p.eventType === 'completed' ||
      p.eventType === 'closed';

    this.pushError(errors, okType, 'eventType must be "opened" | "in_progress" | "completed" | "closed".');

    this.pushError(errors, this.isFiniteNumber(p.slaMinutes) && p.slaMinutes > 0, 'slaMinutes must be a number > 0.');
    this.pushError(errors, !p.priority || (p.priority === 'low' || p.priority === 'medium' || p.priority === 'high' || p.priority === 'urgent'), 'priority must be low|medium|high|urgent if provided.');

    this.pushError(errors, this.isIsoDateString(p.occurredAtISO), 'occurredAtISO must be a valid ISO date string.');

    if (errors.length > 0) return { ok: false, errors };

    const dto: KpiMaintenanceEventDto = {
      orgId: String(p.orgId),
      memberId: String(p.memberId),
      ticketId: String(p.ticketId),
      eventType: p.eventType as 'opened' | 'in_progress' | 'completed' | 'closed',
      slaMinutes: Number(p.slaMinutes),
      occurredAtISO: String(p.occurredAtISO),
    };

    if (p.branchId) dto.branchId = String(p.branchId);
    if (p.regionId) dto.regionId = String(p.regionId);
    if (p.teamId) dto.teamId = String(p.teamId);
    if (p.propertyId) dto.propertyId = String(p.propertyId);
    if (p.priority) dto.priority = p.priority as 'low' | 'medium' | 'high' | 'urgent';

    return { ok: true, value: dto };
  }
}
