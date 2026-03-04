// Path: src/types/payments/bank-registry/bank-accounts/bank-account.types.ts
/* =============================================================================
 * BankAccount Types (Bank Registry) — SINGLE SOURCE OF TRUTH
 * -----------------------------------------------------------------------------
 * 01. Introduction
 * - Canonical DTO + request/response contracts for company-owned bank accounts.
 * - Used across Payments (Transactions/Invoices) and any future Lease routing.
 *
 * 02. Important matters
 * - ✅ Sensitive fields: `accountNumber`, `iban` MUST NEVER appear in public DTOs.
 * - ✅ IDs are DTO-safe strings (no ObjectId in any DTO).
 * - ✅ Optional props must be OMITTED when absent (do not send `undefined`).
 * - ✅ Backend decides “what to return” based on AuthUser role (field-level access).
 *
 * 03. Why we make this file
 * - Prevent type drift (Admin vs Public vs Create vs Update) and keep FE ↔ BE stable.
 * - Provide a predictable migration path (`status` is canonical; `isActive` is compat).
 *
 * 04. Parameter description
 * - See each DTO and request type below.
 *
 * 05. Usage hint
 * - Controllers/services choose return shape:
 *   - Admin/Operator -> Admin DTO (includes raw accountNumber)
 *   - Others         -> Public DTO (masked-only)
 *
 * 06. Need to keep in mind
 * - Always scope by companyId from AuthUser in backend (never accept from FE).
 * - NEVER log raw accountNumber / iban (ISO/IEC 27001 control 8.28: secure coding).
 * ============================================================================= */

import type { ActorMini } from "../../../common";
import type { PageQueryDto } from "../banks/bank-registry.query.types";

/** ISO timestamp string from backend (Date.toISOString()). */
export type ISODateString = string;

/** ISO 4217 currency code (e.g., "LKR", "USD"). */
export type CurrencyCode = string;

/**
 * Canonical status for a BankAccount.
 * - Keep this as the single true flag.
 * - `isActive` exists ONLY for FE migration/compat.
 */
export enum BankAccountStatus {
  Active = "active",
  Inactive = "inactive",
}

/**
 * Role-based access tier for responses.
 * - Service decides which DTO to send based on AuthUser.role.
 */
export enum BankAccountAccessTier {
  Admin = "admin",
  Public = "public",
}

/* =============================================================================
 * Shared primitives
 * ============================================================================= */

/**
 * Safe masked identifiers for UI.
 * - Derived from accountNumber.
 * - MUST exist in all DTO variants (admin & public).
 */
export interface BankAccountMaskedFields {
  /** e.g., "********1234" */
  accountNumberMasked: string;

  /** e.g., "1234" */
  accountNumberLast4: string;
}

/**
 * Bank snapshot fields to avoid extra joins for lists.
 * - These are safe and useful in selectors.
 */
export interface BankAccountBankSnapshot {
  bankNameSnapshot?: string;
  bankCodeSnapshot?: string;
  swiftBicSnapshot?: string;
  bankCountrySnapshot?: string;
}

/**
 * Branch details (optional).
 */
export interface BankAccountBranchDetails {
  branchName?: string;
  branchCode?: string;
}

/* =============================================================================
 * DTOs
 * ============================================================================= */

/**
 * Core fields common to ALL bank account DTOs.
 * - SAFE by default (does NOT include raw accountNumber / iban).
 */
export interface BankAccountBaseDto
  extends BankAccountMaskedFields,
    BankAccountBankSnapshot,
    BankAccountBranchDetails {
  /** Mongo id as DTO-safe string */
  _id: string;

  /** Application id (uuid-like) */
  accountId: string;

  /** Company scope (service must validate it against AuthUser.companyId) */
  companyId: string;

  /** UI label */
  alias: string;

  /** Link to Bank record (app id) */
  bankId: string;
  bankCode: string;

  /** Account identity */
  accountHolderName: string;

  /** Currency for this account */
  currencyCode: CurrencyCode;

  /** Marks account as default within company */
  isDefault: boolean;

  /** Canonical status (single source of truth) */
  status: BankAccountStatus;

  /**
   * Backward compatibility flag.
   * - Derived from status in backend.
   * - Keep until FE fully switches to `status`.
   */
  isActive: boolean;

  /** Optional internal notes */
  notes?: string;

  createdAt: ISODateString;
  updatedAt: ISODateString;

  createdBy: ActorMini;
  updatedBy?: ActorMini;
}

