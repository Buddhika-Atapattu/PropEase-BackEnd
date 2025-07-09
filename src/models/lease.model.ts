// models/lease.model.ts
// ======================= IMPORTS =======================
import mongoose, { Schema, Document } from "mongoose";

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

// General structure for property address
export interface Address {
  houseNumber: string;
  street: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  country: string;
}

// Geolocation details for Google Map integration
export interface GoogleMapLocation {
  lat: number;
  lng: number;
  embeddedUrl: string;
}

// Information about who added the property/lease
export interface AddedBy {
  username: string;
  name: string;
  email: string;
  role: "admin" | "agent" | "owner" | string;
  contactNumber?: string;
  addedAt: Date | string | null;
}

// Full metadata of countries (used in properties)
export interface CountryDetails {
  name: {
    common: string; // Commonly used name (e.g., "Eritrea")
    official: string; // Official full name
    nativeName?: {
      [langCode: string]: {
        official: string;
        common: string;
      };
    };
  };
  tld?: string[]; // Top-level domain (e.g., [".er"])
  cca2: string; // ISO 3166-1 alpha-2 country code (e.g., "ER")
  cca3?: string; // ISO 3166-1 alpha-3 code
  ccn3?: string; // ISO numeric country code
  cioc?: string; // International Olympic Committee code
  independent?: boolean;
  status?: string;
  unMember?: boolean;

  currencies?: {
    [code: string]: {
      name: string; // Currency name (e.g., "Eritrean nakfa")
      symbol: string; // Currency symbol (e.g., "Nfk")
    };
  };

  idd?: {
    root: string; // Phone code root (e.g., "+2")
    suffixes: string[]; // List of suffixes (e.g., ["91"])
  };

  capital?: string[]; // Capital city (e.g., ["Asmara"])
  altSpellings?: string[]; // Other spellings
  region: string; // Continent or major region (e.g., "Africa")
  subregion?: string; // Subregion (e.g., "Eastern Africa")

  languages?: {
    [langCode: string]: string; // Language map (e.g., { "eng": "English" })
  };

  latlng: [number, number]; // Latitude and longitude
  landlocked?: boolean;
  borders?: string[]; // Bordering country codes
  area: number; // Total area in square kilometers

  demonyms?: {
    eng: { m: string; f: string }; // Demonyms in English
    [langCode: string]: { m: string; f: string };
  };

  translations?: {
    [langCode: string]: {
      official: string;
      common: string;
    };
  };

  flag?: string; // Emoji flag (e.g., 🇪🇷)
  flags: {
    png: string; // PNG flag image URL
    svg: string; // SVG flag image URL
    alt?: string; // Description of the flag
  };

  coatOfArms?: {
    png?: string;
    svg?: string;
  };

  maps?: {
    googleMaps: string;
    openStreetMaps: string;
  };

  population: number;
  fifa?: string;
  car?: {
    signs: string[];
    side: "left" | "right";
  };

  timezones: string[]; // Timezones (e.g., ["UTC+03:00"])
  continents: string[]; // Continent list (e.g., ["Africa"])

  startOfWeek?: string; // "monday", "sunday", etc.

  capitalInfo?: {
    latlng: [number, number];
  };

  postalCode?: {
    format?: string;
    regex?: string;
  };
}

// Property Images
export interface propertyImages {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  imageURL: string;
}

// Property Documents
export interface propertyDoc {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  documentURL: string;
}

// Property Details
export interface Property {
  // Basic Property Details
  id: string;
  title: string;
  type:
    | "Apartment"
    | "House"
    | "Villa"
    | "Commercial"
    | "Land"
    | "Stodio"
    | string;
  listing: "Sale" | "Rent" | "Sold" | "Rented" | string;
  description: string;
  // End Basic Property Details

  // Location Details
  countryDetails: CountryDetails;
  address: Address;
  location?: GoogleMapLocation;
  // End Location Details

