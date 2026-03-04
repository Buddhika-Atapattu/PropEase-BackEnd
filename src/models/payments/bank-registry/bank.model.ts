/* =============================================================================
 * Bank Model (Mongoose)
 * -----------------------------------------------------------------------------
 * 01. Introduction
 * - Bank registry master data.
 * - Stored per companyId (multi-tenant separation).
 *
 * 02. Important matters
 * - Do not store secrets.
 * - Indexes are created for company scoping and code search.
 * - Optional fields are only set when present (exactOptionalPropertyTypes-safe).
 *
 * 03. Why we make this class
 * - Enforce a single schema definition and reuse safely across imports.
 * - Provide a stable export (BankModel) while still being class-based.
 *
 * 06. Need to keep in mind
 * - Always query with companyId in services/controllers.
 * - Validate inputs at controller boundary (lengths, allowed chars, etc.).
 * ============================================================================= */

import { Schema, model, models, type Model, type Types } from "mongoose";
import { BankStatus, type BankCoreDto } from "../../../types/payments/bank-registry/banks/bank.types";
import type { ActorMini, CountryCodes, PhoneNumber } from "../../../types/common";



export interface IBank extends Omit<BankCoreDto, 'createdAt' | 'updatedAt'> {
  _id: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

export class FlagsSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<{ png: string; svg: string; alt?: string; }> {
    return new Schema<{ png: string; svg: string; alt?: string; }>(
      {
        png: { type: String, required: true, default: "" },
        svg: { type: String, required: true, default: "" },
        alt: { type: String, required: false, default: "" },
      },
      { _id: false }
    );
  }
}

export class CountryCodeSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<CountryCodes> {
    return new Schema<CountryCodes>(
      {
        name: { type: String, required: true, default: "", trim: true },
        code: { type: String, required: true, default: "", trim: true },
        flags: { type: FlagsSubSchemaBuilder.buildSchema(), required: true },
      },
      { _id: false }
    );
  }
}

export class PhoneNumberSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<PhoneNumber> {
    return new Schema<PhoneNumber>(
      {
        code: { type: CountryCodeSubSchemaBuilder.buildSchema(), required: true },
        number: { type: String, required: true, default: "", trim: true },
      },
      { _id: false }
    );
  }
}

export class BankModelProvider {
  /**
   * Build and return the Bank mongoose model.
   *
   * @param options.modelName
   * - Expected: A stable name like "Bank"
   * - Default: "Bank"
   *
   * @param options.collectionName
   * - Expected: Mongo collection name
   * - Default: "banks"
   *
   * Usage hint
   * - Prefer importing `BankModel` (exported below).
   */
  public static getModel( options?: {
    modelName?: string;
    collectionName?: string;
  } ): Model<IBank> {
    const modelName = options?.modelName ?? "Bank";
    const collectionName = options?.collectionName ?? "banks";

    if ( models[ modelName ] ) {
      return models[ modelName ] as Model<IBank>;
    }

    const ActorMiniSchema = new Schema<ActorMini>(
      {
        userId: { type: String, required: true, trim: true },
        username: { type: String, required: true, trim: true },
        role: { type: String, required: false, trim: true },
      },
      { _id: false }
    );

    const BankSchema = new Schema<IBank>(
      {
        bankId: { type: String, required: true, trim: true, index: true },
        companyId: { type: String, required: true, trim: true, index: true },

        name: { type: String, required: true, trim: true },
        countryCca2: { type: String, required: true, trim: true, index: true },

        bankCode: { type: String, required: false, trim: true, index: true },
        swiftBic: { type: String, required: false, trim: true, index: true },

        supportedCurrencyCodes: { type: [ String ], required: false, default: [] },

        addressLine1: { type: String, required: true, trim: true },
        addressLine2: { type: String, required: false, trim: true },
        city: { type: String, required: true, trim: true },
        district: { type: String, required: true, trim: true },
        province: { type: String, required: true, trim: true },
        postalCode: { type: String, required: true, trim: true },
        phone: { type: PhoneNumberSubSchemaBuilder.buildSchema(), required: true },

        notes: {type: String, trim: true, required: false, default: ''},

        status: {
          type: String,
          required: true,
          enum: Object.values( BankStatus ),
          default: BankStatus.Active,
          index: true,
        },

        createdBy: { type: ActorMiniSchema, required: true },
        updatedBy: { type: ActorMiniSchema, required: false },
      },
      {
        timestamps: true,
        collection: collectionName,
      }
    );

    // Uniqueness inside company scope
    BankSchema.index( { companyId: 1, bankId: 1, bankCode: 1 }, { unique: true } );

    // Optional: avoid duplicate SWIFT within company (only when present)
    BankSchema.index(
      { companyId: 1, swiftBic: 1 },
      { unique: true, partialFilterExpression: { swiftBic: { $type: "string" } } }
    );

    return model<IBank>( modelName, BankSchema );
  }
}

export const BankModel = BankModelProvider.getModel();