// src/models/property.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE: Property model (types + DB schema + virtuals) in a class-based pattern.
// NOTE: No controller/service logic here — models are for types and DB only.
// ─────────────────────────────────────────────────────────────────────────────

import {Schema, model, type Document, type Model} from 'mongoose';

/* ============================================================================
 * 1) TypeScript Interfaces (Structure & Types)
 * ==========================================================================*/

/** Reusable shapes for media and address. */
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

/** CountryDetails mirrors REST Countries API for rich metadata. */
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
    [code: string]: {name: string; symbol: string};
  };
  idd?: {root: string; suffixes: string[]};
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
  car?: {signs: string[]; side: 'left' | 'right'};
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
  role: 'admin' | 'agent' | 'owner' | string;
  contactNumber?: string;
  addedAt: Date | string;
}

export interface GoogleMapLocation {
  lat: number;
  lng: number;
  embeddedUrl: string;
}

/** Optional virtual/computed fields (not stored in MongoDB). */
export interface PropertyVirtuals {
  fullAddress?: string;
  mainImageURL?: string;
  pricePerSquareFoot?: number | null;
  pricePerSquareMeter?: number | null;
  isAvailable?: boolean;
  daysOnMarket?: number;
}

/** MongoDB document shape + Mongoose Document + virtuals for typing. */
export interface IProperty extends Document, PropertyVirtuals {
  // Basic
  id: string;
  title: string;
  type: 'apartment' | 'house' | 'villa' | 'commercial' | 'land' | 'studio' | string;
  listing: 'sale' | 'rent' | 'sold' | 'rented' | string;
  description: string;

  // Location
  countryDetails: CountryDetails;
  address: Address;
  location?: GoogleMapLocation;

  // Specs
  totalArea: number;
  builtInArea: number;
  livingRooms: number;
  balconies: number;
  kitchen: number;
  bedrooms: number;
  bathrooms: number;
  maidrooms: number;
  driverRooms: number;
  furnishingStatus: 'furnished' | 'semi-furnished' | 'unfurnished' | string;
  totalFloors: number;
  numberOfParking: number;

  // Build & age
  builtYear: number;
  propertyCondition: 'new' | 'old' | 'excellent' | 'good' | 'needs renovation' | string;
  developerName: string;
  projectName?: string;
  ownerShipType: 'freehold' | 'leasehold' | 'company' | 'trust' | string;

  // Financial
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
  availabilityStatus: 'available' | 'not available' | 'pending' | 'ready to move' | string;

  // Features
  featuresAndAmenities: string[];

  // Media
  images: propertyImages[];
  uploadedImages?: propertyImages[];
  documents: propertyDocs[];
  uploadedDocuments?: propertyDocs[];
  videoTour?: string;
  virtualTour?: string;

  // Listing management
  listingDate: Date;
  availabilityDate?: Date | null;
  listingExpiryDate?: Date | null;
  rentedDate?: Date | null;
  soldDate?: Date | null;
  addedBy: AddedBy;
  owner: string;

  // Admin / internal
  referenceCode: string;
  verificationStatus: 'pending' | 'verified' | 'rejected' | 'approved';
  priority: 'high' | 'medium' | 'low';
  status: 'draft' | 'published' | 'archived';
  internalNote: string;

  createdAt: Date;
  updatedAt: Date;
}

/** Plain TypeScript version (no Mongoose mixins). */
export interface Property extends Omit<IProperty, keyof Document> {}

/* ============================================================================
 * 2) Class-based Builder (schema, virtuals, indexes)
 * ==========================================================================*/