  // Property Specifications
  totalArea: number; // in square feet or meters
  builtInArea: number; // in square feet or meters
  livingRooms: number;
  balconies: number;
  kitchen: number;
  bedrooms: number;
  bathrooms: number;
  maidrooms: number;
  driverRooms: number;
  furnishingStatus: "Furnished" | "Semi-Furnished" | "Unfurnished" | string;
  totalFloors: number;
  numberOfParking: number;
  // End Property Specifications

  // Construction & Age
  builtYear: number;
  propertyCondition:
    | "New"
    | "Old"
    | "Excellent"
    | "Good"
    | "Needs Renovation"
    | string;
  developerName: string;
  projectName?: string;
  ownerShipType: "Freehold" | "Leasehold" | "Company" | "Trust" | string;
  // End Construction & Age

  // Financial Details
  price: number;
  currency: string;
  pricePerSqurFeet: number;
  expectedRentYearly?: number;
  expectedRentQuartely?: number;
  expectedRentMonthly?: number;
  expectedRentDaily?: number;
  maintenanceFees: number;
  serviceCharges: number;
  transferFees?: number;
  availabilityStatus:
    | "Available"
    | "Not Available"
    | "Pending"
    | "Ready to Move"
    | string;
  // End Financial Details

  // Features & Amenities
  featuresAndAmenities: string[];
  // End Features & Amenities

  // Media
  images: propertyImages[];
  documents: propertyDoc[];
  videoTour?: string;
  virtualTour?: string;
  // End Media

  // Listing Management
  listingDate: Date | null;
  availabilityDate?: Date | null;
  listingExpiryDate?: Date | null;
  rentedDate?: Date | null;
  soldDate?: Date | null;
  addedBy: AddedBy;
  owner: string;
  // End Listing Management

  // Administrative & Internal Use
  referenceCode: string;
  verificationStatus: "Pending" | "Verified" | "Rejected" | "Approved";
  priority: "High" | "Medium" | "Low";
  status: "Draft" | "Published" | "Archived";
  internalNote: string;
  // End Administrative & Internal Use
}

// Emergency Contact Format For The Lease Agreement
export interface EmergencyContact {
  name: string;
  relationship?: string;
  contact: string;
}

// Currency Format For The Lease Agreement
export interface CurrencyFormat {
  country: string;
  symbol: any;
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
  unit: "day" | "week" | "month" | "year" | "one-time";
}

// Payment Method Format For The Lease Agreement
export interface PaymentMethod {
  id: string; // Unique identifier
  name: string; // Display name
  category: "card" | "wallet" | "bank" | "gateway" | "cash" | "crypto" | "bnpl";
  region?: string; // Optional region or origin (e.g., EU, US, Asia)
  supported?: boolean; // Can be used to toggle availability
}

// Security Deposit Fromat For The Lease Agreement
export interface SecurityDeposit {
  id: string;
  type: "fixed" | "percentage" | "duration";
  value: number;
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
  type: "fixed" | "percentage" | "per-day"; // Type of penalty calculation
  value: number; // Amount, %, or per-day fee
  description: string; // Explanation for user/admin
  isEditable?: boolean;
}

// Utilities Format For The Lease Agreement
export interface UtilityResponsibility {
  id: string;
  utility: string; // e.g., "Electricity", "Water"
  paidBy: "landlord" | "tenant" | "shared" | "real estate company";
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
  startDate: string; // ISO format
  endDate: string;
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
  validationStatus: "Pending" | "Validated" | "Rejected";
  language: string;
  leaseTemplateVersion: string;
  pdfDownloadUrl?: string;
  lastUpdated: string; // ISO timestamp
}

export interface LeasePayload {
  leaseID: string;
  tenantInformation: TenantInformation;
  coTenant?: CoTenant;
  propertyInformation: Property;
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
  propertyInformation: Property;
  leaseAgreement: LeaseAgreement;
  rulesAndRegulations: RulesAndRegulations[];
  isReadTheCompanyPolicy: boolean;
  signatures: Signatures;
  systemMetadata: SystemMetadata;
}

