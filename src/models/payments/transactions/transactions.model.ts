/* =============================================================================
 * PaymentTransaction Model (Mongoose) — NORMALIZED (alias-only)
 * -----------------------------------------------------------------------------
 * 01. Introduction
 * - External payment transactions recorded by the company (tenant boundary).
 * - Uses bankAccountAlias ONLY (human readable + unique) — no bankAccountId stored.
 * - Stores both business payment status and human verification status.
 *
 * 02. Important matters (ISO/IEC 27001/27002)
 * - Do NOT store raw bank account numbers.
 * - Always query by companyId (tenant boundary) in services.
 * - Evidence contains only safe public metadata (publicRel/publicUrl + size/mime).
 *
 * 03. Why we make this class
 * - Canonical schema for Transactions module aligned with contracts.
 * - Clear schema composition via builder methods (sub-schemas).
 *
 * 06. Need to keep in mind
 * - transactionAt = real-world payment time
 * - createdAt/updatedAt = Mongo timestamps (audit)
 * ============================================================================= */

import { Schema, model, models, type Model, type Types } from "mongoose";

import type { ActorMini } from "../../../types/common";
import {
  PaymentMethodKind,
  PaymentStatus,
  PaymentVerificationStatus,
  type PaymentEvidenceDto,
  type PaymentTransactionCoreDto,
} from "../../../types/payments/transactions/payment-transaction.types";

// =============================================================================
// Local DB Shapes (Date-based storage)
// =============================================================================

export interface PaymentEvidenceDb extends Omit<PaymentEvidenceDto, "uploadedAt"> {
  uploadedAt: Date;
}

/**
 * DB entity (Date-based timestamps, no ISO strings).
 * - Keep contract IDs as string (no ObjectId leakage in DTOs).
 */
export interface IPaymentTransaction
  extends Omit<
    PaymentTransactionCoreDto,
    "_id" | "createdAt" | "updatedAt" | "transactionAt" | "verifiedAt" | "evidence"
  > {
  _id: Types.ObjectId;

  transactionAt: Date;

  verifiedAt?: Date;

  evidence?: PaymentEvidenceDb[];

  createdAt: Date;
  updatedAt: Date;
}

export class PaymentTransactionModelProvider {
  private constructor() {}

  // ---------------------------------------------------------------------------
  // 01) ActorMini sub-schema (typed + options isolated)
  // ---------------------------------------------------------------------------

