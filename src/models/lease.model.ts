// models/lease.model.ts
// ======================= IMPORTS =======================
import mongoose, { Schema, Document } from "mongoose";
import { Property } from "./property.model";

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
  date: string;
  file: FILE;
  token: string;
  folder: string;
}

export interface ScannedFileRecordJSON {
  date: string; // ISO date string
  tenant: string;
  token: string;
  files: TokenViceData[];
  folder: string;
}

export interface TenantScannedFilesDataJSON {
  [tenantUsername: string]: ScannedFileRecordJSON[];
}

// Structure of country code info for phone numbers
export interface CountryCodes {
  name: string;
  code: string;
  flags: {
    png: string; // PNG flag image URL
    svg: string; // SVG flag image URL
    alt?: string; // Description of the flag
  };
}

export interface CountryDetails {
  name: string;
  code: string;
  emoji: string; // Emoji representation of the flag
  unicode: string;
  image: string;
}
export interface Address {
  houseNumber: string;
  street: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  country: CountryDetails; // Full country details object
}


// Tenant information details in lease agreement
export interface TenantInformation {
  tenantUsername: string;
  fullName: string;
  nicOrPassport: string;
  gender: string;
  nationality: string;
  dateOfBirth: Date; // ISO format: YYYY-MM-DD
  phoneCodeDetails: CountryCodes;
  phoneNumber: string;
  email: string;
  permanentAddress: Address;
  emergencyContact: EmergencyContact;
  scannedDocuments: ScannedFileRecordJSON[];
}

// Co-tenant structure if available
export interface CoTenant {
  fullName: string;
  email: string;
  phoneCode: string;
  phoneNumber: string;
  gender: string;
  nicOrPassport: string;
  age: number;
  relationship: string;
}

// Information about who added the property/lease
export interface AddedBy {
  username: string;
  name: string;
  email: string;
  role: "admin" | "agent" | "owner" | string | string;
  contactNumber?: string;
  addedAt: Date | string | null;
}

// Emergency Contact Format For The Lease Agreement
export interface EmergencyContact {
  name: string;
  relationship: string;
  contact: string;
}

// Currency Format For The Lease Agreement
export interface CurrencyFormat {
  country: string;
  symbol: string;
  flags: {
    png: string; // PNG flag image URL
    svg: string; // SVG flag image URL
    alt?: string; // Description of the flag
  };
  currency: string;
}

// Payment Frequency Fromat For The Lease Agreement
export interface PaymentFrequency {
  id: string; // Unique identifier
  name: string; // Human-readable label
  duration: string; // ISO-like duration string (e.g., "P1M" = 1 month)
  unit: string;
}

// Payment Method Format For The Lease Agreement
export interface PaymentMethod {
  id: string; // Unique identifier
  name: string; // Display name
  category: string;
  region?: string; // Optional region or origin (e.g., EU, US, Asia)
  supported?: boolean; // Can be used to toggle availability
  description?: string;
}

// Security Deposit Fromat For The Lease Agreement
export interface SecurityDeposit {
  id: string;
  name: string;
  description: string;
  refundable: boolean;
}

// Rental Due Date Format For The Lease Agreement
export interface RentDueDate {
  id: string;
  label: string;
  day?: number; // e.g., 1 for 1st of the month
  offsetDays?: number; // e.g., 5 for "5 days after invoice"
  description?: string;
}

// Late Payment Penalty Fromat For The Lease Agreement
export interface LatePaymentPenalty {
  label: string; // Displayed label in UI
  type: "fixed" | "percentage" | "per-day" | string; // Type of penalty calculation
  value: number; // Amount, %, or per-day fee
  description: string; // Explanation for user/admin
  isEditable?: boolean;
}

// Utilities Format For The Lease Agreement
export interface UtilityResponsibility {
  id: string;
  utility: string; // e.g., "Electricity", "Water"
  paidBy: "landlord" | "tenant" | "shared" | "real estate company" | string;
  description: string;
  isEditable?: boolean;
}

// Notice Period Format For The Lease Agreement
export interface NoticePeriod {
  id: string;
  label: string;
  days: number; // Number of days required to give notice
  description: string;
}

// Lease Agreement Format
export interface LeaseAgreement {
  startDate: Date; // ISO format
  endDate: Date;
  durationMonths: number;
  monthlyRent: number;
  currency: CurrencyFormat;
  paymentFrequency: PaymentFrequency;
  paymentMethod: PaymentMethod;
  securityDeposit: SecurityDeposit;
  rentDueDate: RentDueDate; // e.g., 5th of each month
  latePaymentPenalties: LatePaymentPenalty[]; // e.g., "LKR 500 per day"
  utilityResponsibilities: UtilityResponsibility[];
  noticePeriodDays: NoticePeriod;
}

// Rule And Regulations Format For The Lease Agreement
export interface RulesAndRegulations {
  rule: string;
  description: string;
  isEditable?: boolean;
}

