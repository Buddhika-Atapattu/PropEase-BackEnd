// File: src/models/property.model.ts
// =============================================================================
// Property Model (Mongoose + TypeScript) with helpful Virtuals
// -----------------------------------------------------------------------------
// This file defines:
//   1) TypeScript interfaces for strong typing
//   2) Mongoose subdocument schemas
//   3) The main Property schema + indexes
//   4) Handy VIRTUALS (computed fields) like fullAddress, mainImageURL, etc.
//   5) Model export
//
// NOTE: Virtuals are computed on-the-fly and NOT stored in MongoDB.
//       We enable them in JSON/object output so your API consumers see them.
// =============================================================================

import {Schema, model, Document} from "mongoose";

// =============================================================================
// 1) TypeScript Interfaces (Structure & Types)
// =============================================================================

/**
 * Small, reusable shapes for media and address.
 */
export interface propertyDocs {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  documentURL: string;
}

export interface propertyImages {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  imageURL: string;
}

export interface Address {
  houseNumber: string;
  street?: string;
  city: string;
  stateOrProvince?: string;
  postcode: string;
  country: string;
}

/**
 * CountryDetails mirrors the REST Countries API structure so you can store
 * rich, standardized country metadata along with a property.
 */
export interface CountryDetails {
  name: {
    common: string;
    official: string;
    nativeName?: {
      [langCode: string]: {
        official: string;
        common: string;
      };
    };
  };
  tld?: string[];
  cca2: string;
  cca3?: string;
  ccn3?: string;
  cioc?: string;
  independent?: boolean;
  status?: string;
  unMember?: boolean;
  currencies?: {
    [code: string]: {
      name: string;
      symbol: string;
    };
  };
  idd?: {
    root: string;
    suffixes: string[];
  };
  capital?: string[];
  altSpellings?: string[];
  region: string;
  subregion?: string;
  languages?: {[langCode: string]: string};
  latlng: [number, number];
  landlocked?: boolean;
  borders?: string[];
  area: number;
  demonyms?: {[langCode: string]: {m: string; f: string}};
  translations?: {[langCode: string]: {official: string; common: string}};
  flag?: string;
  flags: {png: string; svg: string; alt?: string};
  coatOfArms?: {png?: string; svg?: string};
  maps?: {googleMaps: string; openStreetMaps: string};
  population: number;
  fifa?: string;
  car?: {signs: string[]; side: "left" | "right"};
  timezones: string[];
  continents: string[];
  startOfWeek?: string;
  capitalInfo?: {latlng: [number, number]};
  postalCode?: {format?: string; regex?: string};
}

export interface AddedBy {
  username: string;
  name: string;
  email: string;
  role: "admin" | "agent" | "owner" | string;
  contactNumber?: string;
  addedAt: Date | string;
}

export interface GoogleMapLocation {
  lat: number;
  lng: number;
  embeddedUrl: string;
}

/**
 * Optional virtual (computed) fields we expose in responses.
 * They are not saved in MongoDB.
 */
export interface PropertyVirtuals {
  fullAddress?: string;
  mainImageURL?: string;
  pricePerSquareFoot?: number | null;
  pricePerSquareMeter?: number | null;
  isAvailable?: boolean;
  daysOnMarket?: number;
}

/**
 * IProperty: MongoDB document shape with Mongoose's Document mixed in.
 * Also includes the optional virtual fields for type safety when consuming.
 */
export interface IProperty extends Document, PropertyVirtuals {
  // --- Basic Property Details ---
  id: string;
  title: string;
  type:
  | "apartment"
  | "house"
  | "villa"
  | "commercial"
  | "land"
  | "studio"
  | string;
  listing: "sale" | "rent" | "sold" | "rented" | string;
  description: string;

  // --- Location ---
  countryDetails: CountryDetails;
  address: Address;
  location?: GoogleMapLocation;

  // --- Property Specs ---
  totalArea: number; // e.g. square feet (your app defines convention)
  builtInArea: number;
  livingRooms: number;
  balconies: number;
  kitchen: number;
  bedrooms: number;
  bathrooms: number;
  maidrooms: number;
  driverRooms: number;
  furnishingStatus: "furnished" | "semi-furnished" | "unfurnished" | string;
  totalFloors: number;
  numberOfParking: number;

  // --- Construction & Age ---
  builtYear: number;
  propertyCondition:
  | "new"
  | "old"
  | "excellent"
  | "good"
  | "needs renovation"
  | string;
  developerName: string;
  projectName?: string;
  ownerShipType: "freehold" | "leasehold" | "company" | "trust" | string;

  // --- Financial ---
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
  | "available"
  | "not available"
  | "pending"
  | "ready to move"
  | string;

  // --- Features & Amenities ---
  featuresAndAmenities: string[];

  // --- Media ---
  images: propertyImages[];
  uploadedImages?: propertyImages[];
  documents: propertyDocs[];
  uploadedDocuments?: propertyDocs[];
  videoTour?: string;
  virtualTour?: string;

  // --- Listing Management ---
  listingDate: Date;
  availabilityDate?: Date;
  listingExpiryDate?: Date;
  rentedDate?: Date;
  soldDate?: Date;
  addedBy: AddedBy;
  owner: string;

