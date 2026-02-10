// ============================================================================
// Path: src/KPIs/validators/kpi-team-task-evidence.validator.ts
// ============================================================================

import { KpiBaseValidator, type ValidatorResult } from './kpi-base.validator';
import type { KpiTeamTaskEvidenceDto } from '../dtos/kpi-team-task-evidence.dto';

export class KpiTeamTaskEvidenceValidator extends KpiBaseValidator {
  public constructor() {
    super();
  }

  public parse(payload: unknown): ValidatorResult<KpiTeamTaskEvidenceDto> {
    const errors: string[] = [];

    if (!payload || typeof payload !== 'object') {
      return { ok: false, errors: ['Payload must be a JSON object.'] };
    }

    const p = payload as Record<string, unknown>;

    this.pushError(errors, this.isObjectIdString(p.orgId), 'orgId must be a valid ObjectId string.');
    this.pushError(errors, !p.branchId || this.isObjectIdString(p.branchId), 'branchId must be a valid ObjectId string.');
    this.pushError(errors, !p.regionId || this.isObjectIdString(p.regionId), 'regionId must be a valid ObjectId string.');

    this.pushError(errors, !p.teamId || this.isObjectIdString(p.teamId), 'teamId must be a valid ObjectId string.');
    this.pushError(errors, !p.memberId || this.isObjectIdString(p.memberId), 'memberId must be a valid ObjectId string.');
    this.pushError(errors, !p.propertyId || this.isObjectIdString(p.propertyId), 'propertyId must be a valid ObjectId string.');

    this.pushError(errors, this.isObjectIdString(p.taskId), 'taskId must be a valid ObjectId string.');
    this.pushError(errors, this.isObjectIdString(p.evidenceId), 'evidenceId must be a valid ObjectId string.');

    const okType =
      p.evidenceType === 'image' ||
      p.evidenceType === 'pdf' ||
      p.evidenceType === 'doc' ||
      p.evidenceType === 'link' ||
      p.evidenceType === 'text' ||
      p.evidenceType === 'other';

    this.pushError(errors, okType, 'evidenceType must be image|pdf|doc|link|text|other.');
    this.pushError(errors, this.isNonEmptyString(p.ref), 'ref must be a non-empty string.');
    this.pushError(errors, this.isIsoDateString(p.submittedAtISO), 'submittedAtISO must be a valid ISO date string.');

    // At least one assignee context must exist (member or team)
    const hasContext = Boolean(p.memberId) || Boolean(p.teamId);
    this.pushError(errors, hasContext, 'Either memberId or teamId must be provided.');

    if (errors.length > 0) return { ok: false, errors };

    const dto: KpiTeamTaskEvidenceDto = {
      orgId: String(p.orgId),
      taskId: String(p.taskId),
      evidenceId: String(p.evidenceId),
      evidenceType: p.evidenceType as KpiTeamTaskEvidenceDto['evidenceType'],
      ref: String(p.ref),
      submittedAtISO: String(p.submittedAtISO),
    };

    if (p.branchId) dto.branchId = String(p.branchId);
    if (p.regionId) dto.regionId = String(p.regionId);
    if (p.teamId) dto.teamId = String(p.teamId);
    if (p.memberId) dto.memberId = String(p.memberId);
    if (p.propertyId) dto.propertyId = String(p.propertyId);

    return { ok: true, value: dto };
  }
}
