// ============================================================================
// Path: src/KPIs/validators/kpi-deal-fact.validator.ts
// ============================================================================

import { KpiBaseValidator, type ValidatorResult } from './kpi-base.validator';
import type { KpiDealFactDto } from '../dtos/kpi-deal-fact.dto';

export class KpiDealFactValidator extends KpiBaseValidator {
  public constructor() {
    super();
  }

  public parse(payload: unknown): ValidatorResult<KpiDealFactDto> {
    const errors: string[] = [];

    if (!payload || typeof payload !== 'object') {
      return { ok: false, errors: ['Payload must be a JSON object.'] };
    }

    const p = payload as Record<string, unknown>;

    this.pushError(errors, this.isObjectIdString(p.orgId), 'orgId must be a valid ObjectId string.');
    this.pushError(errors, !p.branchId || this.isObjectIdString(p.branchId), 'branchId must be a valid ObjectId string.');
    this.pushError(errors, !p.regionId || this.isObjectIdString(p.regionId), 'regionId must be a valid ObjectId string.');

    this.pushError(errors, !p.teamId || this.isObjectIdString(p.teamId), 'teamId must be a valid ObjectId string.');
    this.pushError(errors, this.isObjectIdString(p.agentId), 'agentId must be a valid ObjectId string.');
    this.pushError(errors, !p.propertyId || this.isObjectIdString(p.propertyId), 'propertyId must be a valid ObjectId string.');

    this.pushError(errors, p.dealType === 'sale' || p.dealType === 'rent', 'dealType must be "sale" or "rent".');
    this.pushError(errors, p.status === 'won' || p.status === 'lost' || p.status === 'cancelled', 'status must be "won" | "lost" | "cancelled".');

    this.pushError(errors, !p.propertyType || this.isNonEmptyString(p.propertyType), 'propertyType must be a string if provided.');

    this.pushError(errors, this.isFiniteNumber(p.dealValue) && p.dealValue >= 0, 'dealValue must be a number >= 0.');
    this.pushError(errors, this.isFiniteNumber(p.commissionAmount) && p.commissionAmount >= 0, 'commissionAmount must be a number >= 0.');
    this.pushError(errors, this.isNonEmptyString(p.currencyCode), 'currencyCode must be a non-empty string.');

    this.pushError(errors, this.isIsoDateString(p.closedAtISO), 'closedAtISO must be a valid ISO date string.');

    if (errors.length > 0) return { ok: false, errors };

    const dto: KpiDealFactDto = {
      orgId: String(p.orgId),
      agentId: String(p.agentId),

      dealType: p.dealType as 'sale' | 'rent',
      status: p.status as 'won' | 'lost' | 'cancelled',

      dealValue: Number(p.dealValue),
      commissionAmount: Number(p.commissionAmount),
      currencyCode: String(p.currencyCode).toUpperCase(),

      closedAtISO: String(p.closedAtISO),
    };

    // Optional fields are added ONLY when present (strict TS safe)
    if (p.branchId) dto.branchId = String(p.branchId);
    if (p.regionId) dto.regionId = String(p.regionId);

    if (p.teamId) dto.teamId = String(p.teamId);
    if (p.propertyId) dto.propertyId = String(p.propertyId);

    if (p.propertyType) dto.propertyType = String(p.propertyType);

    return { ok: true, value: dto };
  }
}