/**
 * Admin DTO
 * - Includes sensitive fields.
 * - MUST be returned ONLY to privileged roles (Admin/Operator, or your final policy).
 */
export interface BankAccountAdminDto extends BankAccountBaseDto {
  /**
   * Raw account number (SENSITIVE)
   * - Never log.
   * - Never send to non-admin roles.
   */
  accountNumber: string;

  /**
   * IBAN (SENSITIVE)
   * - Optional, but still admin-only.
   */
  iban?: string;
}

/**
 * Public DTO
 * - Safe for selectors and non-admin views.
 * - MUST NOT include raw accountNumber/iban.
 */
export type BankAccountPublicDto = BankAccountBaseDto;

/**
 * Union for “service returns depending on role”.
 * - Controller/service can type the response as BankAccountDto and still be correct.
 */
export type BankAccountDto = BankAccountAdminDto | BankAccountPublicDto;

/* =============================================================================
 * Input DTOs (FE -> BE)
 * ============================================================================= */

/**
 * Create input (FE -> BE)
 * - companyId MUST NOT come from FE (derived from AuthUser).
 * - Precedence rule: if both status and isActive are provided, status wins.
 */
export interface BankAccountCreateInputDto extends BankAccountBranchDetails {
  bankId: string;
  bankCode: string;
  alias: string;

  accountHolderName: string;

  /**
   * Raw account number (required)
   * - Backend stores it (encrypted/masked strategy depends on your implementation).
   */
  accountNumber: string;

  /**
   * Optional IBAN (sensitive).
   * - Backend must validate format if you decide to enforce.
   */
  iban?: string;

  currencyCode: CurrencyCode;

  /** Default false if omitted. */
  isDefault?: boolean;

  /** Preferred canonical field. */
  status?: BankAccountStatus;

  /** Compatibility field (maps to status). */
  isActive?: boolean;

  notes?: string;
}

/**
 * Update input (PATCH-style)
 * - Optional props MUST be omitted when not provided.
 * - Precedence rule: status wins over isActive.
 *
 * NOTE on unsetting:
 * - Decide in service layer if empty string means unset (recommended: treat "" as unset).
 */
export interface BankAccountUpdateInputDto extends BankAccountBranchDetails {
  bankId?: string;
  bankCode?: string;
  alias?: string;

  accountHolderName?: string;

  /** Admin-only update (backend should reject for non-admin roles). */
  accountNumber?: string;

  /** Admin-only update (backend should reject for non-admin roles). */
  iban?: string;

  currencyCode?: CurrencyCode;

  isDefault?: boolean;

  status?: BankAccountStatus;
  isActive?: boolean;

  notes?: string;
}

/* =============================================================================
 * Query / List contracts
 * ============================================================================= */

/**
 * List filters (FE -> BE)
 * - Backend MUST enforce companyId from AuthUser (never accept from client).
 */
export interface BankAccountListFiltersDto {
  bankId?: string;
  currencyCode?: CurrencyCode;

  /** Explicit status filter */
  status?: BankAccountStatus;

  /**
   * Shorthand filters:
   * - onlyActive: if true, implies status=active
   * - includeInactive: if true, ignore onlyActive shortcut (explicit status still applies)
   */
  onlyActive?: boolean;
  includeInactive?: boolean;

  isDefault?: boolean;

  /** Search across snapshots + holder + branch + codes */
  search?: string;

  /** Optional safe search for last4 */
  last4?: string;
}

/**
 * List request (FE -> BE)
 */
export interface BankAccountListRequestDto {
  page: PageQueryDto;
  filters?: BankAccountListFiltersDto;
}

/**
 * List response (BE -> FE)
 * - `items` will be AdminDto[] or PublicDto[] depending on AuthUser role.
 */
export interface BankAccountListResponseDto<TItem extends BankAccountDto = BankAccountDto> {
  items: TItem[];
  other: {
    total: number;
  };
}

/**
 * Count response (BE -> FE)
 * - Keep consistent with your global “other.total” pattern.
 */
export interface BankAccountCountResponseDto {
  other: {
    total: number;
  };
}

/* =============================================================================
 * Service-side helper typing (optional but clean)
 * ============================================================================= */

/**
 * Map access tier -> DTO type.
 * - Helpful for services: resolve tier once, and the compiler follows.
 */
export type BankAccountDtoByTier<TTier extends BankAccountAccessTier> =
  TTier extends BankAccountAccessTier.Admin ? BankAccountAdminDto : BankAccountPublicDto;