  // --- Admin/Internal ---
  referenceCode: string;
  verificationStatus: "pending" | "verified" | "rejected" | "approved";
  priority: "high" | "medium" | "low";
  status: "draft" | "published" | "archived";
  internalNote: string;
}

/**
 * Property: plain TypeScript version without Mongoose Document methods.
 * Useful for DTOs / non-DB logic.
 */
export interface Property extends Omit<IProperty, keyof Document> {}

// =============================================================================
// 2) Subdocument Schemas (reused inside the main schema)
// =============================================================================

const PropertyImageSchema = new Schema<propertyImages>({
  originalname: String,
  filename: String,
  mimetype: String,
  size: Number,
  imageURL: String,
});

const PropertyDocSchema = new Schema<propertyDocs>({
  originalname: String,
  filename: String,
  mimetype: String,
  size: Number,
  documentURL: String,
});

const AddressSchema = new Schema<Address>({
  houseNumber: String,
  street: String,
  city: String,
  stateOrProvince: String,
  postcode: String,
  country: String,
});

const CountryDetailsSchema = new Schema({
  name: {
    common: String,
    official: String,
    nativeName: Schema.Types.Mixed, // flexible for multi-language data
  },
  tld: [String],
  cca2: String,
  cca3: String,
  ccn3: String,
  cioc: String,
  independent: Boolean,
  status: String,
  unMember: Boolean,
  currencies: Schema.Types.Mixed,
  idd: {
    root: String,
    suffixes: [String],
  },
  capital: [String],
  altSpellings: [String],
  region: String,
  subregion: String,
  languages: Schema.Types.Mixed,
  latlng: [Number],
  landlocked: Boolean,
  borders: [String],
  area: Number,
  demonyms: Schema.Types.Mixed,
  translations: Schema.Types.Mixed,
  flag: String,
  flags: {
    png: String,
    svg: String,
    alt: String,
  },
  coatOfArms: {
    png: String,
    svg: String,
  },
  maps: {
    googleMaps: String,
    openStreetMaps: String,
  },
  population: Number,
  fifa: String,
  car: {
    signs: [String],
    side: String,
  },
  timezones: [String],
  continents: [String],
  startOfWeek: String,
  capitalInfo: {
    latlng: [Number],
  },
  postalCode: {
    format: String,
    regex: String,
  },
});

const AddedBySchema = new Schema<AddedBy>({
  username: String,
  name: String,
  email: String,
  role: String,
  contactNumber: String,
  addedAt: Date,
});

const GoogleMapLocationSchema = new Schema<GoogleMapLocation>({
  lat: Number,
  lng: Number,
  embeddedUrl: {type: String, required: false, default: ""},
});

// =============================================================================
// 3) Main Property Schema (with options to include virtuals)
// =============================================================================

const PropertySchema = new Schema<IProperty>(
  {
    // --- Basic Property Details ---
    id: {type: String, unique: true, required: true},
    title: {type: String, required: true, default: "Property Title"},
    type: {
      type: String,
      enum: ["apartment", "house", "villa", "commercial", "land", "studio"],
      required: true,
      default: "apartment",
    },
    listing: {
      type: String,
      enum: ["sale", "rent", "sold", "rented"],
      required: true,
      default: "sale",
    },
    description: {type: String, required: true, default: ""},

    // --- Location Details ---
    countryDetails: {type: CountryDetailsSchema, default: {}},
    address: {type: AddressSchema, default: {}},
    location: {type: GoogleMapLocationSchema, default: {}},

    // --- Property Specifications ---
    totalArea: {type: Number, required: true, default: 0},
    builtInArea: {type: Number, required: true, default: 0},
    livingRooms: {type: Number, required: true, default: 0},
    balconies: {type: Number, required: true, default: 0},
    kitchen: {type: Number, required: true, default: 0},
    bedrooms: {type: Number, required: true, default: 0},
    bathrooms: {type: Number, required: true, default: 0},
    maidrooms: {type: Number, required: true, default: 0},
    driverRooms: {type: Number, required: true, default: 0},
    furnishingStatus: {
      type: String,
      enum: ["furnished", "semi-furnished", "unfurnished"],
      required: true,
      default: "unfurnished",
    },
    totalFloors: {type: Number, required: true, default: 0},
    numberOfParking: {type: Number, required: true, default: 0},

    // --- Construction & Age ---
    builtYear: {type: Number, required: true, default: 0},
    propertyCondition: {
      type: String,
      enum: ["new", "old", "excellent", "good", "needs renovation"],
      required: true,
      default: "new",
    },
    developerName: {type: String, required: true, default: ""},
    projectName: {type: String, required: false, default: ""},
    ownerShipType: {
      type: String,
      required: true,
      enum: ["freehold", "leasehold", "company", "trust"],
      default: "freehold",
    },

    // --- Financial Details ---
    price: {type: Number, required: true, default: 0},
    currency: {type: String, required: true, default: "lkr"},
    pricePerSqurFeet: {type: Number, required: true, default: 0},
    expectedRentYearly: {type: Number, required: false, default: 0},
    expectedRentQuartely: {type: Number, required: false, default: 0},
    expectedRentMonthly: {type: Number, required: false, default: 0},
    expectedRentDaily: {type: Number, required: false, default: 0},
    maintenanceFees: {type: Number, required: true, default: 0},
    serviceCharges: {type: Number, required: true, default: 0},
    transferFees: {type: Number, required: false, default: 0},
    availabilityStatus: {
      type: String,
      enum: ["available", "not available", "pending", "ready to move"],
      required: false,
      default: "available",
    },

    // --- Features & Amenities ---
    featuresAndAmenities: {type: [String], default: []},

    // --- Media ---
    images: {type: [PropertyImageSchema], required: true, default: []},
    documents: {type: [PropertyDocSchema], required: true, default: []},
    videoTour: {type: String, required: false, default: ""},
    virtualTour: {type: String, required: false, default: ""},

    // --- Listing Management ---
    listingDate: {type: Date, required: true, default: null},
    availabilityDate: {type: Date, required: false, default: null},
    listingExpiryDate: {type: Date, required: false, default: null},
    rentedDate: {type: Date, required: false, default: null},
    soldDate: {type: Date, required: false, default: null},
    addedBy: {type: AddedBySchema, required: true, default: {}},
    owner: {type: String, required: true, default: ""},

    // --- Administrative & Internal Use ---
    referenceCode: {type: String, required: true, default: ""},
    verificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected", "approved"],
      required: true,
      default: "verified",
    },
    priority: {
      type: String,
      enum: ["high", "medium", "low"],
      required: true,
      default: "medium",
    },
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      required: true,
      default: "published",
    },
    internalNote: {type: String, required: true, default: ""},
  },
  {
    timestamps: true,
    // Include virtuals whenever we convert to JSON or plain objects
    toJSON: {virtuals: true},
    toObject: {virtuals: true},
  }
);