//<============================================================= Reusable Subschemas =============================================================>
// FileSchema (for FILE interface)
const FileSchema = new Schema({
  fieldname: { type: String, required: true },
  originalname: { type: String, required: true },
  mimetype: { type: String, required: true },
  size: { type: Number, required: true },
  filename: { type: String, required: true },
  URL: { type: String, required: true },
});

// TokenViceDataSchema (for TokenViceData interface)
const TokenViceDataSchema = new Schema({
  ageInMinutes: { type: Number, required: true },
  date: { type: String, required: true },
  file: { type: FileSchema, required: true },
  token: { type: String, required: true },
  folder: { type: String, required: true },
});

// ScannedFileRecordSchema (for ScannedFileRecordJSON interface)
const ScannedFileRecordSchema = new Schema({
  date: { type: String, required: true }, // ISO date
  tenant: { type: String, required: true },
  token: { type: String, required: true },
  files: { type: [TokenViceDataSchema], default: [] },
  folder: { type: String, required: true },
});

// Address Schema
const AddressSchema = new Schema({
  houseNumber: { type: String, required: true },
  street: { type: String, required: true },
  city: { type: String, required: true },
  stateOrProvince: { type: String, required: true },
  postalCode: { type: String, required: true },
  country: { type: String, required: true },
});

// Google Map Location Schema
const GoogleMapLocationSchema = new mongoose.Schema({
  lat: { type: Number, required: true, default: 0 },
  lng: { type: Number, required: true, default: 0 },
  embeddedUrl: { type: String, required: true, default: "" },
});

// AddedBy Schema
const AddedBySchema = new mongoose.Schema({
  username: { type: String, required: true, default: "" },
  name: { type: String, required: true, default: "" },
  email: { type: String, required: true, default: "" },
  role: { type: String, required: true, default: "" },
  contactNumber: { type: String, required: false, default: "" },
  addedAt: { type: String, required: false, default: "" },
});

// CountryDetails Schema
const CountryDetailsSchema = new mongoose.Schema({
  name: {
    common: { type: String, required: true, default: "" },
    official: { type: String, required: true, default: "" },
    nativeName: {
      type: Map,
      of: new mongoose.Schema({
        official: { type: String, required: true, default: "" },
        common: { type: String, required: true, default: "" },
      }),
      required: false,
      default: {},
    },
  },
  tld: { type: [String], required: false, default: [] },
  cca2: { type: String, required: true, default: "" },
  cca3: { type: String, required: false, default: "" },
  ccn3: { type: String, required: false, default: "" },
  cioc: { type: String, required: false, default: "" },
  independent: { type: Boolean, required: false, default: false },
  status: { type: String, required: false, default: "" },
  unMember: { type: Boolean, required: false, default: false },
  currencies: {
    type: Map,
    of: new mongoose.Schema({
      name: { type: String, required: true, default: "" },
      symbol: { type: String, required: true, default: "" },
    }),
    required: false,
    default: {},
  },
  idd: {
    root: { type: String, required: false, default: "" },
    suffixes: { type: [String], required: false, default: [] },
  },
  capital: { type: [String], required: false, default: [] },
  altSpellings: { type: [String], required: false, default: [] },
  region: { type: String, required: true, default: "" },
  subregion: { type: String, required: false, default: "" },
  languages: {
    type: Map,
    of: { type: String, required: true, default: "" },
    required: false,
    default: {},
  },
  latlng: { type: [Number], required: true, default: [0, 0] },
  landlocked: { type: Boolean, required: false, default: false },
  borders: { type: [String], required: false, default: [] },
  area: { type: Number, required: true, default: 0 },
  demonyms: {
    type: Map,
    of: new mongoose.Schema({
      m: { type: String, required: true, default: "" },
      f: { type: String, required: true, default: "" },
    }),
    required: false,
    default: {},
  },
  translations: {
    type: Map,
    of: new mongoose.Schema({
      official: { type: String, required: true, default: "" },
      common: { type: String, required: true, default: "" },
    }),
    required: false,
    default: {},
  },
  flag: { type: String, required: false, default: "" },
  flags: {
    png: { type: String, required: true, default: "" },
    svg: { type: String, required: true, default: "" },
    alt: { type: String, required: false, default: "" },
  },
  coatOfArms: {
    png: { type: String, required: false, default: "" },
    svg: { type: String, required: false, default: "" },
  },
  maps: {
    googleMaps: { type: String, required: false, default: "" },
    openStreetMaps: { type: String, required: false, default: "" },
  },
  population: { type: Number, required: false, default: 0 },
  fifa: { type: String, required: false, default: "" },
  car: {
    signs: { type: [String], required: false, default: [] },
    side: { type: String, required: false, default: "" },
  },
  timezones: { type: [String], required: true, default: [] },
  continents: { type: [String], required: true, default: [] },
  startOfWeek: { type: String, required: false, default: "" },
  capitalInfo: {
    latlng: { type: [Number], required: false, default: [0, 0] },
  },
  postalCode: {
    format: { type: String, required: false, default: "" },
    regex: { type: String, required: false, default: "" },
  },
});