// Signatures Format For The Lease Agreement
export interface Signatures {
  tenantSignature: FILE;
  landlordSignature: FILE;
  signedAt: Date; // ISO timestamp
  ipAddress: string;
  userAgent: AddedBy;
}

// System Metadata Format For The Lease Agreement
export interface SystemMetadata {
  ocrAutoFillStatus: boolean;
  validationStatus: string;
  language: string;
  leaseTemplateVersion: string;
  pdfDownloadUrl?: string;
  lastUpdated: string; // ISO timestamp
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

export interface LeasePayloadWithPropert {
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

// Lease Agreement Format
export interface LeaseType extends Document {
  leaseID: string;
  tenantInformation: TenantInformation;
  coTenant?: CoTenant; // Optional: empty if none
  propertyID: string;
  leaseAgreement: LeaseAgreement;
  rulesAndRegulations: RulesAndRegulations[];
  isReadTheCompanyPolicy: boolean;
  signatures: Signatures;
  systemMetadata: SystemMetadata;
}

//<============================================================= Reusable Subschemas =============================================================>
// FileSchema (for FILE interface)
const FileSchema = new Schema<FILE>({
  fieldname: { type: String, required: true },
  originalname: { type: String, required: true },
  mimetype: { type: String, required: true },
  size: { type: Number, required: true },
  filename: { type: String, required: true },
  URL: { type: String, required: true },
});

// TokenViceDataSchema (for TokenViceData interface)
const TokenViceDataSchema = new Schema<TokenViceData>({
  ageInMinutes: { type: Number, required: true },
  date: { type: String, required: true },
  file: { type: FileSchema, required: true },
  token: { type: String, required: true },
  folder: { type: String, required: true },
});

// ScannedFileRecordSchema (for ScannedFileRecordJSON interface)
const ScannedFileRecordSchema = new Schema<ScannedFileRecordJSON>({
  date: { type: String, required: true }, // ISO date
  tenant: { type: String, required: true },
  token: { type: String, required: true },
  files: { type: [TokenViceDataSchema], default: [] },
  folder: { type: String, required: true },
});


// AddedBy Schema
const AddedBySchema = new Schema<AddedBy>({
  username: String,
  name: String,
  email: String,
  role: String,
  contactNumber: String,
  addedAt: Date,
});

const EmergencyContactSchema = new Schema<EmergencyContact>({
  name: { type: String, required: true },
  relationship: { type: String, required: false },
  contact: { type: String, required: true },
});

const CurrencyFormatSchema = new Schema<CurrencyFormat>({
  country: { type: String, required: true },
  symbol: Schema.Types.Mixed,
  flags: {
    png: { type: String, required: true },
    svg: { type: String, required: true },
    alt: { type: String, required: true },
  },
  currency: { type: String, required: true },
});

const PaymentFrequencySchema = new Schema<PaymentFrequency>({
  id: { type: String, required: true },
  name: { type: String, required: true },
  duration: {
    type: String,
    required: true,
  },
  unit: {
    type: String,
    enum: ["day", "week", "month", "year", "one-time"],
    required: true,
  },
});

const PaymentMethodSchema = new Schema<PaymentMethod>({
  id: { type: String, required: true },
  name: { type: String, required: true },
  category: {
    type: String,
    required: true,
    default: '',
  },
  region: { type: String, required: true },
  supported: { type: Boolean, required: true, default: false },
  description: { type: String, required: false },
});

const SecurityDepositSchema = new Schema<SecurityDeposit>({
  id: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String, required: true, default: '' },
  refundable: { type: Boolean, required: true, default: false },
});

const RentDueDateSchema = new Schema<RentDueDate>({
  id: { type: String, required: true },
  label: { type: String, required: true },
  day: { type: Number, required: true, default: 0 },
  offsetDays: { type: Number, required: true, default: 0 },
  description: { type: String, required: true },
});

const LatePaymentPenaltySchema = new Schema<LatePaymentPenalty>({
  label: { type: String, required: true },
  type: { type: String, required: true },
  value: { type: Number, required: true, default: 0 },
  description: { type: String, required: true },
  isEditable: { type: Boolean, required: false, default: false },
});

const UtilityResponsibilitySchema = new Schema<UtilityResponsibility>({
  id: { type: String, required: true },
  utility: { type: String, required: true },
  paidBy: {
    type: String,
    enum: ["landlord", "tenant", "shared", "real estate company"],
    required: true,
  },
  description: { type: String, required: true },
  isEditable: { type: Boolean, required: false, default: false },
});

const NoticePeriodSchema = new Schema<NoticePeriod>({
  id: { type: String, required: true },
  label: { type: String, required: true },
  days: { type: Number, required: true, default: 0 },
  description: { type: String, required: true },
});

const FlagSchema = new Schema({
  png: { type: String, required: true },
  svg: { type: String, required: true },
  alt: { type: String, required: true },
});

const CountryCodeSchema = new Schema<CountryCodes>({
  name: { type: String, required: true },
  code: { type: String, required: true },
  flags: { type: FlagSchema, required: true, default: {} },
});

const LeaseAgreementSchema = new Schema<LeaseAgreement>({
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  durationMonths: { type: Number, required: true, default: 0 },
  monthlyRent: { type: Number, required: true, default: 0 },
  currency: { type: CurrencyFormatSchema, required: true, default: {} },
  paymentFrequency: {
    type: PaymentFrequencySchema,
    required: true,
    default: {},
  },
  paymentMethod: { type: PaymentMethodSchema, required: true, default: {} },
  securityDeposit: { type: SecurityDepositSchema, required: true, default: {} },
  rentDueDate: { type: RentDueDateSchema, required: true, default: {} },
  latePaymentPenalties: [
    { type: LatePaymentPenaltySchema, required: true, default: [] },
  ],
  utilityResponsibilities: [
    { type: UtilityResponsibilitySchema, required: true, default: [] },
  ],
  noticePeriodDays: { type: NoticePeriodSchema, required: true, default: {} },
});

const CountryDetailsSchema = new Schema<CountryDetails>({
  name: { type: String, required: true },
  code: { type: String, required: true },
  emoji: { type: String, required: true },
  unicode: { type: String, required: true },
  image: { type: String, required: true },
})

const AddressSchema = new Schema<Address>({
  street: { type: String, required: true },
  houseNumber: { type: String, required: true },
  city: { type: String, required: true },
  stateOrProvince: { type: String, required: true },
  postalCode: { type: String, required: true },
  country: { type: CountryDetailsSchema, required: true, default: {} },
});

const TenantInformationSchema = new Schema<TenantInformation>({
  tenantUsername: { type: String, required: true },
  fullName: { type: String, required: true },
  nicOrPassport: { type: String, required: true },
  gender: { type: String, required: true },
  nationality: { type: String, required: true },
  dateOfBirth: { type: Date, required: true, default: Date.now() },
  phoneCodeDetails: { type: CountryCodeSchema, required: true, default: {} },
  phoneNumber: { type: String, required: true },
  email: { type: String, required: true },
  permanentAddress: { type: AddressSchema, required: true, default: {} },
  emergencyContact: {
    type: EmergencyContactSchema,
    required: true,
    default: {},
  },
  scannedDocuments: [
    { type: [ScannedFileRecordSchema], required: true, default: [] },
  ],
});

const CoTenantSchema = new Schema<CoTenant>({
  fullName: { type: String, required: false },
  email: { type: String, required: false },
  phoneNumber: { type: String, required: false },
  phoneCode: { type: String, required: false },
  gender: { type: String, required: false },
  nicOrPassport: { type: String, required: false },
  age: { type: Number, required: false, default: 0 },
  relationship: { type: String, required: false },
});

const RulesAndRegulationsSchema = new Schema<RulesAndRegulations>({
  rule: { type: String, required: true },
  description: { type: String, required: true }
});

const SignaturesSchema = new Schema<Signatures>({
  tenantSignature: {
    type: FileSchema,
    required: true,
    default: {},
  },
  landlordSignature: {
    type: FileSchema,
    required: true,
    default: {},
  },
  signedAt: { type: Date, required: true, default: Date.now() },
  ipAddress: { type: String, required: true },
  userAgent: { type: AddedBySchema, required: true },
});

const SystemMetadataSchema = new Schema<SystemMetadata>({
  ocrAutoFillStatus: { type: Boolean, required: true, default: false },
  validationStatus: {
    type: String,
    enum: ["Pending", "Validated", "Rejected"],
    required: true,
  },
  language: { type: String, required: true },
  leaseTemplateVersion: { type: String, required: true },
  pdfDownloadUrl: { type: String, required: false },
  lastUpdated: { type: String, required: true },
});

const LeaseSchema = new Schema<LeaseType>(
  {
    leaseID: { type: String, required: true },
    tenantInformation: {
      type: TenantInformationSchema,
      required: true,
      default: {},
    },
    coTenant: { type: CoTenantSchema, required: false, default: {} },
    propertyID: {
      type: String,
      required: true,
      default: '',
    },
    leaseAgreement: { type: LeaseAgreementSchema, required: true, default: {} },
    rulesAndRegulations: {
      type: [RulesAndRegulationsSchema],
      required: true,
      default: [],
    },
    isReadTheCompanyPolicy: { type: Boolean, required: true, default: false },
    signatures: { type: SignaturesSchema, required: true, default: {} },
    systemMetadata: { type: SystemMetadataSchema, required: true, default: {} },
  },
  { timestamps: true }
);

export const LeaseModel = mongoose.model("Lease", LeaseSchema);