  /**
   * Build ActorMini schema used in createdBy/updatedBy/verifiedBy.
   *
   * @returns Schema<ActorMini>
   * - _id disabled (embedded)
   * - minimize disabled to keep stable JSON shape when empty objects appear (optional)
   */
  private static buildActorMiniSchema(): Schema<ActorMini> {
    return new Schema<ActorMini>(
      {
        userId: { type: String, required: true, trim: true },
        username: { type: String, required: true, trim: true },
        role: { type: String, required: false, trim: true },
      },
      {
        _id: false,
        minimize: false,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // 02) Evidence sub-schema (typed + options isolated)
  // ---------------------------------------------------------------------------

  /**
   * Build evidence schema (FileMeta-like packet).
   *
   * @returns Schema<PaymentEvidenceDb>
   * - _id disabled (embedded)
   * - evidenceId indexed (for audit/debug)
   */
  private static buildPaymentEvidenceSchema(): Schema<PaymentEvidenceDb> {
    const s = new Schema<PaymentEvidenceDb>(
      {
        evidenceId: { type: String, required: true, trim: true, index: true },
        label: { type: String, required: true, trim: true },
        mime: { type: String, required: true, trim: true },
        sizeBytes: { type: Number, required: true, min: 0 },

        publicRel: { type: String, required: true, trim: true },
        publicUrl: { type: String, required: false, trim: true },

        uploadedAt: { type: Date, required: true },
      },
      {
        _id: false,
        minimize: false,
      },
    );

    return s;
  }

  // ---------------------------------------------------------------------------
  // 03) Main transaction schema (typed + options isolated)
  // ---------------------------------------------------------------------------

  /**
   * Build main PaymentTransaction schema aligned with PaymentTransactionCoreDto.
   *
   * @param options.collectionName
   * - Expected: Mongo collection name
   */
  private static buildPaymentTransactionSchema(options: {
    collectionName: string;
  }): Schema<IPaymentTransaction> {
    const ActorMiniSchema = PaymentTransactionModelProvider.buildActorMiniSchema();
    const PaymentEvidenceSchema = PaymentTransactionModelProvider.buildPaymentEvidenceSchema();

    const s = new Schema<IPaymentTransaction>(
      {
        // Identifiers
        transactionId: { type: String, required: true, trim: true, index: true },
        companyId: { type: String, required: true, trim: true, index: true },

        // ✅ Normalized reference (alias-only)
        bankAccountAlias: { type: String, required: true, trim: true, index: true },

        // Money
        amount: { type: Number, required: true, min: 0 },
        currencyCode: { type: String, required: true, trim: true, index: true },

        // Enums
        method: {
          type: String,
          required: true,
          enum: Object.values(PaymentMethodKind),
          index: true,
        },

        // Optional fields
        externalRef: { type: String, required: false, trim: true, index: true },
        notes: { type: String, required: false, trim: true },

        // Time
        transactionAt: { type: Date, required: true, index: true },

        // Status domains
        paymentStatus: {
          type: String,
          required: true,
          enum: Object.values(PaymentStatus),
          default: PaymentStatus.Pending,
          index: true,
        },

        verificationStatus: {
          type: String,
          required: true,
          enum: Object.values(PaymentVerificationStatus),
          default: PaymentVerificationStatus.Unverified,
          index: true,
        },

        verificationNotes: {type: String, require: false, trim: true, default: ''},

        // Approval/rejection audit
        verifiedBy: { type: ActorMiniSchema, required: false },
        verifiedAt: { type: Date, required: false },
        rejectedReason: { type: String, required: false, trim: true },

        // Evidence
        evidence: { type: [PaymentEvidenceSchema], required: false, default: undefined },

        // Audit
        createdBy: { type: ActorMiniSchema, required: true },
        updatedBy: { type: ActorMiniSchema, required: false },
      },
      {
        timestamps: true,
        collection: options.collectionName,
        minimize: false,
      },
    );

    // -------------------------------------------------------------------------
    // Indexes (company boundary + common filters)
    // -------------------------------------------------------------------------
    s.index({ companyId: 1, transactionId: 1 }, { unique: true });

    s.index({ companyId: 1, bankAccountAlias: 1, transactionAt: -1 });
    s.index({ companyId: 1, verificationStatus: 1, transactionAt: -1 });
    s.index({ companyId: 1, paymentStatus: 1, transactionAt: -1 });
    s.index({ companyId: 1, method: 1, transactionAt: -1 });
    s.index({ companyId: 1, currencyCode: 1, transactionAt: -1 });

    // Optional search helpers (regex-based search in service should remain safe)
    s.index({ companyId: 1, externalRef: 1 });
    // notes index is optional (can be heavy); enable only if you really search notes at scale
    // s.index({ companyId: 1, notes: 1 });

    return s;
  }

  // ---------------------------------------------------------------------------
  // 04) Model getter
  // ---------------------------------------------------------------------------

  /**
   * Build and return the PaymentTransaction mongoose model.
   *
   * @param options.modelName
   * - Expected: stable model name
   * - Default: "PaymentTransaction"
   *
   * @param options.collectionName
   * - Expected: Mongo collection name
   * - Default: "payment_transactions"
   */
  public static getModel(options?: {
    modelName?: string;
    collectionName?: string;
  }): Model<IPaymentTransaction> {
    const modelName = options?.modelName ?? "PaymentTransaction";
    const collectionName = options?.collectionName ?? "payment_transactions";

    if (models[modelName]) {
      return models[modelName] as Model<IPaymentTransaction>;
    }

    const PaymentTransactionSchema =
      PaymentTransactionModelProvider.buildPaymentTransactionSchema({ collectionName });

    return model<IPaymentTransaction>(modelName, PaymentTransactionSchema);
  }
}

export const PaymentTransactionModel = PaymentTransactionModelProvider.getModel();