// Property Image Schema
const PropertyImageSchema = new mongoose.Schema({
  originalname: { type: String, required: true, default: "" },
  filename: { type: String, required: true, default: "" },
  mimetype: { type: String, required: true, default: "" },
  size: { type: Number, required: true, default: 0 },
  imageURL: { type: String, required: true, default: "" },
});

// Property Document Schema
const PropertyDocSchema = new mongoose.Schema({
  originalname: { type: String, required: true, default: "" },
  filename: { type: String, required: true, default: "" },
  mimetype: { type: String, required: true, default: "" },
  size: { type: Number, required: true, default: 0 },
  documentURL: { type: String, required: true, default: "" },
});

// Property Schema
const PropertySchema = new mongoose.Schema({
  id: { type: String, required: true, default: "" },
  title: { type: String, required: true, default: "" },
  type: { type: String, required: true, default: "" },
  listing: { type: String, required: true, default: "" },
  description: { type: String, required: true, default: "" },
  countryDetails: { type: CountryDetailsSchema, required: true, default: {} },
  address: { type: AddressSchema, required: true, default: {} },
  location: { type: GoogleMapLocationSchema, required: false, default: {} },
  totalArea: { type: Number, required: true, default: 0 },
  builtInArea: { type: Number, required: true, default: 0 },
  livingRooms: { type: Number, required: true, default: 0 },
  balconies: { type: Number, required: true, default: 0 },
  kitchen: { type: Number, required: true, default: 0 },
  bedrooms: { type: Number, required: true, default: 0 },
  bathrooms: { type: Number, required: true, default: 0 },
  maidrooms: { type: Number, required: true, default: 0 },
  driverRooms: { type: Number, required: true, default: 0 },
  furnishingStatus: { type: String, required: true, default: "" },
  totalFloors: { type: Number, required: true, default: 0 },
  numberOfParking: { type: Number, required: true, default: 0 },
  builtYear: { type: Number, required: true, default: 0 },
  propertyCondition: { type: String, required: true, default: "" },
  developerName: { type: String, required: true, default: "" },
  projectName: { type: String, required: false, default: "" },
  ownerShipType: { type: String, required: true, default: "" },
  price: { type: Number, required: true, default: 0 },
  currency: { type: String, required: true, default: "" },
  pricePerSqurFeet: { type: Number, required: true, default: 0 },
  expectedRentYearly: { type: Number, required: false, default: 0 },
  expectedRentQuartely: { type: Number, required: false, default: 0 },
  expectedRentMonthly: { type: Number, required: false, default: 0 },
  expectedRentDaily: { type: Number, required: false, default: 0 },
  maintenanceFees: { type: Number, required: true, default: 0 },
  serviceCharges: { type: Number, required: true, default: 0 },
  transferFees: { type: Number, required: false, default: 0 },
  availabilityStatus: { type: String, required: true, default: "" },
  featuresAndAmenities: { type: [String], required: true, default: [] },
  images: { type: [PropertyImageSchema], required: true, default: [] },
  documents: { type: [PropertyDocSchema], required: true, default: [] },
  videoTour: { type: String, required: false, default: "" },
  virtualTour: { type: String, required: false, default: "" },
  listingDate: { type: Date, required: false, default: null },
  availabilityDate: { type: Date, required: false, default: null },
  listingExpiryDate: { type: Date, required: false, default: null },
  rentedDate: { type: Date, required: false, default: null },
  soldDate: { type: Date, required: false, default: null },
  addedBy: { type: AddedBySchema, required: true, default: {} },
  owner: { type: String, required: true, default: "" },
  referenceCode: { type: String, required: true, default: "" },
  verificationStatus: { type: String, required: true, default: "" },
  priority: { type: String, required: true, default: "" },
  status: { type: String, required: true, default: "" },
  internalNote: { type: String, required: true, default: "" },
});

