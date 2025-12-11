// src/models/property.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE:
//   Property model (types + DB schema + virtuals) in a class-based pattern.
//   - All sub-schemas are encapsulated in static-only builder classes.
//   - No business logic: only structure, virtuals, indexes.
// NOTE:
//   Controllers/services handle validation, business rules, and I/O.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Schema,
  model,
  type Document,
  type Model,
} from 'mongoose';

import type { CountryCodes } from './user.model';

/* ============================================================================
 * 1) TypeScript Interfaces (Domain Shape)
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
      [ langCode: string ]: {
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
    [ code: string ]: { name: string; symbol: string; };
  };
  idd?: { root: string; suffixes: string[]; };
  capital?: string[];
  altSpellings?: string[];
  region: string;
  subregion?: string;
  languages?: { [ langCode: string ]: string; };
  latlng: [ number, number ];
  landlocked?: boolean;
  borders?: string[];
  area: number;
  demonyms?: { [ langCode: string ]: { m: string; f: string; }; };
  translations?: { [ langCode: string ]: { official: string; common: string; }; };
  flag?: string;
  flags: { png: string; svg: string; alt?: string; };
  coatOfArms?: { png?: string; svg?: string; };
  maps?: { googleMaps: string; openStreetMaps: string; };
  population: number;
  fifa?: string;
  car?: { signs: string[]; side: 'left' | 'right'; };
  timezones: string[];
  continents: string[];
  startOfWeek?: string;
  capitalInfo?: { latlng: [ number, number ]; };
  postalCode?: { format?: string; regex?: string; };
}

export interface PhoneNumber {
  code: CountryCodes;
  number: string;
}

export interface AddedBy {
  username: string;
  name: string;
  email: string;
  role: 'admin' | 'agent' | 'owner' | string;
  contactNumber?: PhoneNumber;
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
 * 2) Sub-schema builders (static-only)
 * ==========================================================================*/

/**
 * FlagsSubSchemaBuilder
 * ---------------------
 * Builds the flags object attached to country codes (PNG/SVG/alt).
 * Note: This is duplicated (by design) from user.model to avoid runtime cycles.
 */
export class FlagsSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<{ png: string; svg: string; alt?: string; }> {
    return new Schema<{ png: string; svg: string; alt?: string; }>(
      {
        png: {
          type: String,
          required: true,
          default: '',
        },
        svg: {
          type: String,
          required: true,
          default: '',
        },
        alt: {
          type: String,
          required: false,
          default: '',
        },
      },
      { _id: false },
    );
  }
}

/**
 * CountryCodeSubSchemaBuilder
 * ---------------------------
 * Builds the CountryCodes sub-schema (name, code, flags).
 */
export class CountryCodeSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<CountryCodes> {
    return new Schema<CountryCodes>(
      {
        name: {
          type: String,
          required: true,
          default: '',
        },
        code: {
          type: String,
          required: true,
          default: '',
        },
        flags: {
          type: FlagsSubSchemaBuilder.buildSchema(),
          required: true,
        },
      },
      { _id: false },
    );
  }
}

/**
 * PhoneNumberSubSchemaBuilder
 * ---------------------------
 * Builds the PhoneNumber sub-schema reused in AddedBy.
 */
export class PhoneNumberSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<PhoneNumber> {
    return new Schema<PhoneNumber>(
      {
        code: {
          type: CountryCodeSubSchemaBuilder.buildSchema(),
          required: true,
        },
        number: {
          type: String,
          required: true,
          default: '',
        },
      },
      { _id: false },
    );
  }
}

/**
 * PropertyImageSubSchemaBuilder
 * -----------------------------
 * Builds the image metadata sub-schema for property images.
 */
export class PropertyImageSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<propertyImages> {
    return new Schema<propertyImages>(
      {
        originalname: {
          type: String,
          required: true,
          default: '',
        },
        filename: {
          type: String,
          required: true,
          default: '',
        },
        mimetype: {
          type: String,
          required: true,
          default: '',
        },
        size: {
          type: Number,
          required: true,
          default: 0,
        },
        imageURL: {
          type: String,
          required: true,
          default: '',
        },
      },
      { _id: false },
    );
  }
}

/**
 * PropertyDocSubSchemaBuilder
 * ---------------------------
 * Builds the document metadata sub-schema for property documents.
 */
export class PropertyDocSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<propertyDocs> {
    return new Schema<propertyDocs>(
      {
        originalname: {
          type: String,
          required: true,
          default: '',
        },
        filename: {
          type: String,
          required: true,
          default: '',
        },
        mimetype: {
          type: String,
          required: true,
          default: '',
        },
        size: {
          type: Number,
          required: true,
          default: 0,
        },
        documentURL: {
          type: String,
          required: true,
          default: '',
        },
      },
      { _id: false },
    );
  }
}

