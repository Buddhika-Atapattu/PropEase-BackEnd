// Path: src/models/payment/payment.model.ts
// =============================================================================
// PaymentDbModel (Class-based Mongoose Model)
// -----------------------------------------------------------------------------
// 01. Introduction
// - Encapsulates Mongoose Schema + Model inside a class (no function exports).
// - Provides a single, stable access point: PaymentDbModel.Model
//
// 02. Important matters
// - Schema mirrors DTO/common types (Address, PhoneNumber, CountryCodes) to avoid drift.
// - Indexes are defined here (target.module + target.refId, status + createdAt).
// - Use PaymentDbModel.Model everywhere (service/controller), never create new models.
//
// 03. Why we make this class
// - Enforces consistent architecture and avoids accidental multiple model registration.
// - Makes the model layer “injectable” later if you move to multi-tenant DBs.
//
// 04. Parameters
// - None (static model holder)
// 05. Usage hint
// - const doc = await PaymentDbModel.Model.create(...)
// 06. Keep in mind
// - Call PaymentDbModel.Model only after mongoose connection is established.
// =============================================================================

import { Schema, model, type InferSchemaType, type Model } from "mongoose";
import type { Address, PhoneNumber } from "../../types/common";
import type {
  InvoiceLineDto,
  InvoicePartyDto,
  InvoiceSnapshotDto,
  MoneyDto,
  PaymentMethod,
  PaymentStatus, 
  PaymentTargetModule, 
  PaymentTargetRef
} from "../../types/payment/payment.types";

export interface PaymentMongoDoc {
  invoiceNo: string;
  status: PaymentStatus;

  target: PaymentTargetRef;
  money: MoneyDto;
  method: PaymentMethod;

  paidAt?: string;

  invoiceSnapshot: InvoiceSnapshotDto;

  tags?: string[];

  createdAt: Date;
  updatedAt: Date;
}

export class PaymentDbModel {
  // ---------------------------------------------------------------------------
  // 1) Shared (common.ts) shapes: CountryCodes, PhoneNumber, Address
  // ---------------------------------------------------------------------------

  private static readonly CountryCodesSchema = new Schema<PhoneNumber['code']>(
    {
      name: { type: String, required: true },
      code: { type: String, required: true },
      flags: {
        png: { type: String, required: true },
        svg: { type: String, required: true },
        alt: { type: String, required: false },
      },
    },
    { _id: false }
  );

  private static readonly PhoneNumberSchema = new Schema<PhoneNumber>(
    {
      code: { type: PaymentDbModel.CountryCodesSchema, required: true },
      number: { type: String, required: true },
    },
    { _id: false }
  );

  private static readonly AddressSchema = new Schema<Address>(
    {
      houseNumber: { type: String, required: true },
      street: { type: String, required: true },
      city: { type: String, required: true },
      stateOrProvince: { type: String, required: true },
      postcode: { type: String, required: true },
      country: { type: String, required: true },
    },
    { _id: false }
  );

  // ---------------------------------------------------------------------------
  // 2) Payment shapes
  // ---------------------------------------------------------------------------

  private static readonly PaymentTargetSchema = new Schema<PaymentTargetModule>(
    {
      module: { type: String, required: true },
      sectionKey: { type: String, required: true },
      refId: { type: String, required: true },
    },
    { _id: false }
  );

  private static readonly MoneySchema = new Schema(
    {
      amount: { type: Number, required: true },
      currency: { type: String, required: true },
    },
    { _id: false }
  );

  private static readonly InvoicePartySchema = new Schema<InvoicePartyDto>(
    {
      name: { type: String, required: true },
      address: { type: PaymentDbModel.AddressSchema, required: true },
      phone: { type: PaymentDbModel.PhoneNumberSchema, required: false },
      email: { type: String, required: false },
      taxId: { type: String, required: false },
    },
    { _id: false }
  );

  private static readonly InvoiceLineSchema = new Schema<InvoiceLineDto>(
    {
      label: { type: String, required: true },
      qty: { type: Number, required: true },
      unitPrice: { type: Number, required: true },
      lineTotal: { type: Number, required: true },
    },
    { _id: false }
  );

  private static readonly InvoiceSnapshotSchema = new Schema<InvoiceSnapshotDto>(
    {
      invoiceNo: { type: String, required: true },
      issuedAt: { type: String, required: true },
      billedTo: { type: PaymentDbModel.InvoicePartySchema, required: true },
      issuedBy: { type: PaymentDbModel.InvoicePartySchema, required: true },
      lines: { type: [PaymentDbModel.InvoiceLineSchema], required: true },
      subTotal: { type: Number, required: true },
      discountTotal: { type: Number, required: true },
      taxTotal: { type: Number, required: true },
      grandTotal: { type: Number, required: true },
      notes: { type: String, required: false },
    },
    { _id: false }
  );

  private static readonly PaymentSchema = new Schema<PaymentMongoDoc>(
    {
      invoiceNo: { type: String, required: true, unique: true },
      status: { type: String, required: true },

      target: { type: PaymentDbModel.PaymentTargetSchema, required: true },
      money: { type: PaymentDbModel.MoneySchema, required: true },
      method: { type: String, required: true },

      paidAt: { type: String, required: false },

      invoiceSnapshot: { type: PaymentDbModel.InvoiceSnapshotSchema, required: true },

      tags: { type: [String], required: false },
    },
    { timestamps: true, _id: true }
  );

  // Apply indexes once
  private static readonly _indexApplied: boolean = PaymentDbModel.applyIndexes();

  private static applyIndexes(): boolean {
    PaymentDbModel.PaymentSchema.index({ "target.module": 1, "target.refId": 1 });
    PaymentDbModel.PaymentSchema.index({ status: 1, createdAt: -1 });
    return true;
  }

  // ---------------------------------------------------------------------------
  // 3) Public typing + model accessor
  // ---------------------------------------------------------------------------

  public static readonly CollectionName = "Payment";

  public static get Model(): Model<PaymentDoc> {
    // Mongoose caches models by name. Using a getter keeps it class-based and stable.
    return model<PaymentDoc>(PaymentDbModel.CollectionName, PaymentDbModel.PaymentSchema);
  }
}

export type PaymentDoc = InferSchemaType<typeof PaymentDbModel["PaymentSchema"]>;

export const PaymentModel: Model<PaymentDoc> = PaymentDbModel.Model;

// =============================================================================
// 4) DTO shapes (mirrored in the schema above)
// - These are the shapes used in service/controller layers and must be kept in sync with the schema.
// - They are defined here for simplicity, but can be moved to separate files if needed.
// - target.module is a fixed set of strings representing different modules (lease, utility, etc).
// - target.refId must be the unique ID of the target section (ex: leaseID).
// =============================================================================