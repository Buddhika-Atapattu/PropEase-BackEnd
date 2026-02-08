// File: src/api/property.ts
// ============================================================================
// Property API (class-based)
// ----------------------------------------------------------------------------
// Responsibilities:
//   - Property CRUD (insert, update, delete, get single, get all, count)
//   - Dashboard analytics (portfolio summary, country distribution, etc.)
//   - File uploads/deletes via FileUploader helper
//   - Strict payload validation & shape-normalisation
//
// Design notes:
//   - Uses ApiResponseBuilder for all responses (no raw res.status().json)
//   - Uses FileUploader for multi-field uploads & recyclebin moves
//   - All helpers are encapsulated as private methods
// ============================================================================

import express, { Request, Response, Router } from "express";
import fs from "fs";
import fse from "fs-extra";
import type { PipelineStage } from "mongoose";
import path from "path";

import { ComplaintModel, type ComplaintStatus } from "../models/complaint.model";
import {
  AddedBy,
  Address,
  CountryDetails,
  GoogleMapLocation,
  IProperty,
  PropertyModel,
} from "../models/property.model";
import NotificationService from "../services/notification.service";
import type { FileMetaPacket, PaginationMeta } from "../types/api-message";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";
import FileUploader, { type UploadResultPacket } from "../utils/file-uploader.helper";
import type { CountryCodes, PhoneNumber } from "../models/user.model";

/* ========================================================================== *
 * INTERNAL TYPES
 * ========================================================================== */

type UploadedImage = {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  imageURL: string;
};

type UploadedDocument = {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  documentURL: string;
};

/* ========================================================================== *
 * CLASS
 * ========================================================================== */

export default class Property {
  /* ------------------------------------------------------------------------ *
   * Paths / URLs
   * ------------------------------------------------------------------------ */

  private readonly DEFAULT_UPLOAD_PATH = path.join(
    __dirname,
    "../../public/uploads/properties/"
  );

  private readonly DEFAULT_RECYCLE_PATH = path.join(
    __dirname,
    "../../public/recyclebin/properties/"
  );

  private readonly DEFAULT_PROPERTY_URL = "uploads/properties";
  private readonly DEFAULT_RECYCLE_URL = "recyclebin/properties";

  /* ------------------------------------------------------------------------ *
   * Enum-like Sets (business vocab)
   * ------------------------------------------------------------------------ */

  private readonly PROPERTY_TYPES = new Set<string>( [
    "apartment",
    "house",
    "villa",
    "commercial",
    "land",
    "studio",
  ] );

  private readonly LISTINGS = new Set<string>( [
    "sale",
    "rent",
    "sold",
    "rented",
  ] );

  private readonly FURNISHING = new Set<string>( [
    "furnished",
    "semi-furnished",
    "unfurnished",
  ] );

  private readonly CONDITIONS = new Set<string>( [
    "new",
    "old",
    "excellent",
    "good",
    "needs renovation",
  ] );

  private readonly OWNERSHIP = new Set<string>( [
    "freehold",
    "leasehold",
    "company",
    "trust",
  ] );

  private readonly AVAILABILITY = new Set<string>( [
    "available",
    "not available",
    "pending",
    "ready to move",
  ] );

  private readonly VERIFICATION = new Set<string>( [
    "pending",
    "verified",
    "rejected",
    "approved",
  ] );

  private readonly PRIORITY = new Set<string>( [ "high", "medium", "low" ] );

  private readonly STATUS = new Set<string>( [ "draft", "published", "archived" ] );

  private readonly MAX_IMAGES_PER_PROPERTY = 50;

  /* ------------------------------------------------------------------------ *
   * MIME configuration (shared between insert & update)
   * ------------------------------------------------------------------------ */

  private readonly ALLOWED_DOCUMENT_TYPES = new Set<string>( [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    "application/rtf",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    "text/csv",
    "text/tab-separated-values",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.presentationml.template",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/pdf",
    "text/plain",
  ] );

  private readonly ALLOWED_IMAGE_TYPES = new Set<string>( [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "image/webp",
    "image/svg+xml",
  ] );

  /* ------------------------------------------------------------------------ *
   * Router
   * ------------------------------------------------------------------------ */

  private readonly router: Router;

  constructor () {
    this.router = express.Router();
    this.registerRoutes();
  }

  get route(): Router {
    return this.router;
  }

  /* ====================================================================== *
   * ROUTE REGISTRATION
   * ====================================================================== */

  private registerRoutes(): void {
    // CRUD
    this.insertProperty();
    this.updateProperty();
    this.getAllPropertiesWithPagination();
    this.getSinglePropertyById();
    this.getPropertySectionById();
    this.deleteProperty();
    this.getAllProperties();
    this.getAllPropertiesCount();

    // Dashboard
    this.dashboardPortfolioSummary();
    this.dashboardCountryDistribution();
    this.dashboardMaintenanceSummary();
    this.dashboardPropertyTrends();
    this.dashboardStatusCounts();
    this.dashboardTopCities();
    this.dashboardPriceHistogram();
  }

  /* ====================================================================== *
   * CRUD ENDPOINTS
   * ====================================================================== */

  // ---------------------------------------------------------------------- //
  // INSERT
  // POST /api-property/insert-property/:propertyID
  // ---------------------------------------------------------------------- //