/**
 * PropertyAddressSubSchemaBuilder
 * -------------------------------
 * Builds the Address sub-schema for properties.
 */
export class PropertyAddressSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<Address> {
    return new Schema<Address>(
      {
        houseNumber: {
          type: String,
          required: true,
          default: '',
        },
        street: {
          type: String,
          required: false,
          default: '',
        },
        city: {
          type: String,
          required: true,
          default: '',
        },
        stateOrProvince: {
          type: String,
          required: false,
          default: '',
        },
        postcode: {
          type: String,
          required: true,
          default: '',
        },
        country: {
          type: String,
          required: true,
          default: '',
        },
      },
      { _id: false },
    );
  }
}

/**
 * CountryDetailsSubSchemaBuilder
 * ------------------------------
 * Builds the CountryDetails sub-schema (REST Countries style).
 */
export class CountryDetailsSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<CountryDetails> {
    return new Schema<CountryDetails>(
      {
        name: {
          common: { type: String, required: true, default: '' },
          official: { type: String, required: true, default: '' },
          nativeName: { type: Schema.Types.Mixed, required: false },
        },
        tld: { type: [ String ], required: false, default: [] },
        cca2: { type: String, required: true, default: '' },
        cca3: { type: String, required: false },
        ccn3: { type: String, required: false },
        cioc: { type: String, required: false },
        independent: { type: Boolean, required: false },
        status: { type: String, required: false },
        unMember: { type: Boolean, required: false },
        currencies: { type: Schema.Types.Mixed, required: false },
        idd: {
          root: { type: String, required: false },
          suffixes: { type: [ String ], required: false, default: [] },
        },
        capital: { type: [ String ], required: false, default: [] },
        altSpellings: { type: [ String ], required: false, default: [] },
        region: { type: String, required: true, default: '' },
        subregion: { type: String, required: false },
        languages: { type: Schema.Types.Mixed, required: false },
        latlng: { type: [ Number ], required: true, default: [ 0, 0 ] },
        landlocked: { type: Boolean, required: false },
        borders: { type: [ String ], required: false, default: [] },
        area: { type: Number, required: true, default: 0 },
        demonyms: { type: Schema.Types.Mixed, required: false },
        translations: { type: Schema.Types.Mixed, required: false },
        flag: { type: String, required: false },
        flags: {
          png: { type: String, required: true, default: '' },
          svg: { type: String, required: true, default: '' },
          alt: { type: String, required: false, default: '' },
        },
        coatOfArms: {
          png: { type: String, required: false },
          svg: { type: String, required: false },
        },
        maps: {
          googleMaps: { type: String, required: false, default: '' },
          openStreetMaps: { type: String, required: false, default: '' },
        },
        population: { type: Number, required: true, default: 0 },
        fifa: { type: String, required: false },
        car: {
          signs: { type: [ String ], required: false, default: [] },
          side: { type: String, required: false },
        },
        timezones: { type: [ String ], required: true, default: [] },
        continents: { type: [ String ], required: true, default: [] },
        startOfWeek: { type: String, required: false },
        capitalInfo: {
          latlng: { type: [ Number ], required: false, default: undefined },
        },
        postalCode: {
          format: { type: String, required: false },
          regex: { type: String, required: false },
        },
      },
      { _id: false },
    );
  }
}

/**
 * AddedBySubSchemaBuilder
 * -----------------------
 * Builds the AddedBy metadata sub-schema.
 */
export class AddedBySubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<AddedBy> {
    return new Schema<AddedBy>(
      {
        username: {
          type: String,
          required: true,
          default: '',
        },
        name: {
          type: String,
          required: true,
          default: '',
        },
        email: {
          type: String,
          required: true,
          default: '',
        },
        role: {
          type: String,
          required: true,
          default: 'agent',
        },
        contactNumber: {
          type: PhoneNumberSubSchemaBuilder.buildSchema(),
          required: false,
        },
        addedAt: {
          type: Schema.Types.Mixed, // Date | string
          required: true,
          default: () => new Date(),
        },
      },
      { _id: false },
    );
  }
}

/**
 * GoogleMapLocationSubSchemaBuilder
 * ---------------------------------
 * Builds the GoogleMapLocation sub-schema.
 */
export class GoogleMapLocationSubSchemaBuilder {
  private constructor () {}

  public static buildSchema(): Schema<GoogleMapLocation> {
    return new Schema<GoogleMapLocation>(
      {
        lat: {
          type: Number,
          required: true,
          default: 0,
        },
        lng: {
          type: Number,
          required: true,
          default: 0,
        },
        embeddedUrl: {
          type: String,
          required: true,
          default: '',
        },
      },
      { _id: false },
    );
  }
}

