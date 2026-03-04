// Path: src/models/payments/bank-registry/bank-account.model.ts
/* =============================================================================
 * BankAccount Model (Mongoose) — Canonical Bank Registry Account Storage
 * -----------------------------------------------------------------------------
 * 01. Introduction
 * - Persists company-owned bank accounts linked to the Bank Registry.
 * - Designed to match DTO contracts in:
 *   src/types/payments/bank-registry/bank-accounts/bank-account.types.ts
 *
 * 02. Important matters
 * - ✅ Sensitive: `accountNumber`, `iban` are stored here (DB) but MUST NOT be
 *   returned to non-admin roles by services/controllers.
 * - ✅ Masked UI fields are REQUIRED:
 *   - accountNumberMasked
 *   - accountNumberLast4
 * - ✅ Tenant isolation:
 *   - ALWAYS query by companyId in services to prevent cross-company leakage.
 *
 * 03. Why we make this class
 * - Centralizes schema creation + indexes + export stability.
 * - Prevents “schema drift” by forcing all sub-schemas and main schema to be
 *   built from single methods (clean audit trail & maintainability).
 *
 * 06. Need to keep in mind
 * - `isDefault=true` uniqueness is NOT enforced by Mongo here (it’s conditional);
 *   enforce “only one default per company” in the write service layer.
 * - Snapshot fields reduce UI joins for list/selectors.
 * ============================================================================= */

import { Schema, model, models, type Model, type Types } from "mongoose";

import { BankAccountStatus } from "../../../types/payments/bank-registry/bank-accounts/bank-account.types";
import type { ActorMini } from "../../../types/common";

/**
 * IBankAccount (DB shape)
 * - This is the persistence shape (includes sensitive fields).
 * - Services MUST map this -> DTOs (AdminDto or PublicDto) according to AuthUser role.
 */
export interface IBankAccount {
  _id: Types.ObjectId;

  // Stable app ids
  accountId: string; // uuid-like
  companyId: string; // tenant scope

  // UI label (unique per company)
  alias: string;

  // Link to bank registry
  bankRefId: Types.ObjectId; // ref: Bank._id (mongo)
  bankId: string; // bank app-id (DTO contract stability)

  // Denormalized snapshots (safe, optional)
  bankNameSnapshot?: string;
  bankCodeSnapshot?: string;
  swiftBicSnapshot?: string;
  bankCountrySnapshot?: string;

  // Account identity
  accountHolderName: string;

  // Sensitive
  accountNumber: string;
  iban?: string;

  // Derived safe UI fields (MUST be set by write service)
  accountNumberMasked: string;
  accountNumberLast4: string;

  // Optional branch data
  branchName?: string;  
  branchCode?: string;
  bankCode: string;

  // Currency
  currencyCode: string;

  // Flags
  isDefault: boolean;
  status: BankAccountStatus;

  // Optional notes
  notes?: string;

  // Audit
  createdBy: ActorMini;
  updatedBy?: ActorMini;

  // timestamps: true
  createdAt: Date;
  updatedAt: Date;
}

/**
 * BankAccountModelProvider
 * -----------------------------------------------------------------------------
 * 01. Introduction
 * - Class-based model provider to keep schema/index logic centralized.
 *
 * 02. Important matters
 * - Do NOT create multiple schema definitions in different files.
 * - All sub-schemas must be created via dedicated methods (audit-friendly).
 *
 * 03. Why we make this class
 * - Avoid “messy” type/schema duplication and index drift.
 */
export class BankAccountModelProvider {
  private constructor() {}

  /**
   * Build ActorMini sub-schema used for createdBy/updatedBy.
   *
   * @param options.none
   * - No params. Kept as a method to enforce single-definition policy.
   *
   * Usage hint
   * - Embedded as `{ type: ActorMiniSchema, required: true }`.
   *
   * Keep in mind
   * - `_id:false` because this is a subdocument fragment, not an entity.
   */
  private static buildActorMiniSchema(): Schema<ActorMini> {
    const schema = new Schema<ActorMini>(
      {
        userId: { type: String, required: true, trim: true },
        username: { type: String, required: true, trim: true },
        role: { type: String, required: false, trim: true },
      },
      { _id: false }
    );

    return schema;
  }

