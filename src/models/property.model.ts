// models/Property.js
import { Schema, model, Document } from "mongoose";

// ================== TypeScript Interfaces ================== //

// Main Property Interface
export interface IProperty extends Document {
  id: string;
  title: string;
  description: string;
  type:
    | "Apartment"
    | "House"
    | "Villa"
    | "Commercial"
    | "Land"
    | "Stodio"
    | string;
  status: "Sale" | "Rent" | "Sold" | "Rented" | string;
  price: number;
  currency: string;
  bedrooms: number;
  bathrooms: number;
  maidrooms: number;
  area: number;
  images: propertyImages[];
  address: Address;
  countryDetails: CountryDetails;
  featuresAndAmenities: string[];
  addedBy: AddedBy;
  location?: GoogleMapLocation;
  propertyDocs: propertyDocs[];
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
  embeddedUrl: String,
});

const PropertySchema = new Schema<IProperty>(
  {
    id: { type: String, unique: true, required: true },
    title: { type: String, required: true, default: "Property Title" },
    description: { type: String, required: true, default: "" },
    type: {
      type: String,
      enum: ["Apartment", "House", "Villa", "Commercial", "Land", "Studio"],
      required: true,
      default: "apartment",
    },
    status: { type: String, required: true, default: "Sale" },
    price: { type: Number, required: true, default: 0 },
    currency: { type: String, required: true, default: "$" },
    bedrooms: { type: Number, required: true, default: 0 },
    bathrooms: { type: Number, required: true, default: 0 },
    maidrooms: { type: Number, required: true, default: 0 },
    area: { type: Number, required: true, default: 0 },
    images: { type: [PropertyImageSchema], default: [] },
    address: { type: AddressSchema, default: {} },
    countryDetails: { type: CountryDetailsSchema, default: {} },
    featuresAndAmenities: { type: [String], default: [] },
    addedBy: { type: AddedBySchema, required: true },
    location: { type: GoogleMapLocationSchema, default: {} },
    propertyDocs: { type: [PropertyDocSchema], default: [] },
  },
  { timestamps: true }
);

// ================== Export Model ================== //
export const PropertyModel = model<IProperty>("Property", PropertySchema);
