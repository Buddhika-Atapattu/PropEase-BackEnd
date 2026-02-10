// ============================================================================
// Path: src/KPIs/validators/kpi-team-task-fact.validator.ts
// ============================================================================
// Team Task Fact Validator (DTO-safe)
// ----------------------------------------------------------------------------
// Problem you had:
//   - Validator was outputting legacy DTO fields: createdAtISO, dueAtISO
//   - But your current DTO uses: assignedAtISO, expectedEndAtISO
//
// Solution:
//   - Accept both formats in input (legacy + new)
//   - Output ONLY the new DTO fields
//   - exactOptionalPropertyTypes-safe: never assign undefined
// ============================================================================

import { KpiBaseValidator, type ValidatorResult } from './kpi-base.validator';
import type { KpiTeamTaskFactDto } from '../dtos/kpi-team-task-fact.dto';

export class KpiTeamTaskFactValidator extends KpiBaseValidator {
  public constructor() {
    super();
  }

  public parse(payload: unknown): ValidatorResult<KpiTeamTaskFactDto> {
    const errors: string[] = [];

    if (!payload || typeof payload !== 'object') {
      return { ok: false, errors: ['Payload must be a JSON object.'] };
    }

    const p = payload as Record<string, unknown>;

    // ------------------------------------------------------------------------
    // Required IDs
    // ------------------------------------------------------------------------
    this.pushError(errors, this.isObjectIdString(p.orgId), 'orgId must be a valid ObjectId string.');
    this.pushError(errors, this.isObjectIdString(p.taskId), 'taskId must be a valid ObjectId string.');

    // Optional dimension IDs
    this.pushError(errors, !p.branchId || this.isObjectIdString(p.branchId), 'branchId must be a valid ObjectId string.');
    this.pushError(errors, !p.regionId || this.isObjectIdString(p.regionId), 'regionId must be a valid ObjectId string.');
    this.pushError(errors, !p.teamId || this.isObjectIdString(p.teamId), 'teamId must be a valid ObjectId string.');
    this.pushError(errors, !p.memberId || this.isObjectIdString(p.memberId), 'memberId must be a valid ObjectId string.');
    this.pushError(errors, !p.propertyId || this.isObjectIdString(p.propertyId), 'propertyId must be a valid ObjectId string.');

    // ------------------------------------------------------------------------
    // assigneeScope (required) + conditional requirements
    // ------------------------------------------------------------------------
    const scopeOk: boolean = p.assigneeScope === 'team' || p.assigneeScope === 'member';
    this.pushError(errors, scopeOk, 'assigneeScope must be team|member.');

    if (p.assigneeScope === 'team') {
      this.pushError(errors, this.isObjectIdString(p.teamId), 'teamId is required when assigneeScope=team.');
    }
    if (p.assigneeScope === 'member') {
      this.pushError(errors, this.isObjectIdString(p.memberId), 'memberId is required when assigneeScope=member.');
    }

    // ------------------------------------------------------------------------
    // category (required) — keep open-ended validation to avoid blocking new enums
    // ------------------------------------------------------------------------
    this.pushError(errors, this.isNonEmptyString(p.category), 'category is required.');

    // ------------------------------------------------------------------------
    // status (required)
    // ------------------------------------------------------------------------
    this.pushError(errors, this.isNonEmptyString(p.status), 'status is required.');

    // ------------------------------------------------------------------------
    // title (required)
    // ------------------------------------------------------------------------
    this.pushError(errors, this.isNonEmptyString(p.title), 'title is required and must be a non-empty string.');

    // ------------------------------------------------------------------------
    // Timing (required) — accept legacy keys in INPUT
    // OUTPUT must be: assignedAtISO + expectedEndAtISO
    // ------------------------------------------------------------------------
    const assignedAtRaw: unknown = p.assignedAtISO ?? p.createdAtISO;
    const expectedEndRaw: unknown = p.expectedEndAtISO ?? p.dueAtISO;

    this.pushError(
      errors,
      this.isIsoDateString(assignedAtRaw),
      'assignedAtISO must be ISO (or legacy createdAtISO).'
    );

    this.pushError(
      errors,
      this.isIsoDateString(expectedEndRaw),
      'expectedEndAtISO must be ISO (or legacy dueAtISO).'
    );

    // Optional timing
    this.pushError(errors, !p.startedAtISO || this.isIsoDateString(p.startedAtISO), 'startedAtISO must be ISO if provided.');
    this.pushError(errors, !p.completedAtISO || this.isIsoDateString(p.completedAtISO), 'completedAtISO must be ISO if provided.');

    // Optional text
    this.pushError(errors, !p.description || this.isNonEmptyString(p.description), 'description must be non-empty if provided.');

    // Optional projection fields
    const evidenceCountOk: boolean =
      p.evidenceCount === undefined ||
      (typeof p.evidenceCount === 'number' && Number.isFinite(p.evidenceCount) && p.evidenceCount >= 0);
    this.pushError(errors, evidenceCountOk, 'evidenceCount must be a non-negative number if provided.');

    const hasEvidenceOk: boolean = p.hasEvidence === undefined || typeof p.hasEvidence === 'boolean';
    this.pushError(errors, hasEvidenceOk, 'hasEvidence must be boolean if provided.');

    // Optional warning fields
    this.pushError(errors, !p.lastWarningAtISO || this.isIsoDateString(p.lastWarningAtISO), 'lastWarningAtISO must be ISO if provided.');
    this.pushError(errors, !p.lastWarningLevel || this.isNonEmptyString(p.lastWarningLevel), 'lastWarningLevel must be non-empty if provided.');

    if (errors.length > 0) return { ok: false, errors };

    // ------------------------------------------------------------------------
    // Build DTO (IMPORTANT: no createdAtISO / dueAtISO keys)
    // ------------------------------------------------------------------------
    const dto: KpiTeamTaskFactDto = {
      orgId: String(p.orgId),
      taskId: String(p.taskId),

      assigneeScope: p.assigneeScope as any,
      category: String(p.category) as any,
      status: String(p.status) as any,

      assignedAtISO: String(assignedAtRaw),
      expectedEndAtISO: String(expectedEndRaw),

      title: String(p.title),
    };

    if (p.branchId) dto.branchId = String(p.branchId);
    if (p.regionId) dto.regionId = String(p.regionId);
    if (p.teamId) dto.teamId = String(p.teamId);
    if (p.memberId) dto.memberId = String(p.memberId);
    if (p.propertyId) dto.propertyId = String(p.propertyId);

    if (p.priority) dto.priority = p.priority as any;

    if (p.description) dto.description = String(p.description);

    if (p.startedAtISO) dto.startedAtISO = String(p.startedAtISO);
    if (p.completedAtISO) dto.completedAtISO = String(p.completedAtISO);

    if (p.evidenceCount !== undefined) dto.evidenceCount = Number(p.evidenceCount);
    if (p.hasEvidence !== undefined) dto.hasEvidence = Boolean(p.hasEvidence);

    if (p.lastWarningAtISO) dto.lastWarningAtISO = String(p.lastWarningAtISO);
    if (p.lastWarningLevel) dto.lastWarningLevel = String(p.lastWarningLevel) as any;

    return { ok: true, value: dto };
  }
}