  /**
   * Build the main BankAccount schema.
   *
   * @param options.collectionName
   * - Expected: Mongo collection name
   *
   * Usage hint
   * - Schema is later passed to `applyIndexes()` before building the Model.
   *
   * Keep in mind
   * - Sensitive fields exist here by design; services must enforce field-level access.
   */
  private static buildBankAccountSchema(options: {
    collectionName: string;
  }): Schema<IBankAccount> {
    const ActorMiniSchema = this.buildActorMiniSchema();

    const schema = new Schema<IBankAccount>(
      {
        // ---------------------------------------------------------------------
        // Identifiers / scope
        // ---------------------------------------------------------------------
        accountId: { type: String, required: true, trim: true, index: true },
        companyId: { type: String, required: true, trim: true, index: true },

        // ---------------------------------------------------------------------
        // Alias (unique per company)
        // ---------------------------------------------------------------------
        alias: {
          type: String,
          required: true,
          trim: true,
          minlength: 2,
          maxlength: 80,
          index: true,
        },

        // ---------------------------------------------------------------------
        // Bank linkage + stable bankId snapshot
        // ---------------------------------------------------------------------
        bankRefId: {
          type: Schema.Types.ObjectId,
          required: true,
          ref: "Bank",
          index: true,
        },
        bankId: { type: String, required: true, trim: true, index: true },

        // ---------------------------------------------------------------------
        // Safe bank snapshots (optional)
        // ---------------------------------------------------------------------
        bankNameSnapshot: { type: String, required: false, trim: true },
        bankCodeSnapshot: { type: String, required: false, trim: true },
        swiftBicSnapshot: { type: String, required: false, trim: true },
        bankCountrySnapshot: { type: String, required: false, trim: true },

        // ---------------------------------------------------------------------
        // Account identity (sensitive)
        // ---------------------------------------------------------------------
        accountHolderName: {
          type: String,
          required: true,
          trim: true,
          minlength: 2,
          maxlength: 160,
        },

        // Sensitive: stored in DB; never log; return only for admin tier
        accountNumber: {
          type: String,
          required: true,
          trim: true,
          minlength: 4,
          maxlength: 80,
        },
        iban: { type: String, required: false, trim: true, maxlength: 80 },

        // ---------------------------------------------------------------------
        // Derived safe fields (REQUIRED)
        // - Must be computed by write service on create/update.
        // ---------------------------------------------------------------------
        accountNumberMasked: { type: String, required: true, trim: true },
        accountNumberLast4: {
          type: String,
          required: true,
          trim: true,
          minlength: 4,
          maxlength: 4,
        },

        // ---------------------------------------------------------------------
        // Branch (optional)
        // ---------------------------------------------------------------------
        branchName: { type: String, required: false, trim: true, maxlength: 120 },
        branchCode: { type: String, required: false, trim: true, maxlength: 32 },
        bankCode: {type: String, required: true, trim: true, maxlength: 32},
        // ---------------------------------------------------------------------
        // Currency
        // ---------------------------------------------------------------------
        currencyCode: {
          type: String,
          required: true,
          trim: true,
          index: true,
          minlength: 3,
          maxlength: 8,
        },

        // ---------------------------------------------------------------------
        // Flags + status
        // ---------------------------------------------------------------------
        isDefault: { type: Boolean, required: true, default: false, index: true },

        status: {
          type: String,
          required: true,
          enum: Object.values(BankAccountStatus),
          default: BankAccountStatus.Active,
          index: true,
        },

        // ---------------------------------------------------------------------
        // Optional notes (admin-only meaning, but DB can store it)
        // ---------------------------------------------------------------------
        notes: { type: String, required: false, trim: true, maxlength: 500 },

        // ---------------------------------------------------------------------
        // Audit (embedded)
        // ---------------------------------------------------------------------
        createdBy: { type: ActorMiniSchema, required: true },
        updatedBy: { type: ActorMiniSchema, required: false },
      },
      {
        timestamps: true,
        collection: options.collectionName,
        minimize: true,
        toJSON: {
          virtuals: true,
          /**
           * Remove internal mongoose fields when serialized.
           * NOTE: Services should still map -> DTO explicitly (don’t leak sensitive fields).
           */
          transform: (_doc, ret: Record<string, unknown>) => {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete ret.__v;
            return ret;
          },
        },
      }
    );

    return schema;
  }

  /**
   * Apply indexes to schema (uniqueness + performance helpers).
   *
   * @param schema
   * - The main BankAccount schema.
   *
   * Keep in mind
   * - Some rules (like single default per company) are service-enforced, not index-enforced.
   */
  private static applyIndexes(schema: Schema<IBankAccount>): void {
    // Uniqueness: accountId inside company
    schema.index({ companyId: 1, accountId: 1 }, { unique: true });

    // Uniqueness: alias inside company
    schema.index({ companyId: 1, alias: 1 }, { unique: true });

    // Core uniqueness: bank + accountNumber inside company
    schema.index(
      { companyId: 1, bankRefId: 1, accountNumber: 1 },
      { unique: true }
    );

    // Optional uniqueness: IBAN inside company (only when present & non-empty)
    schema.index(
      { companyId: 1, iban: 1 },
      {
        unique: true,
        partialFilterExpression: { iban: { $type: "string", $ne: "" } },
      }
    );

    // List/query helper index (common filters)
    schema.index({ companyId: 1, status: 1, currencyCode: 1, isDefault: 1 });

    // Safe search helper (last4)
    schema.index({ companyId: 1, accountNumberLast4: 1 });
  }

  /**
   * Build and return the BankAccount mongoose model.
   *
   * @param options.modelName
   * - Expected: stable mongoose model name
   * - Default: "BankAccount"
   *
   * @param options.collectionName
   * - Expected: stable mongo collection name
   * - Default: "bank_accounts"
   *
   * Usage hint
   * - Import `BankAccountModel` from this file wherever needed.
   *
   * Keep in mind
   * - This provider uses `models[modelName]` to prevent overwrite in hot reload.
   */
  public static getModel(options?: {
    modelName?: string;
    collectionName?: string;
  }): Model<IBankAccount> {
    const modelName = options?.modelName ?? "BankAccount";
    const collectionName = options?.collectionName ?? "bank_accounts";

    if (models[modelName]) {
      return models[modelName] as Model<IBankAccount>;
    }

    const schema = this.buildBankAccountSchema({ collectionName });
    this.applyIndexes(schema);

    return model<IBankAccount>(modelName, schema);
  }
}

export const BankAccountModel: Model<IBankAccount> =
  BankAccountModelProvider.getModel();