// src/models/lease.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE: Lease model (types + DB schema only) in a class-based pattern.
// NOTE: No business logic here — controllers/services handle operations.
// ─────────────────────────────────────────────────────────────────────────────

import { Schema, model, type Document, type Model } from 'mongoose';
import type { Property } from './property.model'; // used in LeasePayloadWithProperty type

// ======================= DATA =======================
const VALIDATION_STATUSES = [
  // Initial states
  'draft',
  'pending',
  'waiting',
  'hold',
  'under review',
  'processing',

  // Approved / Completed
  'approved',
  'validated',
  'reviewed',
  'completed',
  'active',

  // Rejections and Failures
  'rejected',
  'cancelled',
  'cancel',
  'flagged',

  // Inactive / Suspended
  'inactive',
  'deactivated',
  'deactive',
  'suspended',
  'expired',

  // Archived
  'archived',
] as const;

// ======================= INTERFACES =======================

export interface FILE {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  filename: string;
  URL: string;
}

export interface TokenViceData {
  ageInMinutes: number;
  file: FILE;
}

export interface ScannedFileRecordJSON {
  date: string; // ISO date string
  tenant: string;
  token: string;
  files: TokenViceData[];
}

// Country code info for phone numbers
export interface CountryCodes {
  name: string;
  code: string;
  flags: {
    png: string;
    svg: string;
    alt?: string;
  };
}

export interface CountryDetails {
  name: string;
  code: string;
  emoji: string;
  unicode: string;
  image: string;
}

export interface Address {
  houseNumber: string;
  street: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  country: CountryDetails;
}

// Tenant details in lease agreement
export interface TenantInformation {
  tenantUsername: string;
  fullName: string;
  nicOrPassport: string;
  gender: string;
  nationality: string;
  dateOfBirth: Date | string; // ISO
  phoneCodeDetails: CountryCodes;
  phoneNumber: string;
  email: string;
  permanentAddress: Address;
  emergencyContact: EmergencyContact;
  scannedDocuments: ScannedFileRecordJSON[];
}

// Co-tenant (optional)
export interface CoTenant {
  fullName: string;
  email: string;
  phoneCodeDetails: CountryCodes;
  phoneNumber: string;
  gender: string;
  nicOrPassport: string;
  age: number;
  relationship: string;
}

// Actor who added the record
export interface AddedBy {
  username: string;
  name: string;
  email: string;
  role: 'admin' | 'agent' | 'owner' | string | string;
  contactNumber?: string;
  addedAt: Date | string | null;
}

export interface EmergencyContact {
  name: string;
  relationship: string;
  contact: string;
}

export interface CurrencyFormat {
  country: string;
  symbol: string;
  flags: {
    png: string;
    svg: string;
    alt?: string;
  };
  currency: string;
}

export interface PaymentFrequency {
  id: string;
  name: string;
  duration: string;
  unit: string;
}

export interface PaymentMethod {
  id: string;
  name: string;
  category: string;
  region?: string;
  supported?: boolean;
  description?: string;
}

export interface SecurityDeposit {
  id: string;
  name: string;
  description: string;
  refundable: boolean;
}

export interface RentDueDate {
  id: string;
  label: string;
  day?: number;
  offsetDays?: number;
  description?: string;
}

export interface LatePaymentPenalty {
  label: string;
  type: 'fixed' | 'percentage' | 'per-day' | string;
  value: number;
  description: string;
  isEditable?: boolean;
}

export interface UtilityResponsibility {
  id: string;
  utility: string;
  paidBy: 'landlord' | 'tenant' | 'shared' | 'real estate company' | string;
  description: string;
  isEditable?: boolean;
}

export interface NoticePeriod {
  id: string;
  label: string;
  days: number;
  description: string;
}

