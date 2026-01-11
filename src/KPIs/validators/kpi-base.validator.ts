// ============================================================================
// Path: src/KPIs/validators/kpi-base.validator.ts
// ============================================================================
// Base Validator Helpers
// ----------------------------------------------------------------------------
// Purpose:
//   Provide reusable runtime validation helpers.
//   We validate the payload at runtime because REST is untrusted input.
// ============================================================================

import { Types } from 'mongoose';

export interface ValidatorOk<T> {
  ok: true;
  value: T;
}

export interface ValidatorFail {
  ok: false;
  errors: ReadonlyArray<string>;
}

export type ValidatorResult<T> = ValidatorOk<T> | ValidatorFail;

export class KpiBaseValidator {
  protected constructor() {}

  protected isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
  }

  protected isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
  }

  protected isIsoDateString(v: unknown): v is string {
    if (!this.isNonEmptyString(v)) return false;
    const d = new Date(v);
    return !Number.isNaN(d.getTime());
  }

  protected isObjectIdString(v: unknown): v is string {
    return this.isNonEmptyString(v) && Types.ObjectId.isValid(v);
  }

  protected pushError(errors: string[], condition: boolean, message: string): void {
    if (!condition) errors.push(message);
  }
}
