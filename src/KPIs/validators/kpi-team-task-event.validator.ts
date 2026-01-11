// ============================================================================
// Path: src/KPIs/validators/kpi-team-task-event.validator.ts
// ============================================================================

import { KpiBaseValidator, type ValidatorResult } from './kpi-base.validator';
import type { KpiTeamTaskEventDto } from '../dtos/kpi-team-task-event.dto';

export class KpiTeamTaskEventValidator extends KpiBaseValidator {
  public constructor() {
    super();
  }

  public parse(payload: unknown): ValidatorResult<KpiTeamTaskEventDto> {
    const errors: string[] = [];

    if (!payload || typeof payload !== 'object') {
      return { ok: false, errors: ['Payload must be a JSON object.'] };
    }

    const p = payload as Record<string, unknown>;

    this.pushError(errors, this.isObjectIdString(p.orgId), 'orgId must be a valid ObjectId string.');
    this.pushError(errors, !p.branchId || this.isObjectIdString(p.branchId), 'branchId must be a valid ObjectId string.');
    this.pushError(errors, !p.regionId || this.isObjectIdString(p.regionId), 'regionId must be a valid ObjectId string.');

    const okScope = p.assigneeScope === 'member' || p.assigneeScope === 'team';
    this.pushError(errors, okScope, 'assigneeScope must be member|team.');

    this.pushError(errors, !p.teamId || this.isObjectIdString(p.teamId), 'teamId must be a valid ObjectId string.');
    this.pushError(errors, !p.memberId || this.isObjectIdString(p.memberId), 'memberId must be a valid ObjectId string.');
    this.pushError(errors, !p.propertyId || this.isObjectIdString(p.propertyId), 'propertyId must be a valid ObjectId string.');

    this.pushError(errors, this.isObjectIdString(p.taskId), 'taskId must be a valid ObjectId string.');
    this.pushError(errors, this.isObjectIdString(p.eventId), 'eventId must be a valid ObjectId string.');

    const okEvent =
      p.eventType === 'assigned' ||
      p.eventType === 'status_changed' ||
      p.eventType === 'evidence_added' ||
      p.eventType === 'completed' ||
      p.eventType === 'reopened' ||
      p.eventType === 'cancelled';

    this.pushError(errors, okEvent, 'eventType invalid.');

    this.pushError(errors, this.isNonEmptyString(p.category), 'category must be provided.');
    this.pushError(errors, this.isNonEmptyString(p.status), 'status must be provided.');

    this.pushError(errors, this.isIsoDateString(p.occurredAtISO), 'occurredAtISO must be a valid ISO date string.');
    this.pushError(errors, !p.note || this.isNonEmptyString(p.note), 'note must be a string if provided.');

    // Context rules
    const scope = String(p.assigneeScope);
    if (scope === 'member') {
      this.pushError(errors, Boolean(p.memberId), 'memberId is required when assigneeScope=member.');
    }
    if (scope === 'team') {
      this.pushError(errors, Boolean(p.teamId), 'teamId is required when assigneeScope=team.');
    }

    if (errors.length > 0) return { ok: false, errors };

    const dto: KpiTeamTaskEventDto = {
      orgId: String(p.orgId),
      assigneeScope: p.assigneeScope as KpiTeamTaskEventDto['assigneeScope'],
      taskId: String(p.taskId),
      eventId: String(p.eventId),
      eventType: p.eventType as KpiTeamTaskEventDto['eventType'],
      status: String(p.status) as KpiTeamTaskEventDto['status'],
      category: String(p.category) as KpiTeamTaskEventDto['category'],
      occurredAtISO: String(p.occurredAtISO),
    };

    if (p.branchId) dto.branchId = String(p.branchId);
    if (p.regionId) dto.regionId = String(p.regionId);
    if (p.teamId) dto.teamId = String(p.teamId);
    if (p.memberId) dto.memberId = String(p.memberId);
    if (p.propertyId) dto.propertyId = String(p.propertyId);
    if (p.priority) dto.priority = String(p.priority) as KpiTeamTaskEventDto['priority'];
    if (p.note) dto.note = String(p.note);

    return { ok: true, value: dto };
  }
}