export interface LeaseAgreement {
  startDate: Date | string;
  endDate: Date | string;
  durationMonths: number;
  monthlyRent: number;
  currency: CurrencyFormat;
  paymentFrequency: PaymentFrequency;
  paymentMethod: PaymentMethod;
  securityDeposit: SecurityDeposit;
  rentDueDate: RentDueDate;
  latePaymentPenalties: LatePaymentPenalty[];
  utilityResponsibilities: UtilityResponsibility[];
  noticePeriodDays: NoticePeriod;
}

export interface RulesAndRegulations {
  rule: string;
  description: string;
  isEditable?: boolean;
}

export interface Signatures {
  tenantSignature: FILE;
  landlordSignature: FILE;
  signedAt: Date | string;
  ipAddress: string;
  userAgent: AddedBy;
}

export interface SystemMetadata {
  ocrAutoFillStatus: boolean;
  validationStatus: typeof VALIDATION_STATUSES[ number ];
  language: string;
  leaseTemplateVersion: string;
  pdfDownloadUrl?: string;
  lastUpdated: string; // ISO
}

export interface LeasePayload {
  leaseID: string;
  tenantInformation: TenantInformation;
  coTenant?: CoTenant;
  propertyID: string;
  leaseAgreement: LeaseAgreement;
  rulesAndRegulations: RulesAndRegulations[];
  isReadTheCompanyPolicy: boolean;
  signatures: Signatures;
  systemMetadata: SystemMetadata;
}

export interface LeasePayloadWithProperty {
  leaseID: string;
  tenantInformation: TenantInformation;
  coTenant?: CoTenant;
  property: Property;
  leaseAgreement: LeaseAgreement;
  rulesAndRegulations: RulesAndRegulations[];
  isReadTheCompanyPolicy: boolean;
  signatures: Signatures;
  systemMetadata: SystemMetadata;
}

// DB document interface
export interface LeaseType extends Document {
  leaseID: string;
  tenantInformation: TenantInformation;
  coTenant?: CoTenant;
  propertyID: string;
  leaseAgreement: LeaseAgreement;
  rulesAndRegulations: RulesAndRegulations[];
  isReadTheCompanyPolicy: boolean;
  signatures: Signatures;
  systemMetadata: SystemMetadata;
  createdAt: Date;
  updatedAt: Date;
}

