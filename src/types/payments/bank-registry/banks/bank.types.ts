// Path: src/types/payments/bank-registry/banks/bank.types.ts
/* =============================================================================
 * Bank Types (Bank Registry)
 * -----------------------------------------------------------------------------
 * 01. Introduction
 * - Defines DTO contracts for Bank registry (canonical shared contract).
 * - Used by controllers/services to avoid leaking Mongoose types outward.
 *
 * 02. Important matters
 * - IDs in DTOs are string-based (never ObjectId).
 * - Optional properties must be OMITTED (exactOptionalPropertyTypes-safe).
 * - Designed to support multi-company separation (companyId is a string).
 *
 * 03. Why we make this file
 * - Keep a stable contract layer for FE <-> BE.
 * - Prevent schema leakage and reduce refactor risk.
 * - Support auditability for security/compliance (who created/updated).
 *
 * 06. Need to keep in mind
 * - Never store secrets here. This is contract-only.
 * - Validate all incoming payloads at controller boundary.
 * ============================================================================= */

import type { ActorMini, PhoneNumber, ISODateString } from "../../../common";

export interface PageQueryDto{
  page: number;
  limit: number;
}

export type CountryCca2 = string; // e.g. "LK", "AE"
export type CurrencyCode = string; // e.g. "LKR", "USD"

export enum BankStatus {
  Active = "active",
  Inactive = "inactive",
}


export interface BankCoreDto {
  bankId: string; // uuid-like app id
  companyId: string;

  name: string; // e.g. "Commercial Bank"
  countryCca2: CountryCca2;

  /**
   * Optional bank “public” codes.
   * Omit if unknown.
   */
  bankCode?: string; // internal/local bank code
  swiftBic?: string;

  supportedCurrencyCodes?: string[];

  status: BankStatus;

  addressLine1: string;
  addressLine2?: string;
  city: string;
  district: string;
  province: string;
  postalCode: string;
  phone: PhoneNumber;

  notes?: string;

  createdAt: ISODateString;
  updatedAt: ISODateString;

  createdBy: ActorMini;
  updatedBy?: ActorMini;
}

/**
 * Create payload (what API accepts).
 * - Audit fields are attached by backend (NOT accepted from client).
 */
export interface BankCreateInput {
  companyId?: string;
  name: string; // e.g. "Commercial Bank"
  countryCca2: CountryCca2;

  /**
   * Optional bank “public” codes.
   * Omit if unknown.
   */
  bankCode?: string; // internal/local bank code
  swiftBic?: string;

  addressLine1: string;
  addressLine2?: string;
  city: string;
  district: string;
  province: string;
  postalCode: string;
  phone: PhoneNumber;

  notes?: string;

  status: BankStatus;

  supportedCurrencyCodes?: string[];
}

/**
 * Update payload (PATCH-like).
 * - Omit fields you do not change.
 */
export interface BankUpdateInput {
  companyId?: string;
  name?: string; // e.g. "Commercial Bank"
  countryCca2?: CountryCca2;

  /**
   * Optional bank “public” codes.
   * Omit if unknown.
   */
  bankCode?: string; // internal/local bank code
  swiftBic?: string;

  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  district?: string;
  province?: string;
  postalCode?: string;
  phone?: PhoneNumber;

  notes?: string;

  status?: BankStatus;

  supportedCurrencyCodes?: string[];
}