  private insertProperty(): void {
    this.router.post(
      "/insert-property/:propertyID",
      async (
        req: Request<{ propertyID: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          // 1) Sanitize & validate ID
          const propertyID: string = this.s( req.params.propertyID );
          if ( !propertyID ) {
            ApiResponseBuilder.notFound( res, "Property ID missing in URL." );
            return;
          }

          // 2) Parse multipart body + persist files via FileUploader
          const filesByField: UploadResultPacket =
            await FileUploader.handleMultiFieldUpload(
              `properties/${ propertyID }`,
              [
                { name: "images", maxCount: this.MAX_IMAGES_PER_PROPERTY },
                { name: "documents", maxCount: 20 },
              ],
              req,
              {
                allowedMimeTypesByField: {
                  images: this.ALLOWED_IMAGE_TYPES,
                  documents: this.ALLOWED_DOCUMENT_TYPES,
                },
                maxFileSizeMb: 25,
                maxFiles: this.MAX_IMAGES_PER_PROPERTY + 20,
              }
            );

          const imagesIn: FileMetaPacket[] = filesByField.byField.images ?? [];
          const docsIn: FileMetaPacket[] = filesByField.byField.documents ?? [];

          // 3) Build media arrays (final URLs, no tempImages)
          const images: UploadedImage[] = [];
          const documents: UploadedDocument[] = [];

          for ( const f of docsIn ) {
            documents.push( {
              originalname: f.originalName.trim(),
              filename: f.storedName.trim(),
              mimetype: f.mimeType.trim(),
              size: f.sizeBytes,
              documentURL: `${ req.protocol }://${ req.get(
                "host"
              ) }/uploads/properties/${ propertyID }/documents/${ f.storedName }`,
            } );
          }

          for ( const f of imagesIn ) {
            images.push( {
              originalname: f.originalName.trim(),
              filename: f.storedName.trim(),
              mimetype: f.mimeType.trim(),
              size: f.sizeBytes,
              imageURL: `${ req.protocol }://${ req.get(
                "host"
              ) }/uploads/properties/${ propertyID }/images/${ f.storedName }`,
            } );
          }

          // 4) Validate payload (insert mode)
          const { data, errors } = this.buildValidatedPayload( req, {
            images,
            documents,
            isUpdate: false,
          } );

          data.id = propertyID;

          if ( errors.length ) {
            ApiResponseBuilder.validationError(
              res,
              `Validation failed ${ errors }`
            );
            return;
          }

          // 5) Persist
          const inserted = await new PropertyModel( data as IProperty ).save();

          // 6) Notify
          const notificationService = new NotificationService();
          const io = req.app.get( "io" ) as import( "socket.io" ).Server;

          await notificationService.createNotification(
            {
              title: "New Property",
              body: `A new property "${ inserted.title }" has been added.`,
              type: "create",
              severity: "info",
              audience: {
                mode: "role",
                roles: [ "admin", "agent", "manager", "operator" ],
              },
              channels: [ "inapp", "email" ],
              metadata: {
                refId: propertyID,
                data: { property: inserted },
              },
            },
            ( rooms, payload ) =>
              rooms.forEach( ( room ) =>
                io.to( room ).emit( "notification.new", payload )
              )
          );

          ApiResponseBuilder.created(
            res,
            "Property inserted successfully",
            data
          );
          return;
        } catch ( error: unknown ) {
          console.error( "[insert-property] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // UPDATE
  // PUT /api-property/update-property/:id
  // ---------------------------------------------------------------------- //

  private updateProperty(): void {
    this.router.put(
      "/update-property/:id",
      async ( req: Request<{ id: string; }>, res: Response ): Promise<void> => {
        try {
          // 1) Property ID from URL
          const propertyID: string = this.s( req.params.id );
          if ( !propertyID ) {
            ApiResponseBuilder.validationError(
              res,
              "Property ID is required in URL."
            );
            return;
          }

          // 2) Parse multipart (body + files)
          const filesByField: UploadResultPacket =
            await FileUploader.handleMultiFieldUpload(
              `properties/${ propertyID }`,
              [ { name: "images" }, { name: "documents" } ],
              req,
              {
                allowedMimeTypesByField: {
                  images: this.ALLOWED_IMAGE_TYPES,
                  documents: this.ALLOWED_DOCUMENT_TYPES,
                },
                maxFileSizeMb: 25,
                maxFiles: this.MAX_IMAGES_PER_PROPERTY + 20,
              }
            );

          const imagesIn: FileMetaPacket[] = filesByField.byField.images ?? [];
          const docsIn: FileMetaPacket[] = filesByField.byField.documents ?? [];

          // 3) Existing media
          const existingImages = this.parseJSON<UploadedImage[]>(
            req.body.existingImages,
            []
          );
          const existingDocs = this.parseJSON<UploadedDocument[]>(
            req.body.existingDocuments,
            []
          );

          if ( !Array.isArray( existingImages ) || !Array.isArray( existingDocs ) ) {
            ApiResponseBuilder.badRequest(
              res,
              "existingImages / existingDocuments must be arrays"
            );
            return;
          }

          const Images: UploadedImage[] = [ ...existingImages ];
          const Documents: UploadedDocument[] = [ ...existingDocs ];

          // 4) Remove images → recyclebin
          const removeImages = this.parseJSON<UploadedImage[]>(
            req.body.removeImages,
            []
          );

          if ( Array.isArray( removeImages ) && removeImages.length ) {
            const pathsToRecycle: string[] = [];

            for ( const img of removeImages ) {
              if ( !img?.filename ) continue;

              const rel = `uploads/properties/${ propertyID }/images/${ img.filename }`;
              pathsToRecycle.push( rel );

              const idx = Images.findIndex(
                ( x ) => x.filename === img.filename
              );
              if ( idx >= 0 ) Images.splice( idx, 1 );
            }

            if ( pathsToRecycle.length ) {
              try {
                await FileUploader.moveToRecycleBin(
                  "properties",
                  propertyID,
                  pathsToRecycle
                );
              } catch ( e ) {
                console.warn(
                  "[update-property] failed moving images to recyclebin:",
                  e
                );
              }
            }
          }

          // 5) Remove docs → recyclebin
          const removeDocs = this.parseJSON<UploadedDocument[]>(
            req.body.removeDocuments,
            []
          );

          if ( Array.isArray( removeDocs ) && removeDocs.length ) {
            const pathsToRecycle: string[] = [];

            for ( const d of removeDocs ) {
              if ( !d?.filename ) continue;

              const rel = `uploads/properties/${ propertyID }/documents/${ d.filename }`;
              pathsToRecycle.push( rel );

              const idx = Documents.findIndex(
                ( x ) => x.filename === d.filename
              );
              if ( idx >= 0 ) Documents.splice( idx, 1 );
            }

            if ( pathsToRecycle.length ) {
              try {
                await FileUploader.moveToRecycleBin(
                  "properties",
                  propertyID,
                  pathsToRecycle
                );
              } catch ( e ) {
                console.warn(
                  "[update-property] failed moving docs to recyclebin:",
                  e
                );
              }
            }
          }

          // 6) Accept newly uploaded images
          for ( const f of imagesIn ) {
            Images.push( {
              originalname: f.originalName.trim(),
              filename: f.storedName.trim(),
              mimetype: f.mimeType.trim(),
              size: f.sizeBytes,
              imageURL: `${ req.protocol }://${ req.get(
                "host"
              ) }/uploads/properties/${ propertyID }/images/${ f.storedName }`,
            } );
          }

          // 7) Accept newly uploaded documents
          for ( const f of docsIn ) {
            Documents.push( {
              originalname: f.originalName.trim(),
              filename: f.storedName.trim(),
              mimetype: f.mimeType.trim(),
              size: f.sizeBytes,
              documentURL: `${ req.protocol }://${ req.get(
                "host"
              ) }/uploads/properties/${ propertyID }/documents/${ f.storedName }`,
            } );
          }

          // 8) Validate (update mode)
          const { data, errors } = this.buildValidatedPayload( req, {
            images: Images,
            documents: Documents,
            isUpdate: true,
          } );

          data.id = propertyID;

          if ( errors.length ) {
            ApiResponseBuilder.validationError(
              res,
              `Validation failed: ${ errors }`
            );
            return;
          }

          const updated = await PropertyModel.findOneAndUpdate(
            { id: propertyID },
            { $set: data },
            { new: true }
          ).lean<IProperty>();

          if ( !updated ) {
            ApiResponseBuilder.notFound(
              res,
              "Property not found or update failed."
            );
            return;
          }

          // 9) Notify
          try {
            const notificationService = new NotificationService();
            const io = req.app.get(
              "io"
            ) as import( "socket.io" ).Server | undefined;

            if ( io ) {
              await notificationService.createNotification(
                {
                  title: "Update Property",
                  body: `Property with ID ${ propertyID } has been updated.`,
                  type: "update",
                  severity: "info",
                  audience: {
                    mode: "role",
                    roles: [ "admin", "operator" ],
                  },
                  channels: [ "inapp", "email" ],
                  metadata: {
                    refId: propertyID,
                    data: {
                      property: updated,
                      updatedAt: new Date().toISOString(),
                      propertyID,
                    },
                  },
                  target: { kind: "Property", refId: propertyID },
                },
                ( rooms, payload ) =>
                  rooms.forEach( ( room ) =>
                    io.to( room ).emit( "notification.new", payload )
                  )
              );
            }
          } catch ( e ) {
            console.warn( "[update-property] notification failed:", e );
          }

          ApiResponseBuilder.ok(
            res,
            "property",
            updated,
            "Property updated successfully."
          );
          return;
        } catch ( error: unknown ) {
          console.error(
            "[update-property] error:",
            ( error as any )?.stack || error
          );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET ALL WITH PAGINATION + FILTERS
  // GET /api-property/get-all-properties-with-pagination/:start/:end
  // ---------------------------------------------------------------------- //

  private getAllPropertiesWithPagination(): void {
    this.router.get(
      "/get-all-properties-with-pagination/:start/:end/",
      async (
        req: Request<{ start: string; end: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const start = Math.max( 0, parseInt( req.params.start, 10 ) );
          const end = Math.max( 1, parseInt( req.params.end, 10 ) );

          if ( Number.isNaN( start ) || Number.isNaN( end ) || end <= start ) {
            ApiResponseBuilder.badRequest(
              res,
              "Invalid start or end parameters."
            );
            return;
          }

          const limit = end - start;
          const rawSearch = this.s( req.query.search );
          const rawFilter = this.s( req.query.filter );

          const defaultFilter = {
            minPrice: 0,
            maxPrice: Number.MAX_SAFE_INTEGER,
            beds: "",
            bathrooms: "",
            amenities: [] as string[],
            type: "",
            status: "",
          };

          const filterData = rawFilter
            ? this.parseJSON<typeof defaultFilter>( rawFilter, defaultFilter )
            : defaultFilter;

          const and: any[] = [];

          if ( rawSearch ) {
            const rx = new RegExp( rawSearch, "i" );
            and.push( {
              $or: [
                { title: { $regex: rx } },
                { type: { $regex: rx } },
                { status: { $regex: rx } },
                { "address.country": { $regex: rx } },
              ],
            } );
          }

          and.push( {
            price: {
              $gte: Number( filterData.minPrice ) || 0,
              $lte:
                Number( filterData.maxPrice ) || Number.MAX_SAFE_INTEGER,
            },
          } );

          if ( filterData.beds === "10+" ) {
            and.push( { bedrooms: { $gte: 10 } } );
          } else if ( filterData.beds ) {
            and.push( {
              bedrooms:
                Number.parseInt( filterData.beds, 10 ) || 0,
            } );
          }

          if ( filterData.bathrooms === "10+" ) {
            and.push( { bathrooms: { $gte: 10 } } );
          } else if ( filterData.bathrooms ) {
            and.push( {
              bathrooms:
                Number.parseInt( filterData.bathrooms, 10 ) || 0,
            } );
          }

          if ( filterData.type ) {
            const t = filterData.type.toLowerCase();
            if ( this.PROPERTY_TYPES.has( t ) ) and.push( { type: t } );
          }

          if ( filterData.status ) {
            const st = filterData.status.toLowerCase();
            if ( this.STATUS.has( st ) ) and.push( { status: st } );
          }

          if (
            Array.isArray( filterData.amenities ) &&
            filterData.amenities.length
          ) {
            and.push( {
              featuresAndAmenities: { $all: filterData.amenities },
            } );
          }

          const match = and.length ? { $and: and } : {};

          const properties = await PropertyModel.aggregate<IProperty>( [
            { $match: match },
            {
              $addFields: {
                priorityOrder: {
                  $switch: {
                    branches: [
                      { case: { $eq: [ "$priority", "high" ] }, then: 1 },
                      { case: { $eq: [ "$priority", "medium" ] }, then: 2 },
                      { case: { $eq: [ "$priority", "low" ] }, then: 3 },
                    ],
                    default: 4,
                  },
                },
              },
            },
            { $sort: { priorityOrder: 1, updatedAt: -1 } },
            { $skip: start },
            { $limit: limit },
          ] );

          const total = await PropertyModel.countDocuments( match );

          const page = Math.floor( start / limit ) + 1;
          const totalPages = total > 0 ? Math.ceil( total / limit ) : 0;
          const hasResults = total > 0;
          const index = page > 0 ? page - 1 : 0;

          const pagination: PaginationMeta = {
            index,
            limit,
            total,
            start,
            end,
            hasNext: page < totalPages,
            hasPrevious: page > 1 && totalPages > 0,
            hasResults,
          };

          if ( rawSearch && rawSearch.trim() !== "" ) {
            pagination.search = rawSearch.trim();
          }

          ApiResponseBuilder.ok(
            res,
            "properties",
            properties,
            "Properties fetched successfully.",
            { pagination }
          );
          return;
        } catch ( error ) {
          console.error(
            "[get-all-properties-with-pagination] error:",
            error
          );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET SINGLE BY ID
  // GET /api-property/get-single-property-by-id/:id
  // ---------------------------------------------------------------------- //

  private getSinglePropertyById(): void {
    this.router.get(
      "/get-single-property-by-id/:id",
      async (
        req: Request<{ id: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const id = this.s( req.params.id );

          if ( !id ) {
            ApiResponseBuilder.validationError(
              res,
              "Property ID is required!"
            );
            return;
          }

          const property = await PropertyModel.findOne( { id } ).lean<IProperty>();

          if ( !property ) {
            ApiResponseBuilder.notFound( res, "Property Not Found!" );
            return;
          }

          ApiResponseBuilder.ok(
            res,
            "property",
            property,
            "Property fetched successfully."
          );
          return;
        } catch ( error ) {
          console.error( "[get-single-property-by-id] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET SINGLE PROPERTY SECTION(S) BY ID
  // GET /api-property/get-single-property-section-by-id/:id?sections=a,b,c
  // ---------------------------------------------------------------------- //

  private getPropertySectionById(): void {
    this.router.get(
      "/get-single-property-section-by-id/:id",
      async (
        req: Request<
          { id: string; },
          unknown,
          unknown,
          { sections?: string; }
        >,
        res: Response
      ): Promise<void> => {
        try {
          const rawId: string = req.params.id;
          const rawSections: string | undefined = req.query.sections;

          const id: string = this.s( rawId );

          if ( !id ) {
            ApiResponseBuilder.validationError(
              res,
              "Property ID is required!"
            );
            return;
          }

          if ( !rawSections ) {
            ApiResponseBuilder.validationError(
              res,
              'At least one section must be provided in the "sections" query parameter.'
            );
            return;
          }

          const requestedSections: string[] = rawSections
            .split( "," )
            .map( ( s ) => this.s( s ).toLowerCase() )
            .filter( ( s ) => s.length > 0 );

          if ( !requestedSections.length ) {
            ApiResponseBuilder.validationError(
              res,
              "Invalid property section list!"
            );
            return;
          }

          const notAllowedSections: string[] = [
            "internalNote",
            "status",
            "verificationStatus",
            "owner",
            "addedBy",
          ];

          const safeSections = requestedSections.filter(
            ( section ) => !notAllowedSections.includes( section )
          );

          if ( !safeSections.length ) {
            ApiResponseBuilder.validationError(
              res,
              "Requested section(s) are not allowed!"
            );
            return;
          }

          const projectionString = `${ safeSections.join( " " ) } -_id`;

          const property = await PropertyModel.findOne( { id } )
            .select( projectionString )
            .lean<IProperty>()
            .exec();

          if ( !property ) {
            ApiResponseBuilder.notFound( res, "Property Not Found!" );
            return;
          }

          const values: Record<string, unknown> = {};
          for ( const section of safeSections ) {
            const value = property[ section as keyof IProperty ];
            if ( typeof value !== "undefined" ) {
              values[ section ] = value;
            }
          }

          if ( !Object.keys( values ).length ) {
            ApiResponseBuilder.notFound(
              res,
              "Requested section(s) not found on this property!"
            );
            return;
          }

          ApiResponseBuilder.ok(
            res,
            "other",
            { id, sections: safeSections, values },
            "Property section(s) fetched successfully."
          );
          return;
        } catch ( error ) {
          console.error(
            "[get-single-property-section-by-id] error:",
            error
          );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // DELETE
  // DELETE /api-property/delete-property/:id/:username
  // ---------------------------------------------------------------------- //

  private deleteProperty(): void {
    this.router.delete(
      "/delete-property/:id/:username",
      async (
        req: Request<{ id: string; username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const safeID = this.s( req.params.id );
          const urlUsername = this.s( req.params.username );

          if ( !safeID ) {
            ApiResponseBuilder.validationError(
              res,
              "Property ID is required."
            );
            return;
          }
          if ( !urlUsername ) {
            ApiResponseBuilder.validationError(
              res,
              "Property deletor is required."
            );
            return;
          }

          // @ts-ignore optional auth middleware
          const actorUsername: string =
            ( req.user?.username as string | undefined )?.trim() ||
            urlUsername;

          const property = await PropertyModel.findOne( { id: safeID } ).lean<IProperty>();

          if ( !property ) {
            ApiResponseBuilder.notFound( res, "Property not found." );
            return;
          }

          const srcDir = path.join( this.DEFAULT_UPLOAD_PATH, safeID );
          let dstDir = path.join( this.DEFAULT_RECYCLE_PATH, safeID );

          if ( await fse.pathExists( dstDir ) ) {
            dstDir = path.join(
              this.DEFAULT_RECYCLE_PATH,
              `${ safeID }_${ Date.now() }`
            );
          }

          if ( await fse.pathExists( srcDir ) ) {
            await fse.move( srcDir, dstDir, { overwrite: false } );
          } else {
            await fse.mkdirp( dstDir );
          }

          const snapshotPath = path.join( dstDir, "data.json" );
          await fse.writeJson( snapshotPath, property, { spaces: 2 } );

          // Notifications
          try {
            const io = req.app.get(
              "io"
            ) as import( "socket.io" ).Server | undefined;

            if ( io ) {
              const notificationService = new NotificationService();
              await notificationService.createNotification(
                {
                  title: "Delete Property",
                  body: `Property "${ ( property as any )?.title ?? safeID
                    }" has been deleted.`,
                  type: "delete",
                  severity: "warning",
                  audience: {
                    mode: "role",
                    roles: [ "admin", "agent", "manager", "operator" ],
                  },
                  channels: [ "inapp", "email" ],
                  metadata: {
                    refId: safeID,
                    data: {
                      deletedBy: actorUsername,
                      deletedAt: new Date().toISOString(),
                      propertyId: safeID,
                      snapshot: property,
                      recyclebin: {
                        folder: dstDir,
                        dataJson: snapshotPath,
                        base: `${ req.protocol }://${ req.get( "host" ) }/${ this.DEFAULT_RECYCLE_URL
                          }/${ path.basename( dstDir ) }`,
                      },
                    },
                  },
                  target: { kind: "Property", refId: safeID },
                },
                ( rooms, payload ) =>
                  rooms.forEach( ( room ) =>
                    io.to( room ).emit( "notification.new", payload )
                  )
              );
            }
          } catch ( notifyErr ) {
            console.warn( "[delete-property] notification failed:", notifyErr );
          }

          const delRes = await PropertyModel.deleteOne( { id: safeID } ).lean();

          if ( delRes.deletedCount !== 1 ) {
            ApiResponseBuilder.conflict(
              res,
              "Delete conflict: document was not removed from DB."
            );
            return;
          }

          ApiResponseBuilder.noContent( res, "Property deleted." );
          return;
        } catch ( error: any ) {
          console.error( "[delete-property] error:", error?.message || error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET ALL (NO PAGINATION)
  // GET /api-property/get-all-properties/
  // ---------------------------------------------------------------------- //

  private getAllProperties(): void {
    this.router.get(
      "/get-all-properties/",
      async ( _req: Request, res: Response ): Promise<void> => {
        try {
          const properties = ( await PropertyModel.find()
            .sort( { createdAt: -1 } )
            .lean<IProperty>()
            .exec() ) as unknown as IProperty[];

          ApiResponseBuilder.ok(
            res,
            "properties",
            properties,
            "Properties fetched successfully."
          );
          return;
        } catch ( error ) {
          console.error( "[get-all-properties] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET ALL COUNT
  // GET /api-property/get-all-properties-count/
  // ---------------------------------------------------------------------- //

  private getAllPropertiesCount(): void {
    this.router.get(
      "/get-all-properties-count/",
      async ( _req: Request, res: Response ): Promise<void> => {
        try {
          const total = await PropertyModel.countDocuments();

          const pagination: PaginationMeta = {
            total,
          };

          ApiResponseBuilder.ok(
            res,
            "other",
            {},
            "Properties total fetched successfully.",
            { pagination }
          );
          return;
        } catch ( error ) {
          console.error( "[get-all-properties-count] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  /* ====================================================================== *
   * DASHBOARD ENDPOINTS
   * ====================================================================== */

  /**
   * Common scoping helper:
   * - ?scope=mine&username=<u> → restricts to addedBy.username == <u>
   * - ?owner=<ownerName>       → restricts to owner == <ownerName>
   * - Excludes archived by default unless ?includeArchived=true
   */
  private buildScopeMatch( req: Request ): Record<string, unknown> {
    const match: Record<string, unknown> = {};
    const includeArchived = this.s( req.query.includeArchived ) === "true";

    if ( !includeArchived ) {
      match.status = { $ne: "archived" };
    }

    const scope = this.s( req.query.scope );
    const username = this.s( req.query.username );

    if ( scope === "mine" && username ) {
      match[ "addedBy.username" ] = username;
    }

    const owner = this.s( req.query.owner );
    if ( owner ) {
      match[ "owner" ] = owner;
    }

    return match;
  }

  // ---------------------------------------------------------------------- //
  // GET /api-property/dashboard/portfolio-summary
  // ---------------------------------------------------------------------- //

  private dashboardPortfolioSummary(): void {
    this.router.get(
      "/dashboard/portfolio-summary",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const match = this.buildScopeMatch( req );

          const [ agg ] = await PropertyModel.aggregate<{
            totalProperties: number;
            occ: number;
            series: number[];
          }>( [
            { $match: match },
            {
              $facet: {
                totals: [ { $count: "total" } ],
                occ: [
                  {
                    $match: {
                      $or: [
                        { listing: { $in: [ "rented", "sold" ] } },
                        { availabilityStatus: "not available" },
                      ],
                    },
                  },
                  { $count: "occ" },
                ],
                series: [
                  ...this.monthlySeriesFacet( 8, "createdAt", {
                    $or: [
                      { listing: { $in: [ "rented", "sold" ] } },
                      { availabilityStatus: "not available" },
                    ],
                  } ),
                ],
              },
            },
            {
              $project: {
                totalProperties: {
                  $ifNull: [ { $arrayElemAt: [ "$totals.total", 0 ] }, 0 ],
                },
                occ: {
                  $ifNull: [ { $arrayElemAt: [ "$occ.occ", 0 ] }, 0 ],
                },
                series: "$series",
              },
            },
          ] );

          const total = agg?.totalProperties ?? 0;
          const occ = agg?.occ ?? 0;
          const occupancyPct =
            total > 0 ? Math.round( ( occ / total ) * 100 ) : 0;
          const series = Array.isArray( agg?.series ) ? agg.series : [];

          ApiResponseBuilder.ok(
            res,
            "other",
            { totalProperties: total, occupancyPct, series },
            "Portfolio summary"
          );
          return;
        } catch ( error ) {
          console.error( "[dashboard/portfolio-summary] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET /api-property/dashboard/country-distribution
  // ---------------------------------------------------------------------- //

  private dashboardCountryDistribution(): void {
    this.router.get(
      "/dashboard/country-distribution",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const match = this.buildScopeMatch( req );

          const rows = await PropertyModel.aggregate( [
            { $match: match },
            {
              $group: {
                _id: { $toUpper: "$address.country" },
                properties: { $sum: 1 },
                occ: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $in: [ "$listing", [ "rented", "sold" ] ] },
                          {
                            $eq: [ "$availabilityStatus", "not available" ],
                          },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
            {
              $project: {
                country: "$_id",
                properties: 1,
                occupancyPct: {
                  $cond: [
                    { $gt: [ "$properties", 0 ] },
                    {
                      $round: [
                        {
                          $multiply: [
                            { $divide: [ "$occ", "$properties" ] },
                            100,
                          ],
                        },
                        0,
                      ],
                    },
                    0,
                  ],
                },
              },
            },
            { $sort: { properties: -1 } },
          ] );

          ApiResponseBuilder.ok(
            res,
            "properties",
            rows,
            "Country distribution"
          );
          return;
        } catch ( error ) {
          console.error( "[dashboard/country-distribution] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET /api-property/dashboard/maintenance-summary
  // ---------------------------------------------------------------------- //

  private dashboardMaintenanceSummary(): void {
    this.router.get(
      "/dashboard/maintenance-summary",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const propertyScopeMatch = this.buildScopeMatch( req );

          const openComplaintStatuses: ComplaintStatus[] = [
            "new",
            "triaged",
            "in_progress",
            "awaiting_tenant",
            "reopened",
          ];

          type ComplaintForSummary = {
            propertyId?: string | null;
            status: ComplaintStatus;
          };

          const rawComplaints = await ComplaintModel.find( {
            status: { $in: openComplaintStatuses },
          } )
            .lean()
            .exec();

          const complaintsForSummary =
            rawComplaints as unknown as ComplaintForSummary[];

          const propertyIDs = Array.from(
            new Set(
              complaintsForSummary
                .map( ( c ) => c.propertyId )
                .filter(
                  (
                    id: string | null | undefined
                  ): id is string =>
                    typeof id === "string" && id.trim().length > 0
                )
                .map( ( id ) => id.trim() )
            )
          );

          if ( !propertyIDs.length ) {
            ApiResponseBuilder.ok(
              res,
              "other",
              { open: 0, series: [] },
              "Maintenance summary"
            );
            return;
          }

          const propertyMatch: Record<string, unknown> = {
            ...propertyScopeMatch,
            id: { $in: propertyIDs },
          };

          interface MaintenanceSummaryAgg {
            open: number;
            series: number[];
          }

          const [ agg ] =
            await PropertyModel.aggregate<MaintenanceSummaryAgg>( [
              { $match: propertyMatch },
              {
                $facet: {
                  open: [ { $count: "cnt" } ],
                  series: [ ...this.weeklySeriesFacet( 8, "updatedAt" ) ],
                },
              },
              {
                $project: {
                  open: {
                    $ifNull: [ { $arrayElemAt: [ "$open.cnt", 0 ] }, 0 ],
                  },
                  series: "$series",
                },
              },
            ] );

          ApiResponseBuilder.ok(
            res,
            "other",
            {
              open: agg?.open ?? 0,
              series: agg?.series ?? [],
            },
            "Maintenance summary"
          );
          return;
        } catch ( error ) {
          console.error(
            "[dashboard/maintenance-summary] error:",
            error
          );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET /api-property/dashboard/property-trends?range=6m|12m|24m
  // ---------------------------------------------------------------------- //

  private dashboardPropertyTrends(): void {
    this.router.get(
      "/dashboard/property-trends",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const rangeParam = this.s( req.query.range ) || "12m";
          const months =
            rangeParam === "6m" ? 6 : rangeParam === "24m" ? 24 : 12;

          const match = this.buildScopeMatch( req );

          const monthlyNew = await PropertyModel.aggregate( [
            { $match: match },
            ...this.monthBucketSeriesPipeline( "createdAt", months ),
          ] );

          const soldMatch = {
            ...match,
            $or: [
              { listing: { $in: [ "sold", "rented" ] } },
              { soldDate: { $type: "date" } },
              { rentedDate: { $type: "date" } },
            ],
          };

          const monthlySold = await PropertyModel.aggregate( [
            { $match: soldMatch },
            {
              $addFields: {
                effectiveDate: {
                  $ifNull: [
                    "$soldDate",
                    { $ifNull: [ "$rentedDate", "$updatedAt" ] },
                  ],
                },
              },
            },
            ...this.monthBucketSeriesPipeline( "effectiveDate", months ),
          ] );

          ApiResponseBuilder.ok(
            res,
            "other",
            {
              monthlyNew,
              monthlySold,
            },
            "Property trends"
          );
          return;
        } catch ( error ) {
          console.error( "[dashboard/property-trends] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET /api-property/dashboard/status-counts
  // ---------------------------------------------------------------------- //

  private dashboardStatusCounts(): void {
    this.router.get(
      "/dashboard/status-counts",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const match = this.buildScopeMatch( req );

          const rows = await PropertyModel.aggregate( [
            { $match: match },
            {
              $group: {
                _id: null,
                published: {
                  $sum: {
                    $cond: [ { $eq: [ "$status", "published" ] }, 1, 0 ],
                  },
                },
                draft: {
                  $sum: { $cond: [ { $eq: [ "$status", "draft" ] }, 1, 0 ] },
                },
                archived: {
                  $sum: {
                    $cond: [ { $eq: [ "$status", "archived" ] }, 1, 0 ],
                  },
                },
                available: {
                  $sum: {
                    $cond: [
                      { $eq: [ "$availabilityStatus", "available" ] },
                      1,
                      0,
                    ],
                  },
                },
                sold: {
                  $sum: {
                    $cond: [ { $eq: [ "$listing", "sold" ] }, 1, 0 ],
                  },
                },
                rented: {
                  $sum: {
                    $cond: [ { $eq: [ "$listing", "rented" ] }, 1, 0 ],
                  },
                },
                pending: {
                  $sum: {
                    $cond: [
                      { $eq: [ "$availabilityStatus", "pending" ] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ] );

          const base = rows?.[ 0 ] ?? {};

          ApiResponseBuilder.ok(
            res,
            "other",
            {
              published: base.published ?? 0,
              draft: base.draft ?? 0,
              archived: base.archived ?? 0,
              available: base.available ?? 0,
              sold: base.sold ?? 0,
              rented: base.rented ?? 0,
              pending: base.pending ?? 0,
            },
            "Status counts"
          );
          return;
        } catch ( error ) {
          console.error( "[dashboard/status-counts] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET /api-property/dashboard/top-cities?limit=8
  // ---------------------------------------------------------------------- //

  private dashboardTopCities(): void {
    this.router.get(
      "/dashboard/top-cities",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const limit = Math.max(
            1,
            Math.min(
              100,
              Number( this.s( req.query.limit ) ) || 8
            )
          );
          const match = this.buildScopeMatch( req );

          const rows = await PropertyModel.aggregate( [
            { $match: match },
            {
              $group: {
                _id: { city: { $toUpper: "$address.city" } },
                properties: { $sum: 1 },
                avgPrice: { $avg: "$price" },
              },
            },
            {
              $project: {
                _id: 0,
                city: "$_id.city",
                properties: 1,
                avgPrice: { $round: [ "$avgPrice", 0 ] },
              },
            },
            { $sort: { properties: -1 } },
            { $limit: limit },
          ] );

          ApiResponseBuilder.ok(
            res,
            "properties",
            rows,
            "Top cities by listings"
          );
          return;
        } catch ( error ) {
          console.error( "[dashboard/top-cities] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ---------------------------------------------------------------------- //
  // GET /api-property/dashboard/price-histogram?bins=10
  // ---------------------------------------------------------------------- //

  private dashboardPriceHistogram(): void {
    this.router.get(
      "/dashboard/price-histogram",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const binsRequested = Math.max(
            2,
            Math.min( 50, Number( this.s( req.query.bins ) ) || 10 )
          );
          const match = this.buildScopeMatch( req );

          const [ mm ] = await PropertyModel.aggregate( [
            { $match: match },
            {
              $group: {
                _id: null,
                min: { $min: "$price" },
                max: { $max: "$price" },
              },
            },
          ] );

          const min = Math.max( 0, Number( mm?.min ?? 0 ) );
          const max = Math.max( min, Number( mm?.max ?? 0 ) );

          if ( min === max ) {
            const count = await PropertyModel.countDocuments( match );
            ApiResponseBuilder.ok(
              res,
              "other",
              { bins: [ { from: min, to: max, count } ] },
              "Price histogram"
            );
            return;
          }

          const width = ( max - min ) / binsRequested;

          // ✅ Correct generic: document shape, not array-of-shape
          const rows = await PropertyModel.aggregate<{ _id: number; count: number; }>( [
            { $match: match },
            {
              $project: {
                price: 1,
                bin: {
                  $floor: {
                    $divide: [ { $subtract: [ "$price", min ] }, width ],
                  },
                },
              },
            },
            {
              $group: {
                _id: "$bin",
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ] );

          const out: Array<{ from: number; to: number; count: number; }> = [];

          for ( let i = 0; i < binsRequested; i++ ) {
            const from = Math.round( min + i * width );
            const to =
              i === binsRequested - 1
                ? Math.round( max )
                : Math.round( min + ( i + 1 ) * width );

            const row = rows.find( ( r ) => Number( r._id ) === i );
            out.push( { from, to, count: Number( row?.count ?? 0 ) } );
          }

          ApiResponseBuilder.ok( res, "other", { bins: out }, "Price histogram" );
          return;
        } catch ( error ) {
          console.error( "[dashboard/price-histogram] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }


  /* ====================================================================== *
   * PRIVATE HELPERS – BASIC CONVERSIONS
   * ====================================================================== */

  private isStr( v: unknown ): v is string {
    return typeof v === "string";
  }

  private s( v: unknown ): string {
    return this.isStr( v ) ? v.trim() : "";
  }

  private toLower( v: unknown ): string {
    return this.s( v ).toLowerCase();
  }

  private toNum( v: unknown, def = 0 ): number {
    const n = Number( this.s( v ) );
    return Number.isFinite( n ) ? n : def;
  }

  private toNonNeg( v: unknown, def = 0 ): number {
    return Math.max( 0, this.toNum( v, def ) );
  }

  private parseJSON<T>( v: unknown, fallback: T ): T {
    try {
      if ( v == null ) return fallback;
      if ( typeof v === "string" ) {
        const t = v.trim();
        if ( !t ) return fallback;
        return JSON.parse( t ) as T;
      }
      return v as T;
    } catch {
      return fallback;
    }
  }

  private toDateOrNull( v: unknown ): Date | null {
    const str = this.s( v );
    if ( !str ) return null;
    const d = new Date( str );
    return Number.isNaN( d.getTime() ) ? null : d;
  }

  private toDateOrThrow( v: unknown, field: string ): Date {
    const d = this.toDateOrNull( v );
    if ( !d ) throw new Error( `Invalid date for "${ field }"` );
    return d;
  }

  /* ====================================================================== *
   * PRIVATE HELPERS – SHAPE VALIDATION
   * ====================================================================== */

  private validateAddress( raw: unknown ): Address {
    const a = this.parseJSON<Address>( raw, {} as any );
    return {
      houseNumber: this.s( a.houseNumber ),
      street: this.s( ( a as any ).street ),
      city: this.s( a.city ),
      stateOrProvince: this.s( ( a as any ).stateOrProvince ),
      postcode: this.s( a.postcode ),
      country: this.s( a.country ),
    };
  }

  private validateCountryDetails( raw: unknown ): CountryDetails {
    const c = this.parseJSON<CountryDetails>( raw, {} as any );
    const out = { ...c } as CountryDetails;

    ( out.tld as any ) = Array.isArray( ( c as any ).tld )
      ? ( c as any ).tld
      : undefined;
    ( out.capital as any ) = Array.isArray( ( c as any ).capital )
      ? ( c as any ).capital
      : undefined;
    ( out.timezones as any ) = Array.isArray( ( c as any ).timezones )
      ? ( c as any ).timezones
      : undefined;
    ( out.continents as any ) = Array.isArray( ( c as any ).continents )
      ? ( c as any ).continents
      : undefined;
    ( out.latlng as any ) = Array.isArray( ( c as any ).latlng )
      ? ( c as any ).latlng
      : undefined;
    ( out.flags as any ) =
      typeof ( c as any ).flags === "object" ? ( c as any ).flags : ( {} as any );

    return out;
  }

  private validatePhoneNumber( row: unknown ): PhoneNumber {
    const a = this.parseJSON<PhoneNumber>( row, {} as any );
    return {
      code: this.validatePhoneCodeDetail( a.code ),
      number: this.s( a.number ),
    };
  }

  private validatePhoneCodeDetail( row: unknown ): CountryCodes {
    const a = this.parseJSON<CountryCodes>( row, {} as any );
    return {
      code: this.s( a.code ),
      name: this.s( a.name ),
      flags: this.validateCountryCodesFlags( a.flags ),
    };
  }

  private validateCountryCodesFlags( row: unknown ): {
    png: string;
    svg: string;
    alt?: string;
  } {
    const a = this.parseJSON<{ png: string; svg: string; alt?: string; }>(
      row,
      {} as any
    );
    const alt = this.s( a.alt );
    return {
      png: this.s( a.png ),
      svg: this.s( a.svg ),
      ...( alt ? { alt } : {} ),
    };
  }

  private validateAddedBy( raw: unknown ): AddedBy {
    const a = this.parseJSON<AddedBy>( raw, {} as any );
    return {
      username: this.s( a.username ),
      name: this.s( a.name ),
      email: this.s( a.email ),
      role: this.s( a.role ) as any,
      contactNumber: this.validatePhoneNumber( a.contactNumber ),
      addedAt: a?.addedAt
        ? this.toDateOrNull( a.addedAt ) || new Date()
        : new Date(),
    };
  }

  private validateLocation( raw: unknown ): GoogleMapLocation | undefined {
    const loc = this.parseJSON<GoogleMapLocation>( raw, {} as any );
    const lat = Number( ( loc as any ).lat );
    const lng = Number( ( loc as any ).lng );
    const embeddedUrl = this.s( ( loc as any ).embeddedUrl );

    if ( !Number.isFinite( lat ) || !Number.isFinite( lng ) ) return undefined;
    return { lat, lng, embeddedUrl };
  }

  /* ====================================================================== *
   * PRIVATE HELPERS – PAYLOAD BUILDER
   * ====================================================================== */

  private buildValidatedPayload(
    req: Request,
    ctx: {
      images: UploadedImage[];
      documents: UploadedDocument[];
      isUpdate: boolean;
    }
  ): { data: Partial<IProperty>; errors: string[]; } {
    const errors: string[] = [];
    const isUpdate = ctx.isUpdate;

    // Basic identity
    const id = this.s(
      ( req.params as any ).propertyID ||
      ( req.params as any ).id ||
      req.body.id
    );
    if ( !isUpdate && !id ) {
      errors.push(
        "id (as :propertyID in URL or body.id) is required."
      );
    }

    const title = this.s( req.body.title );
    if ( !isUpdate && !title ) errors.push( "title is required." );

    const type = this.toLower( req.body.type );
    if ( !isUpdate && !type ) errors.push( "type is required." );
    if ( type && !this.PROPERTY_TYPES.has( type ) ) {
      errors.push(
        `type must be one of: ${ Array.from( this.PROPERTY_TYPES ).join(
          ", "
        ) }`
      );
    }

    const listing = this.toLower( req.body.listing );
    if ( !isUpdate && !listing ) errors.push( "listing is required." );
    if ( listing && !this.LISTINGS.has( listing ) ) {
      errors.push(
        `listing must be one of: ${ Array.from( this.LISTINGS ).join(
          ", "
        ) }`
      );
    }

    const description = this.s( req.body.description );
    if ( !isUpdate && !description )
      errors.push( "description is required." );

    // Location
    const countryDetails = this.validateCountryDetails(
      req.body.countryDetails
    );
    const address = this.validateAddress( req.body.address );
    const location = this.validateLocation( req.body.location );

    // Specs
    const totalArea = this.toNonNeg( req.body.totalArea );
    const builtInArea = this.toNonNeg( req.body.builtInArea );
    const livingRooms = this.toNonNeg( req.body.livingRooms );
    const balconies = this.toNonNeg( req.body.balconies );
    const kitchen = this.toNonNeg( req.body.kitchen );
    const bedrooms = this.toNonNeg( req.body.bedrooms );
    const bathrooms = this.toNonNeg( req.body.bathrooms );
    const maidrooms = this.toNonNeg( req.body.maidrooms );
    const driverRooms = this.toNonNeg( req.body.driverRooms );

    const furnishingStatus = this.toLower( req.body.furnishingStatus );
    if ( !isUpdate && !furnishingStatus )
      errors.push( "furnishingStatus is required." );
    if ( furnishingStatus && !this.FURNISHING.has( furnishingStatus ) ) {
      errors.push(
        `furnishingStatus must be one of: ${ Array.from(
          this.FURNISHING
        ).join( ", " ) }`
      );
    }

    const totalFloors = this.toNonNeg( req.body.totalFloors );
    const numberOfParking = this.toNonNeg( req.body.numberOfParking );

    const builtYear = this.toNonNeg( req.body.builtYear );

    const propertyCondition = this.toLower( req.body.propertyCondition );
    if ( !isUpdate && !propertyCondition )
      errors.push( "propertyCondition is required." );
    if (
      propertyCondition &&
      !this.CONDITIONS.has( propertyCondition )
    ) {
      errors.push(
        `propertyCondition must be one of: ${ Array.from(
          this.CONDITIONS
        ).join( ", " ) }`
      );
    }

    const developerName = this.s( req.body.developerName );
    const projectName = this.s( req.body.projectName );

    const ownerShipType = this.toLower( req.body.ownerShipType );
    if ( !isUpdate && !ownerShipType )
      errors.push( "ownerShipType is required." );
    if ( ownerShipType && !this.OWNERSHIP.has( ownerShipType ) ) {
      errors.push(
        `ownerShipType must be one of: ${ Array.from(
          this.OWNERSHIP
        ).join( ", " ) }`
      );
    }

    // Financial
    const price = this.toNonNeg( req.body.price );
    const currency = this.s( req.body.currency ) || "lkr";

    const pricePerSqurFeet = this.toNonNeg(
      req.body.pricePerSqurFeet,
      totalArea > 0
        ? Number( ( price / totalArea ).toFixed( 2 ) )
        : 0
    );

    const expectedRentYearly = this.toNonNeg(
      req.body.expectedRentYearly
    );
    const expectedRentQuartely = this.toNonNeg(
      req.body.expectedRentQuartely
    );
    const expectedRentMonthly = this.toNonNeg(
      req.body.expectedRentMonthly
    );
    const expectedRentDaily = this.toNonNeg(
      req.body.expectedRentDaily
    );
    const maintenanceFees = this.toNonNeg( req.body.maintenanceFees );
    const serviceCharges = this.toNonNeg( req.body.serviceCharges );
    const transferFees = this.toNonNeg( req.body.transferFees );

    const availabilityStatus = this.toLower(
      req.body.availabilityStatus
    );
    if (
      availabilityStatus &&
      !this.AVAILABILITY.has( availabilityStatus )
    ) {
      errors.push(
        `availabilityStatus must be one of: ${ Array.from(
          this.AVAILABILITY
        ).join( ", " ) }`
      );
    }

    const featuresAndAmenities = this.parseJSON<string[]>(
      req.body.featuresAndAmenities,
      []
    );
    if ( !Array.isArray( featuresAndAmenities ) ) {
      errors.push( "featuresAndAmenities must be an array of strings." );
    }

    // Media
    const images = ctx.images || [];
    const documents = ctx.documents || [];
    if ( !isUpdate ) {
      if ( !images.length )
        errors.push( "At least one image is required." );
      if ( !documents.length )
        errors.push( "At least one document is required." );
    }

    // Listing dates
    const listingDate = isUpdate
      ? this.toDateOrNull( req.body.listingDate ) || undefined
      : this.toDateOrThrow( req.body.listingDate, "listingDate" );

    const availabilityDate = this.toDateOrNull(
      req.body.availabilityDate
    );
    const listingExpiryDate = this.toDateOrNull(
      req.body.listingExpiryDate
    );
    const rentedDate = this.toDateOrNull( req.body.rentedDate );
    const soldDate = this.toDateOrNull( req.body.soldDate );

    const addedBy = this.validateAddedBy( req.body.addedBy );
    if ( !isUpdate ) {
      if ( !addedBy.username )
        errors.push( "addedBy.username is required." );
      if ( !addedBy.email )
        errors.push( "addedBy.email is required." );
      if ( !addedBy.role ) errors.push( "addedBy.role is required." );
    }

    const owner = this.s( req.body.owner );
    if ( !isUpdate && !owner ) errors.push( "owner is required." );

    const referenceCode = this.s( req.body.referenceCode );
    if ( !isUpdate && !referenceCode )
      errors.push( "referenceCode is required." );

    const verificationStatus =
      this.toLower( req.body.verificationStatus ) || "verified";
    if (
      verificationStatus &&
      !this.VERIFICATION.has( verificationStatus )
    ) {
      errors.push(
        `verificationStatus must be one of: ${ Array.from(
          this.VERIFICATION
        ).join( ", " ) }`
      );
    }

    const priority =
      this.toLower( req.body.priority ) || "medium";
    if ( priority && !this.PRIORITY.has( priority ) ) {
      errors.push(
        `priority must be one of: ${ Array.from( this.PRIORITY ).join(
          ", "
        ) }`
      );
    }

    const status =
      this.toLower( req.body.status ) || "published";
    if ( status && !this.STATUS.has( status ) ) {
      errors.push(
        `status must be one of: ${ Array.from( this.STATUS ).join(
          ", "
        ) }`
      );
    }

    const internalNote = this.s( req.body.internalNote );

    // Final data object
    const data: Partial<IProperty> = {};

    if ( id ) data.id = id;
    if ( title ) data.title = title;
    if ( type ) data.type = type as any;
    if ( listing ) data.listing = listing as any;
    if ( description || !isUpdate ) data.description = description;

    if ( Object.keys( countryDetails || {} ).length ) {
      data.countryDetails = countryDetails;
    }
    if ( Object.keys( address || {} ).length ) {
      data.address = address;
    }
    if ( location ) data.location = location;

    if ( !isUpdate || req.body.totalArea != null ) {
      data.totalArea = totalArea;
    }
    if ( !isUpdate || req.body.builtInArea != null ) {
      data.builtInArea = builtInArea;
    }
    if ( !isUpdate || req.body.livingRooms != null ) {
      data.livingRooms = livingRooms;
    }
    if ( !isUpdate || req.body.balconies != null ) {
      data.balconies = balconies;
    }
    if ( !isUpdate || req.body.kitchen != null ) {
      data.kitchen = kitchen;
    }
    if ( !isUpdate || req.body.bedrooms != null ) {
      data.bedrooms = bedrooms;
    }
    if ( !isUpdate || req.body.bathrooms != null ) {
      data.bathrooms = bathrooms;
    }
    if ( !isUpdate || req.body.maidrooms != null ) {
      data.maidrooms = maidrooms;
    }
    if ( !isUpdate || req.body.driverRooms != null ) {
      data.driverRooms = driverRooms;
    }

    if ( furnishingStatus ) {
      data.furnishingStatus = furnishingStatus as any;
    }

    if ( !isUpdate || req.body.totalFloors != null ) {
      data.totalFloors = totalFloors;
    }
    if ( !isUpdate || req.body.numberOfParking != null ) {
      data.numberOfParking = numberOfParking;
    }

    if ( !isUpdate || req.body.builtYear != null ) {
      data.builtYear = builtYear;
    }
    if ( propertyCondition ) {
      data.propertyCondition = propertyCondition as any;
    }
    if ( developerName || !isUpdate ) {
      data.developerName = developerName;
    }
    if ( projectName || !isUpdate ) {
      data.projectName = projectName;
    }
    if ( ownerShipType ) {
      data.ownerShipType = ownerShipType as any;
    }

    if ( !isUpdate || req.body.price != null ) {
      data.price = price;
    }
    if ( currency || !isUpdate ) data.currency = currency;

    if ( !isUpdate || req.body.pricePerSqurFeet != null ) {
      data.pricePerSqurFeet = pricePerSqurFeet;
    }
    if ( !isUpdate || req.body.expectedRentYearly != null ) {
      data.expectedRentYearly = expectedRentYearly;
    }
    if ( !isUpdate || req.body.expectedRentQuartely != null ) {
      data.expectedRentQuartely = expectedRentQuartely;
    }
    if ( !isUpdate || req.body.expectedRentMonthly != null ) {
      data.expectedRentMonthly = expectedRentMonthly;
    }
    if ( !isUpdate || req.body.expectedRentDaily != null ) {
      data.expectedRentDaily = expectedRentDaily;
    }
    if ( !isUpdate || req.body.maintenanceFees != null ) {
      data.maintenanceFees = maintenanceFees;
    }
    if ( !isUpdate || req.body.serviceCharges != null ) {
      data.serviceCharges = serviceCharges;
    }
    if ( !isUpdate || req.body.transferFees != null ) {
      data.transferFees = transferFees;
    }

    if ( availabilityStatus ) {
      data.availabilityStatus = availabilityStatus as any;
    }

    if ( Array.isArray( featuresAndAmenities ) ) {
      data.featuresAndAmenities = featuresAndAmenities;
    }

    if ( ctx.images?.length ) data.images = ctx.images;
    if ( ctx.documents?.length ) data.documents = ctx.documents;

    if ( this.isStr( req.body.videoTour ) ) {
      data.videoTour = this.s( req.body.videoTour );
    }
    if ( this.isStr( req.body.virtualTour ) ) {
      data.virtualTour = this.s( req.body.virtualTour );
    }

    if ( listingDate !== undefined ) {
      data.listingDate = listingDate as any;
    }
    if ( availabilityDate !== null ) {
      data.availabilityDate = availabilityDate as any;
    }
    if ( listingExpiryDate !== null ) {
      data.listingExpiryDate = listingExpiryDate as any;
    }
    if ( rentedDate !== null ) {
      data.rentedDate = rentedDate as any;
    }
    if ( soldDate !== null ) {
      data.soldDate = soldDate as any;
    }

    if ( Object.keys( addedBy || {} ).length ) {
      data.addedBy = addedBy;
    }
    if ( owner || !isUpdate ) data.owner = owner;
    if ( referenceCode || !isUpdate ) {
      data.referenceCode = referenceCode;
    }
    if ( verificationStatus ) {
      data.verificationStatus = verificationStatus as any;
    }
    if ( priority ) {
      data.priority = priority as any;
    }
    if ( status ) {
      data.status = status as any;
    }
    if ( this.isStr( req.body.internalNote ) ) {
      data.internalNote = internalNote;
    }

    return { data, errors };
  }

  /* ====================================================================== *
   * PRIVATE HELPERS – ANALYTICS PIPELINES
   * ====================================================================== */

  /**
   * FACET helper: Occupancy (or any) sparkline by month (last N) on a condition.
   * Intended to be used inside a $facet as { series: [ ... ] }.
   */
  private monthlySeriesFacet(
    lastN: number,
    dateField: string,
    extraMatch?: Record<string, unknown>
  ): PipelineStage.FacetPipelineStage[] {
    const from = new Date();
    from.setMonth( from.getMonth() - ( lastN - 1 ), 1 );
    from.setHours( 0, 0, 0, 0 );

    const stages: PipelineStage.FacetPipelineStage[] = [];

    if ( extraMatch && Object.keys( extraMatch ).length ) {
      stages.push( { $match: extraMatch } );
    }

    stages.push(
      { $match: { [ dateField ]: { $gte: from } } },
      {
        $group: {
          _id: {
            y: { $year: `$${ dateField }` },
            m: { $month: `$${ dateField }` },
          },
          cnt: { $sum: 1 },
        },
      },
      { $sort: { "_id.y": 1 as 1, "_id.m": 1 as 1 } },
      { $group: { _id: null, arr: { $push: "$cnt" } } },
      { $project: { series: "$arr" } },
      { $replaceRoot: { newRoot: "$series" } }
    );

    return stages;
  }

  /**
   * FACET helper: sparkline by week (last N) using a date field.
   * Intended to be used inside a $facet as { series: [ ... ] }.
   */
  private weeklySeriesFacet(
    lastN: number,
    dateField: string = "updatedAt"
  ): PipelineStage.FacetPipelineStage[] {
    const from = new Date();
    from.setDate( from.getDate() - ( lastN - 1 ) * 7 );
    from.setHours( 0, 0, 0, 0 );

    return [
      { $match: { [ dateField ]: { $gte: from } } },
      {
        $group: {
          _id: {
            y: { $isoWeekYear: `$${ dateField }` },
            w: { $isoWeek: `$${ dateField }` },
          },
          cnt: { $sum: 1 },
        },
      },
      { $sort: { "_id.y": 1 as 1, "_id.w": 1 as 1 } },
      { $group: { _id: null, arr: { $push: "$cnt" } } },
      { $project: { series: "$arr" } },
      { $replaceRoot: { newRoot: "$series" } },
    ];
  }

  /**
   * Month bucket series by a field (dense array length ≈ months; FE can pad zeros).
   */
  private monthBucketSeriesPipeline(
    dateField: string,
    months: number
  ): PipelineStage[] {
    const from = new Date();
    from.setMonth( from.getMonth() - ( months - 1 ), 1 );
    from.setHours( 0, 0, 0, 0 );

    return [
      { $match: { [ dateField ]: { $gte: from } } },
      {
        $group: {
          _id: {
            y: { $year: `$${ dateField }` },
            m: { $month: `$${ dateField }` },
          },
          cnt: { $sum: 1 },
        },
      },
      { $sort: { "_id.y": 1 as 1, "_id.m": 1 as 1 } },
      { $group: { _id: null, arr: { $push: "$cnt" } } },
      { $project: { series: "$arr" } },
      { $replaceRoot: { newRoot: "$series" } },
    ];
  }

  /* ====================================================================== *
   * PRIVATE HELPERS – FS UTILITIES (not heavily used now, but kept)
   * ====================================================================== */

  private async deleteFolderWithRetry(
    folderPath: string,
    retries = 5,
    delayMs = 500
  ): Promise<void> {
    for ( let i = 1; i <= retries; i++ ) {
      try {
        await fs.promises.rm( folderPath, {
          recursive: true,
          force: true,
        } );
        return;
      } catch ( e: any ) {
        if ( e.code === "EBUSY" || e.code === "EPERM" ) {
          await new Promise( ( r ) => setTimeout( r, delayMs ) );
        } else {
          throw e;
        }
      }
    }
    throw new Error(
      `Failed to delete folder after ${ retries } attempts: ${ folderPath }`
    );
  }

  private async moveToTheRecycleBin(
    recycleBinPath: string,
    filePath: string
  ): Promise<void> {
    try {
      if ( !fs.existsSync( filePath ) ) return;
      await fs.promises.mkdir( recycleBinPath, { recursive: true } );
      const targetPath = path.join(
        recycleBinPath,
        `${ Date.now() }-${ path.basename( filePath ) }`
      );
      await fs.promises.rename( filePath, targetPath );
    } catch ( error ) {
      console.log(
        "Error while moving file to deleted:",
        error instanceof Error ? error.stack : error
      );
    }
  }
}
