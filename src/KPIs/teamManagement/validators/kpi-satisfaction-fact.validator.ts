// ============================================================================
// Path: src/KPIs/validators/kpi-satisfaction-fact.validator.ts
// ============================================================================
// Satisfaction Fact Validator
// ----------------------------------------------------------------------------
// Purpose:
//   Validate incoming satisfaction KPI facts before inserting into Mongo.
//
// DTO fields (based on your KPIs ingest + models):
//   Required:
//     - orgId: ObjectId string
//     - agentId: ObjectId string
//     - rating: number (1..5 or 0..10 depending on your business rule)
//     - submittedAtISO: ISO date string
//   Optional:
//     - comment: string
//     - branchId, regionId, teamId: ObjectId strings
//
// Notes:
//   - exactOptionalPropertyTypes safe: never assign undefined to optional fields.
//   - Class-based only.
// ============================================================================

import { KpiBaseValidator, type ValidatorResult } from './kpi-base.validator';
import type { KpiSatisfactionFactDto } from '../dtos/kpi-satisfaction-fact.dto';

export class KpiSatisfactionFactValidator extends KpiBaseValidator {
  public constructor() {
    super();
  }

  public parse(payload: unknown): ValidatorResult<KpiSatisfactionFactDto> {
    const errors: string[] = [];

    if (!payload || typeof payload !== 'object') {
      return { ok: false, errors: ['Payload must be a JSON object.'] };
    }

    const p = payload as Record<string, unknown>;

    // ------------------------------------------------------------------------
    // Required IDs
    // ------------------------------------------------------------------------
    this.pushError(errors, this.isObjectIdString(p.orgId), 'orgId must be a valid ObjectId string.');
    this.pushError(errors, this.isObjectIdString(p.agentId), 'agentId must be a valid ObjectId string.');

    // Optional IDs
    this.pushError(errors, !p.branchId || this.isObjectIdString(p.branchId), 'branchId must be a valid ObjectId string.');
    this.pushError(errors, !p.regionId || this.isObjectIdString(p.regionId), 'regionId must be a valid ObjectId string.');
    this.pushError(errors, !p.teamId || this.isObjectIdString(p.teamId), 'teamId must be a valid ObjectId string.');

    // ------------------------------------------------------------------------
    // Rating rules
    // ------------------------------------------------------------------------
    const ratingOk: boolean =
      typeof p.rating === 'number' &&
      Number.isFinite(p.rating) &&
      p.rating >= 1 &&
      p.rating <= 5;

    // Teaching note:
    // If your business uses 0..10 or NPS, adjust the range here.
    this.pushError(errors, ratingOk, 'rating must be a number between 1 and 5.');

    // ------------------------------------------------------------------------
    // Comment (optional)
    // ------------------------------------------------------------------------
    const commentOk: boolean = p.comment === undefined || p.comment === null || this.isNonEmptyString(p.comment);
    this.pushError(errors, commentOk, 'comment must be a non-empty string if provided.');

    // ------------------------------------------------------------------------
    // submittedAtISO (required)
    // ------------------------------------------------------------------------
    this.pushError(errors, this.isIsoDateString(p.submittedAtISO), 'submittedAtISO must be a valid ISO date string.');

    if (errors.length > 0) return { ok: false, errors };

    // ------------------------------------------------------------------------
    // Build DTO (exactOptionalPropertyTypes-safe)
    // ------------------------------------------------------------------------
    const dto: KpiSatisfactionFactDto = {
      orgId: String(p.orgId),
      agentId: String(p.agentId),
      rating: Number(p.rating),
      submittedAtISO: String(p.submittedAtISO),
    };

    if (p.branchId) dto.branchId = String(p.branchId);
    if (p.regionId) dto.regionId = String(p.regionId);
    if (p.teamId) dto.teamId = String(p.teamId);

    // comment is optional
    if (p.comment !== undefined && p.comment !== null && String(p.comment).trim()) {
      dto.comment = String(p.comment).trim();
    }

    return { ok: true, value: dto };
  }
}
