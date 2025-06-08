// models/Property.js
import { Schema, model, Document } from "mongoose";

// ================== TypeScript Interfaces ================== //

// Main Property Interface
export interface IProperty extends Document {
  // Basic Property Details
  id: string;
  title: string;
  type:
    | "apartment"
    | "house"
    | "villa"
    | "commercial"
    | "land"
    | "stodio"
    | string;
  listing: "sale" | "rent" | "sold" | "rented" | string;
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
  furnishingStatus: "furnished" | "semi-furnished" | "unfurnished" | string;
  totalFloors: number;
  numberOfParking: number;
  // End Property Specifications

  // Construction & Age
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
    | "available"
    | "not available"
    | "pending"
    | "ready to move"
    | string;
  // End Financial Details

  // Features & Amenities
  featuresAndAmenities: string[];
  // End Features & Amenities

  // Media
  images: propertyImages[];
  uploadedImages?: propertyImages[];
  documents: propertyDocs[];
  uploadedDocuments?: propertyDocs[];
  videoTour?: string;
  virtualTour?: string;
  // End Media

  // Listing Management
  listingDate: Date;
  availabilityDate?: Date;
  listingExpiryDate?: Date;
  rentedDate?: Date;
  soldDate?: Date;
  addedBy: AddedBy;
  owner: string;
  // End Listing Management

  // Administrative & Internal Use
  referenceCode: string;
  verificationStatus: "pending" | "verified" | "rejected" | "approved";
  priority: "high" | "medium" | "low";
  status: "draft" | "published" | "archived";
  internalNote: string;
  // End Administrative & Internal Use
}

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
  languages?: { [langCode: string]: string };
  latlng: [number, number];
  landlocked?: boolean;
  borders?: string[];
  area: number;
  demonyms?: { [langCode: string]: { m: string; f: string } };
  translations?: { [langCode: string]: { official: string; common: string } };
  flag?: string;
  flags: { png: string; svg: string; alt?: string };
  coatOfArms?: { png?: string; svg?: string };
  maps?: { googleMaps: string; openStreetMaps: string };
  population: number;
  fifa?: string;
  car?: { signs: string[]; side: "left" | "right" };
  timezones: string[];
  continents: string[];
  startOfWeek?: string;
  capitalInfo?: { latlng: [number, number] };
  postalCode?: { format?: string; regex?: string };
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

// ================== Mongoose Schemas ================== //

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
    nativeName: Schema.Types.Mixed,
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
  embeddedUrl: {type: String, required: false, default: ''},
});

const PropertySchema = new Schema<IProperty>(
  {
    // Basic Property Details
    id: { type: String, unique: true, required: true },
    title: { type: String, required: true, default: "Property Title" },
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
    description: { type: String, required: true, default: "" },
    // End Basic Property Details

    // Location Details
    countryDetails: { type: CountryDetailsSchema, default: {} },
    address: { type: AddressSchema, default: {} },
    location: { type: GoogleMapLocationSchema, default: {} },
    // End Location Details

    // Property Specifications
    totalArea: { type: Number, required: true, default: 0 },
    builtInArea: { type: Number, required: true, default: 0 },
    livingRooms: { type: Number, required: true, default: 0 },
    balconies: { type: Number, required: true, default: 0 },
    kitchen: { type: Number, required: true, default: 0 },
    bedrooms: { type: Number, required: true, default: 0 },
    bathrooms: { type: Number, required: true, default: 0 },
    maidrooms: { type: Number, required: true, default: 0 },
    driverRooms: { type: Number, required: true, default: 0 },
    furnishingStatus: {
      type: String,
      enum: ["furnished", "semi-furnished", "unfurnished"],
      required: true,
      default: "unfurnished",
    },
    totalFloors: {
      type: Number,
      required: true,
      default: 0,
    },
    numberOfParking: {
      type: Number,
      required: true,
      default: 0,
    },
    // End Property Specifications

    // Construction & Age
    builtYear: { type: Number, required: true, default: 0 },
    propertyCondition: {
      type: String,
      enum: ["new", "old", "excellent", "good", "needs renovation"],
      required: true,
      default: "new",
    },
    developerName: {
      type: String,
      required: true,
      default: "",
    },
    projectName: {
      type: String,
      required: false,
      default: "",
    },
    ownerShipType: {
      type: String,
      required: true,
      enum: ["freehold", "leasehold", "company", "trust"],
      default: "",
    },
    // End Construction & Age

    // Financial Details
    price: { type: Number, required: true, default: 0 },
    currency: { type: String, required: true, default: "lkr" },
    pricePerSqurFeet: { type: Number, required: true, default: 0 },
    expectedRentYearly: { type: Number, required: false, default: 0 },
    expectedRentQuartely: { type: Number, required: false, default: 0 },
    expectedRentMonthly: { type: Number, required: false, default: 0 },
    expectedRentDaily: { type: Number, required: false, default: 0 },
    maintenanceFees: { type: Number, required: true, default: 0 },
    serviceCharges: { type: Number, required: true, default: 0 },
    transferFees: { type: Number, required: false, default: 0 },
    availabilityStatus: {
      type: String,
      enum: ["available", "not available", "pending", "ready to move"],
      required: false,
      default: "available",
    },
    // End Financial Details

    // Features & Amenities
    featuresAndAmenities: { type: [String], default: [] },
    // End Features & Amenities

    // Media
    images: { type: [PropertyImageSchema], required: true, default: [] },
    documents: { type: [PropertyDocSchema], required: true, default: [] },
    videoTour: { type: String, required: false, default: "" },
    virtualTour: { type: String, required: false, default: "" },
    // End Media

    // Listing Management
    listingDate: { type: Date, required: true, default: undefined },
    availabilityDate: { type: Date, required: false, default: undefined },
    listingExpiryDate: { type: Date, required: false, default: undefined },
    rentedDate: { type: Date, required: false, default: undefined },
    soldDate: { type: Date, required: false, default: undefined },
    addedBy: { type: AddedBySchema, required: true, default: {} },
    owner: { type: String, required: true, default: "" },
    // End Listing Management

    // Administrative & Internal Use
    referenceCode: { type: String, required: true, default: "" },
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
    internalNote: {
      type: String,
      required: true,
      default: "",
    },
    // End Administrative & Internal Use
  },
  { timestamps: true }
);

// ================== Export Model ================== //
export const PropertyModel = model<IProperty>("Property", PropertySchema);