export class PropertyModelBuilder {
  /** Build and return subdocument schemas. Kept private and class-based. */
  private static buildSubSchemas() {
    const PropertyImageSchema = new Schema<propertyImages>(
      {
        originalname: String,
        filename: String,
        mimetype: String,
        size: Number,
        imageURL: String,
      },
      {_id: false}
    );

    const PropertyDocSchema = new Schema<propertyDocs>(
      {
        originalname: String,
        filename: String,
        mimetype: String,
        size: Number,
        documentURL: String,
      },
      {_id: false}
    );

    const AddressSchema = new Schema<Address>(
      {
        houseNumber: String,
        street: String,
        city: String,
        stateOrProvince: String,
        postcode: String,
        country: String,
      },
      {_id: false}
    );

    const CountryDetailsSchema = new Schema<CountryDetails>(
      {
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
        flags: {png: String, svg: String, alt: String},
        coatOfArms: {png: String, svg: String},
        maps: {googleMaps: String, openStreetMaps: String},
        population: Number,
        fifa: String,
        car: {signs: [String], side: String},
        timezones: [String],
        continents: [String],
        startOfWeek: String,
        capitalInfo: {latlng: [Number]},
        postalCode: {format: String, regex: String},
      },
      {_id: false}
    );

    const AddedBySchema = new Schema<AddedBy>(
      {
        username: String,
        name: String,
        email: String,
        role: String,
        contactNumber: String,
        addedAt: Date,
      },
      {_id: false}
    );

    const GoogleMapLocationSchema = new Schema<GoogleMapLocation>(
      {
        lat: Number,
        lng: Number,
        embeddedUrl: {type: String, default: ''},
      },
      {_id: false}
    );

    return {
      PropertyImageSchema,
      PropertyDocSchema,
      AddressSchema,
      CountryDetailsSchema,
      AddedBySchema,
      GoogleMapLocationSchema,
    };
  }

  /** Build the main schema, attach virtuals and indexes. */
  public static buildSchema(): Schema<IProperty> {
    const {
      PropertyImageSchema,
      PropertyDocSchema,
      AddressSchema,
      CountryDetailsSchema,
      AddedBySchema,
      GoogleMapLocationSchema,
    } = this.buildSubSchemas();

    const PropertySchema = new Schema<IProperty>(
      {
        // Basic
        id: {type: String, unique: true, required: true, index: true},
        title: {type: String, required: true, default: 'Property Title'},
        type: {
          type: String,
          enum: ['apartment', 'house', 'villa', 'commercial', 'land', 'studio'],
          required: true,
          default: 'apartment',
        },
        listing: {
          type: String,
          enum: ['sale', 'rent', 'sold', 'rented'],
          required: true,
          default: 'sale',
        },
        description: {type: String, required: true, default: ''},

        // Location
        countryDetails: {type: CountryDetailsSchema, default: {}},
        address: {type: AddressSchema, default: {}},
        location: {type: GoogleMapLocationSchema, default: {}},

        // Specs
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
          enum: ['furnished', 'semi-furnished', 'unfurnished'],
          required: true,
          default: 'unfurnished',
        },
        totalFloors: {type: Number, required: true, default: 0},
        numberOfParking: {type: Number, required: true, default: 0},

        // Build & age
        builtYear: {type: Number, required: true, default: 0},
        propertyCondition: {
          type: String,
          enum: ['new', 'old', 'excellent', 'good', 'needs renovation'],
          required: true,
          default: 'new',
        },
        developerName: {type: String, required: true, default: ''},
        projectName: {type: String, default: ''},
        ownerShipType: {
          type: String,
          enum: ['freehold', 'leasehold', 'company', 'trust'],
          required: true,
          default: 'freehold',
        },

        // Financial
        price: {type: Number, required: true, default: 0},
        currency: {type: String, required: true, default: 'lkr'},
        pricePerSqurFeet: {type: Number, required: true, default: 0},
        expectedRentYearly: {type: Number, default: 0},
        expectedRentQuartely: {type: Number, default: 0},
        expectedRentMonthly: {type: Number, default: 0},
        expectedRentDaily: {type: Number, default: 0},
        maintenanceFees: {type: Number, required: true, default: 0},
        serviceCharges: {type: Number, required: true, default: 0},
        transferFees: {type: Number, default: 0},
        availabilityStatus: {
          type: String,
          enum: ['available', 'not available', 'pending', 'ready to move'],
          default: 'available',
        },

        // Features
        featuresAndAmenities: {type: [String], default: []},

        // Media
        images: {type: [PropertyImageSchema], required: true, default: []},
        documents: {type: [PropertyDocSchema], required: true, default: []},
        videoTour: {type: String, default: ''},
        virtualTour: {type: String, default: ''},

        // Listing management
        listingDate: {type: Date, required: true, default: null},
        availabilityDate: {type: Date, default: null},
        listingExpiryDate: {type: Date, default: null},
        rentedDate: {type: Date, default: null},
        soldDate: {type: Date, default: null},
        addedBy: {type: AddedBySchema, required: true, default: {}},
        owner: {type: String, required: true, default: ''},

        // Admin / internal
        referenceCode: {type: String, required: true, default: ''},
        verificationStatus: {
          type: String,
          enum: ['pending', 'verified', 'rejected', 'approved'],
          required: true,
          default: 'verified',
        },
        priority: {
          type: String,
          enum: ['high', 'medium', 'low'],
          required: true,
          default: 'medium',
        },
        status: {
          type: String,
          enum: ['draft', 'published', 'archived'],
          required: true,
          default: 'published',
        },
        internalNote: {type: String, required: true, default: ''},
      },
      {
        timestamps: true,
        toJSON: {virtuals: true},
        toObject: {virtuals: true},
      }
    );