/* ============================================================================
 * 3) PropertyModelBuilder (composition root)
 * ==========================================================================*/

export class PropertyModelBuilder {
  private constructor () {}

  /** Build the main Property schema, attach virtuals and indexes. */
  public static buildSchema(): Schema<IProperty> {
    const imageSchema = PropertyImageSubSchemaBuilder.buildSchema();
    const docSchema = PropertyDocSubSchemaBuilder.buildSchema();
    const addressSchema = PropertyAddressSubSchemaBuilder.buildSchema();
    const countryDetailsSchema = CountryDetailsSubSchemaBuilder.buildSchema();
    const addedBySchema = AddedBySubSchemaBuilder.buildSchema();
    const googleMapLocationSchema = GoogleMapLocationSubSchemaBuilder.buildSchema();

    const propertySchema: Schema<IProperty> = new Schema<IProperty>(
      {
        // Basic
        id: {
          type: String,
          unique: true,
          required: true,
          index: true,
        },
        title: {
          type: String,
          required: true,
          default: 'Property Title',
        },
        type: {
          type: String,
          enum: [ 'apartment', 'house', 'villa', 'commercial', 'land', 'studio' ],
          required: true,
          default: 'apartment',
        },
        listing: {
          type: String,
          enum: [ 'sale', 'rent', 'sold', 'rented' ],
          required: true,
          default: 'sale',
        },
        description: {
          type: String,
          required: true,
          default: '',
        },

        // Location
        countryDetails: {
          type: countryDetailsSchema,
          required: true,
          default: {},
        },
        address: {
          type: addressSchema,
          required: true,
          default: {},
        },
        location: {
          type: googleMapLocationSchema,
          required: false,
          default: undefined,
        },

        // Specs
        totalArea: {
          type: Number,
          required: true,
          default: 0,
        },
        builtInArea: {
          type: Number,
          required: true,
          default: 0,
        },
        livingRooms: {
          type: Number,
          required: true,
          default: 0,
        },
        balconies: {
          type: Number,
          required: true,
          default: 0,
        },
        kitchen: {
          type: Number,
          required: true,
          default: 0,
        },
        bedrooms: {
          type: Number,
          required: true,
          default: 0,
        },
        bathrooms: {
          type: Number,
          required: true,
          default: 0,
        },
        maidrooms: {
          type: Number,
          required: true,
          default: 0,
        },
        driverRooms: {
          type: Number,
          required: true,
          default: 0,
        },
        furnishingStatus: {
          type: String,
          enum: [ 'furnished', 'semi-furnished', 'unfurnished' ],
          required: true,
          default: 'unfurnished',
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

        // Build & age
        builtYear: {
          type: Number,
          required: true,
          default: 0,
        },
        propertyCondition: {
          type: String,
          enum: [ 'new', 'old', 'excellent', 'good', 'needs renovation' ],
          required: true,
          default: 'new',
        },
        developerName: {
          type: String,
          required: true,
          default: '',
        },
        projectName: {
          type: String,
          required: false,
          default: '',
        },
        ownerShipType: {
          type: String,
          enum: [ 'freehold', 'leasehold', 'company', 'trust' ],
          required: true,
          default: 'freehold',
        },

        // Financial
        price: {
          type: Number,
          required: true,
          default: 0,
        },
        currency: {
          type: String,
          required: true,
          default: 'lkr',
        },
        pricePerSqurFeet: {
          type: Number,
          required: true,
          default: 0,
        },
        expectedRentYearly: {
          type: Number,
          required: false,
          default: 0,
        },
        expectedRentQuartely: {
          type: Number,
          required: false,
          default: 0,
        },
        expectedRentMonthly: {
          type: Number,
          required: false,
          default: 0,
        },
        expectedRentDaily: {
          type: Number,
          required: false,
          default: 0,
        },
        maintenanceFees: {
          type: Number,
          required: true,
          default: 0,
        },
        serviceCharges: {
          type: Number,
          required: true,
          default: 0,
        },
        transferFees: {
          type: Number,
          required: false,
          default: 0,
        },
        availabilityStatus: {
          type: String,
          enum: [ 'available', 'not available', 'pending', 'ready to move' ],
          required: true,
          default: 'available',
        },

        // Features
        featuresAndAmenities: {
          type: [ String ],
          required: true,
          default: [],
        },

        // Media
        images: {
          type: [ imageSchema ],
          required: true,
          default: [],
        },
        documents: {
          type: [ docSchema ],
          required: true,
          default: [],
        },
        videoTour: {
          type: String,
          required: false,
          default: '',
        },
        virtualTour: {
          type: String,
          required: false,
          default: '',
        },

        // Listing management
        listingDate: {
          type: Date,
          required: true,
          default: null,
        },
        availabilityDate: {
          type: Date,
          required: false,
          default: null,
        },
        listingExpiryDate: {
          type: Date,
          required: false,
          default: null,
        },
        rentedDate: {
          type: Date,
          required: false,
          default: null,
        },
        soldDate: {
          type: Date,
          required: false,
          default: null,
        },
        addedBy: {
          type: addedBySchema,
          required: true,
          default: {},
        },
        owner: {
          type: String,
          required: true,
          default: '',
        },

        // Admin / internal
        referenceCode: {
          type: String,
          required: true,
          default: '',
        },
        verificationStatus: {
          type: String,
          enum: [ 'pending', 'verified', 'rejected', 'approved' ],
          required: true,
          default: 'verified',
        },
        priority: {
          type: String,
          enum: [ 'high', 'medium', 'low' ],
          required: true,
          default: 'medium',
        },
        status: {
          type: String,
          enum: [ 'draft', 'published', 'archived' ],
          required: true,
          default: 'published',
        },
        internalNote: {
          type: String,
          required: true,
          default: '',
        },
      },
      {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
      },
    );

    // ────────────────────────────────────────────────────────────────────────
    // Virtuals (computed)
    // ────────────────────────────────────────────────────────────────────────

    propertySchema
      .virtual( 'fullAddress' )
      .get( function ( this: IProperty ): string {
        const a: Address = this.address || ( {} as Address );
        const parts: string[] = [
          a.houseNumber,
          a.street,
          a.city,
          a.stateOrProvince,
          a.postcode,
          a.country,
        ]
          .filter( Boolean )
          .map( ( value ) => String( value ).trim() );
        return parts.join( ', ' );
      } );

    propertySchema
      .virtual( 'mainImageURL' )
      .get( function ( this: IProperty ): string {
        if ( Array.isArray( this.images ) && this.images.length > 0 ) {
          return this.images[ 0 ]?.imageURL ?? '';
        }
        return '';
      } );

    propertySchema
      .virtual( 'pricePerSquareFoot' )
      .get( function ( this: IProperty ): number | null {
        const area: number = Number( this.totalArea || 0 );
        if ( !area ) {
          return null;
        }
        return Number( ( this.price / area ).toFixed( 2 ) );
      } );

    propertySchema
      .virtual( 'pricePerSquareMeter' )
      .get( function ( this: IProperty ): number | null {
        const areaFt2: number = Number( this.totalArea || 0 );
        if ( !areaFt2 ) {
          return null;
        }
        const areaM2: number = areaFt2 / 10.7639; // 1 m² ≈ 10.7639 ft²
        if ( !areaM2 ) {
          return null;
        }
        return Number( ( this.price / areaM2 ).toFixed( 2 ) );
      } );

    propertySchema
      .virtual( 'isAvailable' )
      .get( function ( this: IProperty ): boolean {
        const listing: string = String( this.listing || '' ).toLowerCase();
        const status: string = String( this.availabilityStatus || '' ).toLowerCase();

        if ( listing === 'sold' || listing === 'rented' ) {
          return false;
        }
        return status === 'available' || status === 'ready to move';
      } );

    propertySchema
      .virtual( 'daysOnMarket' )
      .get( function ( this: IProperty ): number {
        const start: number = this.listingDate
          ? new Date( this.listingDate ).getTime()
          : Number.NaN;

        if ( Number.isNaN( start ) ) {
          return 0;
        }

        const now: number = Date.now();
        const diffDays: number = Math.floor(
          ( now - start ) / ( 1000 * 60 * 60 * 24 ),
        );

        return Math.max( 0, diffDays );
      } );

    // ────────────────────────────────────────────────────────────────────────
    // Indexes (search & filtering)
    // ────────────────────────────────────────────────────────────────────────

    propertySchema.index( {
      title: 'text',
      description: 'text',
    } );

    propertySchema.index( {
      type: 1,
      listing: 1,
      'address.city': 1,
      'address.country': 1,
      price: 1,
      bedrooms: 1,
      bathrooms: 1,
      priority: 1,
      status: 1,
    } );

    return propertySchema;
  }

  /** Create and return the Mongoose model instance. */
  public static getModel(): Model<IProperty> {
    const schema: Schema<IProperty> = this.buildSchema();
    // explicit collection name for consistency across environments
    return model<IProperty>( 'Property', schema, 'properties' );
  }
}

/* ============================================================================
 * 4) Export ready-to-use model instance
 * ==========================================================================*/

export const PropertyModel: Model<IProperty> = PropertyModelBuilder.getModel();