const EmergencyContactSchema = new Schema({
  name: { type: String, required: true },
  relationship: { type: String, required: false },
  contact: { type: String, required: true },
});

const CurrencyFormatSchema = new Schema({
  country: { type: String, required: true },
  symbol: Schema.Types.Mixed,
  flags: {
    png: { type: String, required: true },
    svg: { type: String, required: true },
    alt: { type: String, required: true },
  },
  currency: { type: String, required: true },
});

const PaymentFrequencySchema = new Schema({
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

const PaymentMethodSchema = new Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  category: {
    type: String,
    enum: ["card", "wallet", "bank", "gateway", "cash", "crypto", "bnpl"],
    required: true,
  },
  region: { type: String, required: true },
  supported: { type: Boolean, required: true, default: false },
});

const SecurityDepositSchema = new Schema({
  id: { type: String, required: true },
  type: {
    type: String,
    enum: ["fixed", "percentage", "duration"],
    required: true,
  },
  value: { type: Number, required: true, default: 0 },
  refundable: { type: Boolean, required: true, default: false },
});

const RentDueDateSchema = new Schema({
  id: { type: String, required: true },
  label: { type: String, required: true },
  day: { type: Number, required: true, default: 0 },
  offsetDays: { type: Number, required: true, default: 0 },
  description: { type: String, required: true },
});

const LatePaymentPenaltySchema = new Schema({
  label: { type: String, required: true },
  type: { type: String, required: true },
  value: { type: Number, required: true, default: 0 },
  description: { type: String, required: true },
  isEditable: { type: Boolean, required: false, default: false },
});

const UtilityResponsibilitySchema = new Schema({
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

const NoticePeriodSchema = new Schema({
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

const CountryCodeSchema = new Schema({
  name: { type: String, required: true },
  code: { type: String, required: true },
  flags: { type: FlagSchema, required: true, default: {} },
});

const LeaseAgreementSchema = new Schema({
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
  latePaymentPenalty: [
    { type: LatePaymentPenaltySchema, required: true, default: [] },
  ],
  utilityResponsibilities: [
    { type: UtilityResponsibilitySchema, required: true, default: [] },
  ],
  noticePeriodDays: { type: NoticePeriodSchema, required: true, default: {} },
});

const TenantInformationSchema = new Schema({
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

const CoTenantSchema = new Schema({
  fullName: { type: String, required: false },
  email: { type: String, required: false },
  phoneNumber: { type: String, required: false },
  phoneCode: { type: String, required: false },
  gender: { type: String, required: false },
  nicOrPassport: { type: String, required: false },
  age: { type: Number, required: false, default: 0 },
  relationship: { type: String, required: false },
});

const RulesAndRegulationsSchema = new Schema({
  rule: { type: String, required: true },
  description: { type: String, required: true },
  isEditable: { type: Boolean, required: false },
});

const SignaturesSchema = new Schema({
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

const SystemMetadataSchema = new Schema({
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

const LeaseSchema = new Schema(
  {
    leaseID: { type: String, required: true },
    tenantInformation: {
      type: TenantInformationSchema,
      required: true,
      default: {},
    },
    coTenants: CoTenantSchema,
    propertyInformation: {
      type: PropertySchema,
      required: true,
      default: {},
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