    // ── Virtuals (computed, not stored)

    PropertySchema.virtual('fullAddress').get(function(this: IProperty) {
      const a = this.address || ({} as Address);
      const parts = [a.houseNumber, a.street, a.city, a.stateOrProvince, a.postcode, a.country]
        .filter(Boolean)
        .map((x) => String(x).trim());
      return parts.join(', ');
    });

    PropertySchema.virtual('mainImageURL').get(function(this: IProperty) {
      if(Array.isArray(this.images) && this.images.length > 0) {
        return this.images[0]?.imageURL || '';
      }
      return '';
    });

    PropertySchema.virtual('pricePerSquareFoot').get(function(this: IProperty) {
      const area = Number(this.totalArea || 0);
      if(!area) return null;
      return Number((this.price / area).toFixed(2));
    });

    PropertySchema.virtual('pricePerSquareMeter').get(function(this: IProperty) {
      const areaFt2 = Number(this.totalArea || 0);
      if(!areaFt2) return null;
      const areaM2 = areaFt2 / 10.7639; // 1 m² ≈ 10.7639 ft²
      if(!areaM2) return null;
      return Number((this.price / areaM2).toFixed(2));
    });

    PropertySchema.virtual('isAvailable').get(function(this: IProperty) {
      const listing = String(this.listing || '').toLowerCase();
      const status = String(this.availabilityStatus || '').toLowerCase();
      if(listing === 'sold' || listing === 'rented') return false;
      return status === 'available' || status === 'ready to move';
    });

    PropertySchema.virtual('daysOnMarket').get(function(this: IProperty) {
      const start = this.listingDate ? new Date(this.listingDate).getTime() : NaN;
      if(Number.isNaN(start)) return 0;
      const now = Date.now();
      return Math.max(0, Math.floor((now - start) / (1000 * 60 * 60 * 24)));
    });

    // ── Indexes (search & filtering)
    PropertySchema.index({
      title: 'text',
      description: 'text',
      type: 1,
      listing: 1,
      'address.city': 1,
      'address.country': 1,
      price: 1,
      bedrooms: 1,
      bathrooms: 1,
      priority: 1,
      status: 1,
    });

    return PropertySchema;
  }

  /** Create and return the Mongoose model instance (single source). */
  public static getModel(): Model<IProperty> {
    const schema = this.buildSchema();
    // Explicit collection name keeps consistency: 'properties'
    return model<IProperty>('Property', schema, 'properties');
  }
}

/* ============================================================================
 * 3) Export a ready-to-use model instance
 * ==========================================================================*/
export const PropertyModel = PropertyModelBuilder.getModel();
