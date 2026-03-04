// Path: src/types/payments/transactions/payment-transaction.types.ts
// =============================================================================
// PaymentTransaction Types — External Payment Transactions (Contracts)
// =============================================================================
//
// 01. Introduction
// - Canonical DTO + filter contracts for Payment Transactions module.
// - Designed for REST + WS (later) without leaking DB specifics.
//
// 02. Important matters (ISO/IEC 27001/27002)
// - Do not expose raw bank account numbers.
// - Evidence attachments must be treated as sensitive and access-controlled.
// - Use companyId as tenant boundary everywhere.
//
// 03. Why we make this file
// - Stabilize contracts early to keep FE/BE aligned.
// - Keep Mongoose types out of contracts (IDs are strings).
//
// 06. Need to keep in mind
// - paymentStatus and verificationStatus are separate by design.
// - transactionAt is the real payment date/time; createdAt is record creation.
// =============================================================================

import type { ActorMini, ISODateString } from "../../common";

// =============================================================================
// Enums
// =============================================================================

/**
 * Business state of the payment itself (what happened financially).
 */
export enum PaymentStatus {
    Pending = "pending",
    Paid = "paid",
    Failed = "failed",
    Refunded = "refunded",
    Voided = "voided",
}

/**
 * Human verification workflow state (approval flow).
 */
export enum PaymentVerificationStatus {
    Unverified = "unverified",
    Submitted = "submitted",
    Approved = "approved",
    Rejected = "rejected",
}

/**
 * Where the payment came from.
 * - "bank_transfer": manual transfer
 * - "cash": paid cash (still can require evidence)
 * - "cheque": cheque deposit proof
 * - "card": offline/pos entry
 * - "gateway": future online gateway integration
 */
export enum PaymentMethodKind {
    BankTransfer = "bank_transfer",
    Cash = "cash",
    Cheque = "cheque",
    Card = "card",
    Gateway = "gateway",
}

// =============================================================================
// Small shared types
// =============================================================================

/**
 * Evidence attachment shape.
 * - Mirrors your cross-module file packet philosophy (no Mongoose types).
 * - Keep it small; UI can request file lists via a dedicated endpoint later if needed.
 */
export interface PaymentEvidenceDto {
    evidenceId: string; // UUID
    label: string; // e.g. "Bank Slip", "Receipt Photo"
    mime: string;
    sizeBytes: number;

    /**
     * Public relative path under "public/uploads/...".
     * IMPORTANT: no leading "/" (PropEase rule).
     */
    publicRel: string;

    /**
     * Optional: absolute publicUrl if you generate it at runtime.
     * Keep optional for SSR/Electron safety.
     */
    publicUrl?: string;

    uploadedAt: ISODateString;
}

// =============================================================================
// Core Transaction DTOs
// =============================================================================

/**
 * Core DTO for a transaction record.
 */
export interface PaymentTransactionCoreDto {
    _id: string;
    transactionId: string; // app id (UUID)
    companyId: string;

    
    bankAccountAlias: string;

    /**
     * Amount fields.
     * - currencyCode must match BankAccount.currencyCode rules (enforced in service).
     */
    amount: number;
    currencyCode: string;

    /**
     * Payment method.
     */
    method: PaymentMethodKind;

    /**
     * External references (optional).
     * - Example: bank deposit reference, cheque number, gateway txn id.
     */
    externalRef?: string;

    /**
     * When the payment actually happened (real-world timestamp).
     */
    transactionAt: ISODateString;

    /**
     * Statuses (separate domains).
     */
    paymentStatus: PaymentStatus;
    verificationStatus: PaymentVerificationStatus;
    verificationNotes?: string;

    /**
     * Approval / rejection info.
     */
    verifiedBy?: ActorMini;
    verifiedAt?: ISODateString;
    rejectedReason?: string;

    /**
     * Free notes (internal).
     */
    notes?: string;

    /**
     * Evidence attachments (optional).
     * - Evidence required for "approve" should be enforced in service rules.
     */
    evidence?: PaymentEvidenceDto[];

    /**
     * Audit.
     */
    createdBy: ActorMini;
    updatedBy?: ActorMini;

    createdAt: ISODateString;
    updatedAt: ISODateString;
}

// =============================================================================
// Create / Update Inputs
// =============================================================================

/**
 * Create input DTO (controller validated).
 * - companyId is NOT included here (comes from auth context).
 */
export interface PaymentTransactionCreateInputDto {
    bankAccountAlias: string;// Bank account

    amount: number;
    currencyCode: string;

    method: PaymentMethodKind;

    externalRef?: string;
    transactionAt: ISODateString;

    notes?: string;
}

/**
 * Update input DTO (PATCH semantics).
 * - undefined => omit
 * - "" => unset for optional strings (controller/service rules)
 */
export interface PaymentTransactionUpdateInputDto {
    /**
     * Optional: allow changing alias (rare), but PATCH semantics must allow omitting it.
     */
    bankAccountAlias?: string;
  
    amount?: number;
    currencyCode?: string;
  
    method?: PaymentMethodKind;
  
    externalRef?: string;     // "" means UNSET (service rule)
    transactionAt?: ISODateString;
  
    paymentStatus?: PaymentStatus;
    verificationStatus?: PaymentVerificationStatus;
  
    notes?: string;           // "" means UNSET (service rule)
  }

/**
 * Verification action payloads (explicit single-purpose actions).
 * Matches your policy for high-privilege actions (approve/reject).
 */
export interface PaymentTransactionApproveInputDto {
    /**
     * Optional extra note for approval record.
     */
    notes?: string;
}

export interface PaymentTransactionRejectInputDto {
    /**
     * Required rejection reason (kept small; no user secrets).
     */
    reason: string;
}

export interface PaymentTransactionPaymentStatusInputDto {
    /**
     * Required status change (kept small; no user secrets).
     */
    status: string;
}

// =============================================================================
// Listing / Filtering
// =============================================================================

export interface PaymentTransactionListFilters {
    bankAccountAlias?: string;
  
    currencyCode?: string;
  
    paymentStatus?: PaymentStatus;
    verificationStatus?: PaymentVerificationStatus;
  
    method?: PaymentMethodKind;
  
    from?: ISODateString;
    to?: ISODateString;
  
    search?: string;
  }
 
export interface PaymentTransactionListItemDto {
    transactionId: string;
    companyId: string;

    bankAccountAlias: string;

    amount: number;
    currencyCode: string;

    method: PaymentMethodKind;

    externalRef?: string;
    transactionAt: ISODateString;

    paymentStatus: PaymentStatus;
    verificationStatus: PaymentVerificationStatus;

    createdAt: ISODateString;
    updatedAt: ISODateString;
}

export interface PaymentTransactionListResponseDto {
    items: PaymentTransactionListItemDto[];
    other: { total: number; };
}

// =============================================================================
// Read One Response
// =============================================================================

export interface PaymentTransactionReadResponseDto {
    item: PaymentTransactionCoreDto;
}

// =============================================================================
// Counts (optional but useful for dashboards)
// =============================================================================

export interface PaymentTransactionCountResponseDto {
    other: {
        total: number;
        pendingVerification: number;
        approved: number;
        rejected: number;
    };
}