// =============================================================================
// 4) Virtuals (Computed, not stored)
// =============================================================================

/**
 * fullAddress
 * Example: "12A, Baker Street, London, Greater London, W1, United Kingdom"
 */
PropertySchema.virtual("fullAddress").get(function(this: IProperty) {
  const a = this.address || ({} as Address);
  const parts = [
    a.houseNumber,
    a.street,
    a.city,
    a.stateOrProvince,
    a.postcode,
    a.country,
  ]
    .filter(Boolean)
    .map((x) => String(x).trim());
  return parts.join(", ");
});

/**
 * mainImageURL
 * Returns the first image URL (useful for listing cards); empty string if none.
 */
PropertySchema.virtual("mainImageURL").get(function(this: IProperty) {
  if(Array.isArray(this.images) && this.images.length > 0) {
    return this.images[0]?.imageURL || "";
  }
  return "";
});

/**
 * pricePerSquareFoot
 * Safe computation; returns null if totalArea is missing or zero.
 */
PropertySchema.virtual("pricePerSquareFoot").get(function(this: IProperty) {
  const area = Number(this.totalArea || 0);
  if(!area) return null;
  return Number((this.price / area).toFixed(2));
});

/**
 * pricePerSquareMeter
 * If your stored area is in square feet, convert:
 *   1 m² ≈ 10.7639 ft²  =>  price per m² = price / (area_ft² / 10.7639)
 * Returns null when area is zero.
 */
PropertySchema.virtual("pricePerSquareMeter").get(function(this: IProperty) {
  const areaFt2 = Number(this.totalArea || 0);
  if(!areaFt2) return null;
  const areaM2 = areaFt2 / 10.7639;
  if(!areaM2) return null;
  return Number((this.price / areaM2).toFixed(2));
});

/**
 * isAvailable
 * A simple, readable flag derived from listing + availabilityStatus.
 */
PropertySchema.virtual("isAvailable").get(function(this: IProperty) {
  const listing = String(this.listing || "").toLowerCase();
  const status = String(this.availabilityStatus || "").toLowerCase();
  if(listing === "sold" || listing === "rented") return false;
  return status === "available" || status === "ready to move";
});

/**
 * daysOnMarket
 * Number of whole days since the listing date (>= 0).
 */
PropertySchema.virtual("daysOnMarket").get(function(this: IProperty) {
  const start = this.listingDate ? new Date(this.listingDate).getTime() : NaN;
  if(Number.isNaN(start)) return 0;
  const now = Date.now();
  return Math.max(0, Math.floor((now - start) / (1000 * 60 * 60 * 24)));
});

// =============================================================================
// 5) Indexes (helpful for search & filtering)
// =============================================================================

// Text search on title + description, and filter fields.
PropertySchema.index({
  title: "text",
  description: "text",
  type: 1,
  listing: 1,
  "address.city": 1,
  "address.country": 1,
  price: 1,
  bedrooms: 1,
  bathrooms: 1,
  priority: 1,
  status: 1,
});

// =============================================================================
/**
 * PropertyModel
 * Use this in controllers/services:
 *   await PropertyModel.find();
 *   const doc = await new PropertyModel(data).save();
 */
// =============================================================================
export const PropertyModel = model<IProperty>("Property", PropertySchema);