// ======================= CLASS-BASED MODEL =======================
export class LeaseModelBuilder {
  public static buildSchema(): Schema<LeaseType> {
    // Reusable sub-schemas
    const FileSchema = new Schema<FILE>( {
      fieldname: { type: String, required: true },
      originalname: { type: String, required: true },
      mimetype: { type: String, required: true },
      size: { type: Number, required: true },
      filename: { type: String, required: true },
      URL: { type: String, required: true },
    }, { _id: false } );

    const TokenViceDataSchema = new Schema<TokenViceData>( {
      ageInMinutes: { type: Number, required: true },
      file: { type: FileSchema, required: true },
    }, { _id: false } );

    const ScannedFileRecordSchema = new Schema<ScannedFileRecordJSON>( {
      date: { type: String, required: true },
      tenant: { type: String, required: true },
      token: { type: String, required: true },
      files: { type: [ TokenViceDataSchema ], default: [] },
    }, { _id: false } );

    const AddedBySchema = new Schema<AddedBy>( {
      username: String,
      name: String,
      email: String,
      role: String,
      contactNumber: String,
      addedAt: { type: Date },
    }, { _id: false } );

    const EmergencyContactSchema = new Schema<EmergencyContact>( {
      name: { type: String, required: true },
      relationship: { type: String, required: false },
      contact: { type: String, required: true },
    }, { _id: false } );

    const CurrencyFormatSchema = new Schema<CurrencyFormat>( {
      country: { type: String, required: true },
      // symbol is often string but your interface is string; Mixed kept if you sometimes pass non-string
      symbol: { type: Schema.Types.Mixed, required: true },
      flags: {
        png: { type: String, required: true },
        svg: { type: String, required: true },
        alt: { type: String, required: true },
      },
      currency: { type: String, required: true },
    }, { _id: false } );

    const PaymentFrequencySchema = new Schema<PaymentFrequency>( {
      id: { type: String, required: true },
      name: { type: String, required: true },
      duration: { type: String, required: true },
      unit: {
        type: String,
        enum: [ 'day', 'week', 'month', 'year', 'one-time' ],
        required: true,
      },
    }, { _id: false } );

    const PaymentMethodSchema = new Schema<PaymentMethod>( {
      id: { type: String, required: true },
      name: { type: String, required: true },
      category: { type: String, required: true, default: '' },
      region: { type: String },
      supported: { type: Boolean, default: false },
      description: { type: String },
    }, { _id: false } );

    const SecurityDepositSchema = new Schema<SecurityDeposit>( {
      id: { type: String, required: true },
      name: { type: String, required: true },
      description: { type: String, required: true, default: '' },
      refundable: { type: Boolean, required: true, default: false },
    }, { _id: false } );

    const RentDueDateSchema = new Schema<RentDueDate>( {
      id: { type: String, required: true },
      label: { type: String, required: true },
      day: { type: Number, required: true, default: 0 },
      offsetDays: { type: Number, required: true, default: 0 },
      description: { type: String, required: true },
    }, { _id: false } );

    const LatePaymentPenaltySchema = new Schema<LatePaymentPenalty>( {
      label: { type: String, required: true },
      type: { type: String, required: true },
      value: { type: Number, required: true, default: 0 },
      description: { type: String, required: true },
      isEditable: { type: Boolean, default: false },
    }, { _id: false } );

    const UtilityResponsibilitySchema = new Schema<UtilityResponsibility>( {
      id: { type: String, required: true },
      utility: { type: String, required: true },
      paidBy: {
        type: String,
        enum: [ 'landlord', 'tenant', 'shared', 'real estate company' ],
        required: true,
      },
      description: { type: String, required: true },
      isEditable: { type: Boolean, default: false },
    }, { _id: false } );

    const NoticePeriodSchema = new Schema<NoticePeriod>( {
      id: { type: String, required: true },
      label: { type: String, required: true },
      days: { type: Number, required: true, default: 0 },
      description: { type: String, required: true },
    }, { _id: false } );

    const FlagSchema = new Schema( {
      png: { type: String, required: true },
      svg: { type: String, required: true },
      alt: { type: String, required: true },
    }, { _id: false } );

    const CountryCodeSchema = new Schema<CountryCodes>( {
      name: { type: String, required: true },
      code: { type: String, required: true },
      flags: { type: FlagSchema, required: true, default: {} },
    }, { _id: false } );

    const CountryDetailsSchema = new Schema<CountryDetails>( {
      name: { type: String, required: true },
      code: { type: String, required: true },
      emoji: { type: String, required: true },
      unicode: { type: String, required: true },
      image: { type: String, required: true },
    }, { _id: false } );

    const AddressSchema = new Schema<Address>( {
      street: { type: String, required: true },
      houseNumber: { type: String, required: true },
      city: { type: String, required: true },
      stateOrProvince: { type: String, required: true },
      postalCode: { type: String, required: true },
      country: { type: CountryDetailsSchema, required: true, default: {} },
    }, { _id: false } );

    const LeaseAgreementSchema = new Schema<LeaseAgreement>( {
      startDate: { type: Date, required: true },
      endDate: { type: Date, required: true },
      durationMonths: { type: Number, required: true, default: 0 },
      monthlyRent: { type: Number, required: true, default: 0 },
      currency: { type: CurrencyFormatSchema, required: true, default: {} },
      paymentFrequency: { type: PaymentFrequencySchema, required: true, default: {} },
      paymentMethod: { type: PaymentMethodSchema, required: true, default: {} },
      securityDeposit: { type: SecurityDepositSchema, required: true, default: {} },
      rentDueDate: { type: RentDueDateSchema, required: true, default: {} },
      latePaymentPenalties: { type: [ LatePaymentPenaltySchema ], required: true, default: [] },
      utilityResponsibilities: { type: [ UtilityResponsibilitySchema ], required: true, default: [] },
      noticePeriodDays: { type: NoticePeriodSchema, required: true, default: {} },
    }, { _id: false } );

    const TenantInformationSchema = new Schema<TenantInformation>( {
      tenantUsername: { type: String, required: true },
      fullName: { type: String, required: true },
      nicOrPassport: { type: String, required: true },
      gender: { type: String, required: true },
      nationality: { type: String, required: true },
      // Use function form so the date is evaluated at insert-time
      dateOfBirth: { type: Date, required: true, default: Date.now },
      phoneCodeDetails: { type: CountryCodeSchema, required: true, default: {} },
      phoneNumber: { type: String, required: true },
      email: { type: String, required: true },
      permanentAddress: { type: AddressSchema, required: true, default: {} },
      emergencyContact: { type: EmergencyContactSchema, required: true, default: {} },
      // FIX: make it an array of subdocs (not an array-of-array)
      scannedDocuments: { type: [ ScannedFileRecordSchema ], required: true, default: [] },
    }, { _id: false } );

    const CoTenantSchema = new Schema<CoTenant>( {
      fullName: { type: String },
      email: { type: String },
      phoneNumber: { type: String },
      phoneCodeDetails: { type: CountryCodeSchema, default: {} },
      gender: { type: String },
      nicOrPassport: { type: String },
      age: { type: Number, default: 0 },
      relationship: { type: String },
    }, { _id: false } );

    const RulesAndRegulationsSchema = new Schema<RulesAndRegulations>( {
      rule: { type: String, required: true },
      description: { type: String, required: true },
      isEditable: { type: Boolean, default: false },
    }, { _id: false } );

    const SignaturesSchema = new Schema<Signatures>( {
      tenantSignature: { type: FileSchema, required: true, default: {} },
      landlordSignature: { type: FileSchema, required: true, default: {} },
      signedAt: { type: Date, required: true, default: Date.now },
      ipAddress: { type: String, required: true },
      userAgent: { type: AddedBySchema, required: true },
    }, { _id: false } );

    const SystemMetadataSchema = new Schema<SystemMetadata>( {
      ocrAutoFillStatus: { type: Boolean, required: true, default: false },
      validationStatus: { type: String, enum: VALIDATION_STATUSES, required: true },
      language: { type: String, required: true },
      leaseTemplateVersion: { type: String, required: true },
      pdfDownloadUrl: { type: String },
      lastUpdated: { type: String, required: true },
    }, { _id: false } );

    // Main schema
    const LeaseSchema = new Schema<LeaseType>(
      {
        leaseID: { type: String, required: true, index: true },
        tenantInformation: { type: TenantInformationSchema, required: true, default: {} },
        coTenant: { type: CoTenantSchema, default: {} },
        propertyID: { type: String, required: true, default: '' },
        leaseAgreement: { type: LeaseAgreementSchema, required: true, default: {} },
        rulesAndRegulations: { type: [ RulesAndRegulationsSchema ], required: true, default: [] },
        isReadTheCompanyPolicy: { type: Boolean, required: true, default: false },
        signatures: { type: SignaturesSchema, required: true, default: {} },
        systemMetadata: { type: SystemMetadataSchema, required: true, default: {} },
      },
      { timestamps: true }
    );

    return LeaseSchema;
  }

  public static getModel(): Model<LeaseType> {
    const schema = LeaseModelBuilder.buildSchema();
    // Explicit collection name for clarity/consistency
    return model<LeaseType>( 'Lease', schema, 'leases' );
  }
}

// Ready-to-use model export
export const LeaseModel = LeaseModelBuilder.getModel();
