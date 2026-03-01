//Path: src/api/lease.router.ts
// ============================================================================
// Lease API Controller
// - Registers and updates lease agreements (files + DB)
// - Renders EJS preview and generates Puppeteer PDFs
// - Queries leases by username/ID with safe helpers
// - Beginner-friendly comments included
// ============================================================================

import { ENV } from '../configs/env.config';
import axios from "axios";
import ejs from "ejs";
import express, { Request, Response, Router } from "express";
import fs from "fs";
import * as libre from "libreoffice-convert"; // (kept if you later reuse for docs)
import { FilterQuery, type ClientSession } from "mongoose";
import multer from "multer";
import * as os from "os";
import path from "path";
import * as puppeteer from "puppeteer";
import QRCode from "qrcode";
import { promisify } from "util";

import {
  Address,
  CoTenant,
  CountryCodes,
  CurrencyFormat,
  EmergencyContact,
  FILE,
  LatePaymentPenalty,
  LeaseAgreement,
  LeaseModel,
  LeasePayload,
  LeasePayloadWithProperty,
  NoticePeriod,
  PaymentFrequency,
  PaymentMethod,
  RentDueDate,
  RulesAndRegulations,
  ScannedFileRecordJSON,
  SecurityDeposit,
  Signatures,
  SystemMetadata,
  TenantInformation,
  TokenViceData,
  UtilityResponsibility,
  type LeaseType
} from "../models/lease.model";

import { Property, PropertyModel, IProperty, AddedBy } from '../models/property.model';
import { UserModel, User, USER_MODEL_PROJECTION, type IUser } from "../models/user.model";
import { CryptoService } from "../services/crypto.service";
import { NotificationHubEngineService } from '../services/notifications/notification-hub-engine.service';
import { RecycleBinDomainDeleteService, type DomainDeletePlan } from '../services/recyclebin/recyclebin-domain-delete.service';
import { PaginationMeta, type FileMetaPacket } from "../types/common";
import { ApiResponseBuilder } from '../utils/api-combiner.builder';
import { ApiGuardExport } from '../guard/api-router.guard';
import { FileMetaPacketBuilder } from '../utils/files/file-meta-packet.builder';


// Optional (future): promisify libre if you add DOC->PDF here
const convertToPDF = promisify( libre.convert );

// ----------------------- Small constants / limits -----------------------
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB per file as a sane cap
const ALLOWED_MIME = new Set<string>( [
  // Office
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
  // OpenDocument
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  // PDF/Text
  "application/pdf",
  "text/plain",
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/webp",
  "image/svg+xml",
  "image/ico",
] );

type TokenPayload = { tenant?: string; issuedAt?: number; };

export default class Lease {
  private notificationHub: NotificationHubEngineService = new NotificationHubEngineService();
  private deleteService: RecycleBinDomainDeleteService = new RecycleBinDomainDeleteService();
  // --------------------------- Static roots ---------------------------
  private readonly PUBLIC_ROOT = path.resolve( __dirname, "../../public" );
  private readonly UPLOADS_ROOT = path.join( this.PUBLIC_ROOT, "uploads" );
  private readonly RECYCLEBIN_ROOT = path.join( this.PUBLIC_ROOT, "recyclebin" );

  // Leases
  private readonly LEASE_UPLOAD_ROOT = path.join( this.UPLOADS_ROOT, "leases" );
  private readonly LEASE_UPLOAD_DIR_URL = "uploads/leases";
  private readonly LEASE_RECYCLE_ROOT = path.join( this.RECYCLEBIN_ROOT, "leases" );
  private readonly LEASE_RECYCLE_DIR_URL = "recyclebin/leases";

  // Tenants (for mobile scanned docs)
  private readonly TENANT_UPLOAD_ROOT = path.join( this.UPLOADS_ROOT, "tenants" );
  private readonly TENANT_UPLOAD_DIR_URL = "uploads/tenants";
  private readonly TENANT_RECYCLE_ROOT = path.join( this.RECYCLEBIN_ROOT, "tenants" );
  private readonly TENANT_RECYCLE_DIR_URL = "recyclebin/tenants";

  // -------------------- Express + services + caches -------------------
  private readonly router: Router;
  private readonly cryptoService: CryptoService = new CryptoService();
  private puppeteerBrowser: puppeteer.Browser | null = null;

  // Cache EJS templates + logo so PDF generation is fast
  private cachedTemplates: {
    header: string;
    footer: string;
    main: string;
    logoBase64: string;
  } = { header: "", footer: "", main: "", logoBase64: "" };

  constructor () {
    this.router = express.Router();

    // Register routes
    this.registerLeaseAgreement();                          // POST /register/:leaseID   (create)
    this.updateLeaseAgreement();                            // PUT  /update-lease-agreement/:leaseID  (update)
    this.deleteLeaseAgreement();                            // DELETE /delete-lease-agreement/:leaseID (soft delete + recycle bin)
    this.setupEjsPreview();                                 // GET  /preview-lease-agreement/:leaseID (EJS preview)
    this.generatePDFOfLeaseAgreement();                     // GET  /lease-agreement-pdf/:leaseID/:type/:generator
    this.getAllLeaseAgreementsByUsername();                 // GET  /lease-agreements/:username
    this.getLeaseAgreementsByLeaseID();                     // GET  /lease-agreement/:leaseID
    this.getLeaseAgreementByIDAndUpdateValidationStatus();  // PUT  /lease-status-updated/:leaseID
    this.getTenantByUsername();                             // GET  /get-tenant-by-username/:username
    this.getAllLeases();                                    // GET  /all-leases?page=&limit=
    this.getTotalLeaseCount();                              // GET  /get-lease-count         
    this.getAllPropertiesThatDoesNotHaveLease();            // GET  /get-properties-that-does-not-have-lease
    this.getAllPropertiesCountWitoutLease();                // GET  /get-all-properties-count-without-leases

    // Load templates once
    this.preloadTemplates();
  }

  /** Expose router to app: app.use('/lease', new Lease().route) */
  public get route(): Router {
    return this.router;
  }

  // ============================================================================
  // Helpers: URL + path + parsing + validation
  // ============================================================================

  /** Build base URL and honor proxies (X-Forwarded-Proto). */
  private getBaseUrl( req: Request ): string {
    const forwardedProto = ( req.headers[ "x-forwarded-proto" ] as string ) || "";
    const protocol = forwardedProto.split( "," )[ 0 ]?.trim() || req.protocol;
    const host = req.get( "host" ) || "localhost";
    return `${ protocol }://${ host }`;
  }

  /** Prevent path traversal by normalizing under a root. */
  private safeJoin( root: string, ...segments: string[] ): string {
    const target = path.normalize( path.join( root, ...segments ) );
    const normalizedRoot = path.normalize( root );
    if ( !target.startsWith( normalizedRoot ) ) {
      throw new Error( "Unsafe path resolution detected." );
    }
    return target;
  }

  /** Create/return lease directory path; optionally ensure (mkdir -p). */
  private buildLeasePath(
    leaseID: string,
    ensure = false,
    ...segments: string[]
  ): string {
    // Build the full path (your safeJoin already protects traversal)
    const fullPath = this.safeJoin( this.LEASE_UPLOAD_ROOT, leaseID, ...segments );

    if ( ensure ) {
      // If LAST segment looks like a file (has extension), create parent folder only
      const looksLikeFile = !!path.extname( fullPath ); // e.g., "data.json"

      const dirToCreate = looksLikeFile
        ? path.dirname( fullPath ) // -> ".../agreement-data/"
        : fullPath;              // -> exact folder

      // Create only directories, never create file paths as folders
      fs.mkdirSync( dirToCreate, { recursive: true } );
    }

    return fullPath;
  }


  /** Public URL under /public for lease files. */
  private buildLeaseUrl( leaseID: string, ...segments: string[] ): string {
    return [ this.LEASE_UPLOAD_DIR_URL, leaseID, ...segments ].join( "/" );
  }

  /** Build tenant path (e.g., scanned/mobile). */
  private buildTenantPath( username: string, ensure = false, ...segments: string[] ): string {
    const p = this.safeJoin( this.TENANT_UPLOAD_ROOT, username, ...segments );
    if ( ensure ) fs.mkdirSync( p, { recursive: true } );
    return p;
  }

  /** Public URL for tenant files. */
  private buildTenantUrl( username: string, ...segments: string[] ): string {
    return [ this.TENANT_UPLOAD_DIR_URL, username, ...segments ].join( "/" );
  }

  /** Simple filename sanitizer to avoid weird characters + collisions. */
  private sanitizeFilename( original: string ): string {
    const base = original.replace( /\s+/g, "_" ).replace( /[^\w.\-]/g, "" );
    const uniqueSuffix = `${ Date.now() }-${ Math.round( Math.random() * 1e9 ) }`;
    return `${ uniqueSuffix }-${ base }`;
  }

  /** Parse a required string from any input; throws a helpful error. */
  private mustString( v: unknown, name: string ): string {
    if ( typeof v !== "string" || !v.trim() ) throw new Error( `${ name } is required` );
    return v.trim();
  }

  /** Parse and validate an ISO date string (YYYY-MM-DD or full ISO). */
  private mustISODate( v: unknown, name: string ): string {
    const s = this.mustString( v, name );
    if ( !this.checkISODate( s ) ) throw new Error( `${ name } must be ISO date (YYYY-MM-DD).` );
    return s;
  }

  /** Parse JSON from string with typed generics and friendly error. */
  private mustJSON<T = any>( v: unknown, name: string ): T {
    const s = this.mustString( v, name );
    try {
      return JSON.parse( s ) as T;
    } catch {
      throw new Error( `${ name } must be valid JSON.` );
    }
  }

  /** Parse integer in base-10 with nice error. */
  private toInt10( v: unknown, name: string ): number {
    const s = this.mustString( v, name );
    const n = parseInt( s, 10 );
    if ( !Number.isFinite( n ) ) throw new Error( `${ name } must be a number.` );
    return n;
  }

  /** Parse boolean from common forms ("true"/"false"/"1"/"0"). */
  private parseBoolean( input: string ): boolean {
    const val = input?.toString().trim().toLowerCase();
    return val === "true" || val === "1";
  }

  /** Minimal ID/username sanitizer for queries (letters, numbers, _ - .). */
  private sanitizeIdentifier( input: string ): string {
    return ( input || "" ).trim().replace( /[^\w.\-]/g, "" );
  }

  // ============================================================================
  // CREATE: Register Lease Agreement
  // POST /register/:leaseID
  // ============================================================================

  private registerLeaseAgreement(): void {
    // 1) Configure multer storage and filtering
    const storage = multer.diskStorage( {
      destination: ( req, file, cb ) => {
        try {
          const leaseID = this.mustString( req.params.leaseID, "Lease ID" );
          let uploadPath = "";
          // NOTE: field names are matched exactly; keep existing names for compatibility
          switch ( file.fieldname ) {
            case "tenantScanedDocuments":
              uploadPath = this.buildLeasePath( leaseID, true, "documents" );
              break;
            case "tenantSignature":
              uploadPath = this.buildLeasePath( leaseID, true, "signatures", "tenant" );
              break;
            case "landlordSignature":
              uploadPath = this.buildLeasePath( leaseID, true, "signatures", "landlord" );
              break;
            default:
              cb( new Error( "Unexpected field: " + file.fieldname ), "" );
              return;
          }
          cb( null, uploadPath );
        } catch ( err ) {
          cb( err as Error, "" );
        }
      },
      filename: ( _req, file, cb ) => cb( null, this.sanitizeFilename( file.originalname ) ),
    } );

    const fileFilter: multer.Options[ "fileFilter" ] = ( _req, file, cb ) => {
      if ( !ALLOWED_MIME.has( file.mimetype ) ) {
        cb( new Error( `File type not allowed: ${ file.mimetype }` ) );
        return;
      }
      cb( null, true );
    };

    const upload = multer( {
      storage,
      fileFilter,
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 60 }, // 50 docs + 2 signatures (+ buffer)
    } );

    // 2) Route handler
    this.router.post(
      "/register/:leaseID",
      upload.fields( [
        { name: "tenantScanedDocuments", maxCount: 50 },
        { name: "tenantSignature", maxCount: 1 },
        { name: "landlordSignature", maxCount: 1 },
      ] ),
      async ( req: Request<{ leaseID: string; }>, res: Response ) => {
        try {
          // -------------------- Prep + base URL --------------------
          const hostBaseUrl = this.getBaseUrl( req );

          // -------------------- Required maps/guards --------------------
          const ensureFileSig = ( obj: any ): obj is FILE =>
            obj &&
            typeof obj.fieldname === "string" &&
            typeof obj.originalname === "string" &&
            typeof obj.mimetype === "string" &&
            typeof obj.size === "number" &&
            typeof obj.filename === "string" &&
            typeof obj.URL === "string";

          const files = req.files as { [ field: string ]: Express.Multer.File[]; } | undefined;
          const leaseID = this.mustString( req.params.leaseID || req.body.leaseID, "Lease ID" );

          // -------------------- Tenant info --------------------
          const tenantUsername = this.mustString( req.body.tenantUsername, "Tenant ID" );
          const tenantFullName = this.mustString( req.body.tenantFullName, "Tenant Full Name" );
          const tenantEmail = this.mustString( req.body.tenantEmail, "Tenant Email" );
          const tenantNationality = this.mustString( req.body.tenantNationality, "Tenant Nationality" );

          const tenantDateOfBirthStr = this.mustISODate( req.body.tenantDateOfBirth, "Tenant date of birth" );
          const tenantDateOfBirth = new Date( tenantDateOfBirthStr );
          if ( Number.isNaN( tenantDateOfBirth.getTime() ) ) throw new Error( "Tenant date of birth is not a valid date" );

          if ( !this.checkIsPhoneCodeDetails( this.mustString( req.body.tenantPhoneCodeDetails, "Tenant phone code" ) ) )
            throw new Error( "Invalid tenant phone code details" );
          const tenantPhoneCodeDetails: CountryCodes = this.mustJSON( req.body.tenantPhoneCodeDetails, "Tenant phone code" );

          const tenantPhoneNumber = this.mustString( req.body.tenantPhoneNumber, "Tenant Phone Number" );
          const tenantGender = this.mustString( req.body.tenantGender, "Tenant Gender" );
          const tenantNICOrPassport = this.mustString( req.body.tenantNICOrPassport, "Tenant NIC OR Passport" );

          if ( !this.isValidTenantAddress( this.mustString( req.body.tenantAddress, "Tenant Address" ) ) )
            throw new Error( "Invalid tenant address object" );
          const tenantAddress: Address = this.mustJSON( req.body.tenantAddress, "Tenant Address" );

          if ( !this.checkIsEmergencyContact( req.body.emergencyContact ) )
            throw new Error( "Invalid tenant emergency contact object" );
          const tenantEmergencyContact: EmergencyContact = this.mustJSON( req.body.emergencyContact, "Emergency Contact" );

          // -------------------- Co-tenant (optional) --------------------
          const coTenantFullname = ( req.body.coTenantFullname as string | undefined )?.trim();
          const coTenantEmail = ( req.body.coTenantEmail as string | undefined )?.trim();
          const coTenantPhoneCodeDetails: CountryCodes = this.mustJSON( req.body.coTenantPhoneCodeDetails, "Co-tenant phone code" );
          const coTenantPhoneNumber = ( req.body.coTenantPhoneNumber as string | undefined )?.trim();
          const coTenantGender = ( req.body.coTenantGender as string | undefined )?.trim();
          const coTenantNicOrPassport = ( req.body.coTenantNicOrPassport as string | undefined )?.trim();
          const coTenantAgeStr = ( req.body.coTenantAge as string | undefined )?.trim();
          const coTenantRelationship = ( req.body.coTenantRelationship as string | undefined )?.trim();

          let INSERT_DATA_coTenant: CoTenant | undefined;
          const anyCoTenantFieldProvided =
            !!( coTenantFullname ||
              coTenantEmail ||
              coTenantPhoneCodeDetails ||
              coTenantPhoneNumber ||
              coTenantGender ||
              coTenantNicOrPassport ||
              coTenantAgeStr ||
              coTenantRelationship );

          if ( anyCoTenantFieldProvided ) {
            const coTenantAge = coTenantAgeStr ? parseInt( coTenantAgeStr, 10 ) : undefined;
            INSERT_DATA_coTenant = {
              fullName: coTenantFullname ?? "",
              email: coTenantEmail ?? "",
              phoneCodeDetails: coTenantPhoneCodeDetails,
              phoneNumber: coTenantPhoneNumber ?? "",
              gender: coTenantGender ?? "",
              nicOrPassport: coTenantNicOrPassport ?? "",
              age: ( coTenantAge as CoTenant[ "age" ] ) ?? 0,
              relationship: coTenantRelationship ?? "",
            };
          }

          // -------------------- Property + agreement core --------------------
          const selectedProperty: Property = this.mustJSON( req.body.selectedProperty, "Selected Property" );

          const startDate = this.mustISODate( req.body.startDate, "Agreement starting date" );
          const endDate = this.mustISODate( req.body.endDate, "Agreement ending date" );
          const durationMonths = this.toInt10( req.body.durationMonths, "Agreement duration in months" );
          const monthlyRent = this.toInt10( req.body.monthlyRent, "Agreement monthly rent" );

          if ( !this.checkCurrencyFormat( this.mustString( req.body.currency, "Currency" ) ) )
            throw new Error( "Invalid currency" );
          const currency: CurrencyFormat = this.mustJSON( req.body.currency, "Currency" );

          if ( !this.checkPaymentFrequencyFormat( this.mustString( req.body.paymentFrequency, "Payment frequency" ) ) )
            throw new Error( "Invalid payment frequency" );
          const paymentFrequency: PaymentFrequency = this.mustJSON( req.body.paymentFrequency, "Payment frequency" );

          if ( !this.checkPaymentMethodFormat( this.mustString( req.body.paymentMethod, "Payment method" ) ) )
            throw new Error( "Invalid payment method" );
          const paymentMethod: PaymentMethod = this.mustJSON( req.body.paymentMethod, "Payment method" );

          if ( !this.checkSecurityDepositFormat( this.mustString( req.body.securityDeposit, "Security deposit" ) ) )
            throw new Error( "Invalid security deposit" );
          const securityDeposit: SecurityDeposit = this.mustJSON( req.body.securityDeposit, "Security deposit" );

          if ( !this.checkRentDueDateFormat( this.mustString( req.body.rentDueDate, "Rent due date" ) ) )
            throw new Error( "Invalid rent due date" );
          const rentDueDate: RentDueDate = this.mustJSON( req.body.rentDueDate, "Rent due date" );

          if (
            !this.checkLatePaymentPenaltiesFormat(
              this.mustString( req.body.selectedLatePaymentPenalties, "Late payment penalties" )
            )
          )
            throw new Error( "Invalid late payment penalties" );
          const selectedLatePaymentPenalties: LatePaymentPenalty[] = this.mustJSON(
            req.body.selectedLatePaymentPenalties,
            "Late payment penalties"
          );

          if (
            !this.checkUtilityResponsibilitiesFormat(
              this.mustString( req.body.selectedUtilityResponsibilities, "Utility responsibilities" )
            )
          )
            throw new Error( "Invalid utility responsibilities" );
          const selectedUtilityResponsibilities: UtilityResponsibility[] = this.mustJSON(
            req.body.selectedUtilityResponsibilities,
            "Utility responsibilities"
          );

          if ( !this.checkNoticePeriodDaysFormat( this.mustString( req.body.noticePeriodDays, "Notice period days" ) ) )
            throw new Error( "Invalid notice period days" );
          const noticePeriodDays: NoticePeriod = this.mustJSON( req.body.noticePeriodDays, "Notice period days" );

          if ( !this.checkRuleAndRegulationsFormat( this.mustString( req.body.selectedRuleAndRegulations, "Rules & regs" ) ) )
            throw new Error( "Invalid rule and regulations format" );
          const selectedRuleAndRegulations: RulesAndRegulations[] = this.mustJSON(
            req.body.selectedRuleAndRegulations,
            "Rules & regs"
          );

          const isReadTheCompanyPolicy: boolean = this.parseBoolean(
            this.mustString( req.body.isReadTheCompanyPolicy, "Company policy confirmation" )
          );

          // -------------------- Signatures + meta --------------------
          const signedAtStr = this.mustISODate( req.body.signedAt, "Agreement signed at date" );
          const signedAt = new Date( signedAtStr );

          const ipAddress: string =
            ( req.headers[ "x-forwarded-for" ] as string | undefined ) ?? req.socket.remoteAddress ?? "Unknown IP";

          const baseUrl = this.getBaseUrl( req );

          // -------------------- Move tenant mobile scans into lease folder --------------------
          const scannedDocumentPath = this.buildLeasePath( leaseID, true, "documents" );
          const mobileScannedFolderPath = this.buildTenantPath( tenantUsername, false, "scanned", "mobile" );


          const tenantUploadedScanedDocuments: ScannedFileRecordJSON[] = this.mustJSON(
            req.body.tenantUploadedScanedDocuments,
            "Tenant uploaded scanned docs"
          );

          // Move each referenced file from tenant mobile folder -> lease documents
          tenantUploadedScanedDocuments.forEach( ( item ) => {
            item.files.forEach( ( doc ) => {
              const filename = doc.file.filename;
              const sourcePath = path.join( mobileScannedFolderPath, filename );
              if ( fs.existsSync( sourcePath ) ) {
                const destPath = path.join( scannedDocumentPath, filename );
                doc.file.URL = `${ baseUrl }/${ this.buildLeaseUrl( leaseID, "documents", filename ) }`;
                fs.renameSync( sourcePath, destPath );
              }
            } );
          } );

          const scannedDocuments: ScannedFileRecordJSON[] = [];
          if ( Array.isArray( tenantUploadedScanedDocuments ) && tenantUploadedScanedDocuments.length > 0 ) {
            scannedDocuments.push( ...tenantUploadedScanedDocuments );
          }

          // Also include new uploads that came with this request (tenantScanedDocuments)
          const payloadForToken: TokenPayload = { tenant: tenantUsername, issuedAt: Date.now() };
          const token = await this.cryptoService.encrypt( payloadForToken );

          const leaseDocsNow = ( files?.[ "tenantScanedDocuments" ] ?? [] ) as Express.Multer.File[];
          const newScannedBatch: ScannedFileRecordJSON = {
            date: new Date().toISOString(),
            tenant: tenantUsername,
            token,
            files: [],
          };

          leaseDocsNow.forEach( ( doc ) => {
            const data: TokenViceData = {
              ageInMinutes: 0,
              file: {
                fieldname: doc.fieldname,
                originalname: doc.originalname,
                mimetype: doc.mimetype,
                size: doc.size,
                filename: doc.filename,
                URL: `${ baseUrl }/${ this.buildLeaseUrl( leaseID, "documents", doc.filename ) }`,
              },
            };
            newScannedBatch.files.push( data );
          } );

          if ( newScannedBatch.files.length > 0 ) scannedDocuments.push( newScannedBatch );

          if ( !scannedDocuments.length ) {
            throw new Error(
              "No scanned identification document found. Please upload at least one document before submitting."
            );
          }

          // -------------------- Signatures (file or old JSON) --------------------
          const tSig = files?.[ "tenantSignature" ]?.[ 0 ];
          const tenantOldSignature = req.body.tenantOldSignature;
          let fallbackTenantSignature: FILE | undefined;
          if ( !tSig ) {
            if ( !ensureFileSig( tenantOldSignature ) ) throw new Error( "Tenant signature is required!" );
            fallbackTenantSignature = tenantOldSignature;
          }
          const organizedTenantSignature: FILE = {
            fieldname: tSig?.fieldname ?? fallbackTenantSignature?.fieldname ?? "",
            originalname: tSig?.originalname ?? fallbackTenantSignature?.originalname ?? "",
            mimetype: tSig?.mimetype ?? fallbackTenantSignature?.mimetype ?? "",
            size: tSig?.size ?? fallbackTenantSignature?.size ?? 0,
            filename: tSig?.filename ?? fallbackTenantSignature?.filename ?? "",
            URL: tSig
              ? `${ hostBaseUrl }/${ this.buildLeaseUrl( leaseID, "signatures", "tenant", tSig.filename ) }`
              : fallbackTenantSignature?.URL ?? "",
          };

          const lSig = files?.[ "landlordSignature" ]?.[ 0 ];
          const landlordOldSignature = req.body.landlordOldSignature;
          let fallbackLandlordSignature: FILE | undefined;
          if ( !lSig ) {
            if ( !ensureFileSig( landlordOldSignature ) ) throw new Error( "Landlord signature is required!" );
            fallbackLandlordSignature = landlordOldSignature;
          }
          const organizedLandlordSignature: FILE = {
            fieldname: lSig?.fieldname ?? fallbackLandlordSignature?.fieldname ?? "",
            originalname: lSig?.originalname ?? fallbackLandlordSignature?.originalname ?? "",
            mimetype: lSig?.mimetype ?? fallbackLandlordSignature?.mimetype ?? "",
            size: lSig?.size ?? fallbackLandlordSignature?.size ?? 0,
            filename: lSig?.filename ?? fallbackLandlordSignature?.filename ?? "",
            URL: lSig
              ? `${ hostBaseUrl }/${ this.buildLeaseUrl( leaseID, "signatures", "landlord", lSig.filename ) }`
              : fallbackLandlordSignature?.URL ?? "",
          };

          // -------------------- Build sub-docs --------------------
          const INSERT_DATA_TenantInformation: TenantInformation = {
            tenantUsername,
            fullName: tenantFullName,
            nicOrPassport: tenantNICOrPassport,
            gender: tenantGender,
            nationality: tenantNationality,
            dateOfBirth: tenantDateOfBirth,
            phoneCodeDetails: tenantPhoneCodeDetails,
            phoneNumber: tenantPhoneNumber,
            email: tenantEmail,
            permanentAddress: tenantAddress,
            emergencyContact: tenantEmergencyContact,
            scannedDocuments,
          };

          const INSERT_DATA_leaseAgreement: LeaseAgreement = {
            startDate,
            endDate,
            durationMonths,
            monthlyRent,
            currency,
            paymentFrequency,
            paymentMethod,
            securityDeposit,
            rentDueDate,
            latePaymentPenalties: selectedLatePaymentPenalties,
            utilityResponsibilities: selectedUtilityResponsibilities,
            noticePeriodDays,
          };

          const INSERT_DATA_signatures: Signatures = {
            tenantSignature: organizedTenantSignature,
            landlordSignature: organizedLandlordSignature,
            signedAt,
            ipAddress,
            userAgent: this.mustJSON( req.body.userAgent, "User agent" ),
          };

          if ( !this.checkSystemMetaDataFormat( this.mustString( req.body.systemMetaData, "System metadata" ) ) )
            throw new Error( "Invalid system metadata" );
          const systemMetaData: SystemMetadata = this.mustJSON( req.body.systemMetaData, "System metadata" );

          // -------------------- Parent payloads --------------------
          const INSERT_DATA: LeasePayload = {
            leaseID,
            tenantInformation: INSERT_DATA_TenantInformation,
            ...( INSERT_DATA_coTenant ? { coTenant: INSERT_DATA_coTenant } : {} ),
            propertyID: ( selectedProperty as any ).id, // keep as your current FE sends
            leaseAgreement: INSERT_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy,
            signatures: INSERT_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          const INSERT_DOCUMENT_DATA: LeasePayloadWithProperty = {
            leaseID,
            tenantInformation: INSERT_DATA_TenantInformation,
            ...( INSERT_DATA_coTenant ? { coTenant: INSERT_DATA_coTenant } : {} ),
            property: selectedProperty,
            leaseAgreement: INSERT_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy,
            signatures: INSERT_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          // -------------------- Save JSON snapshot for PDF --------------------
          const LEASE_JSON_DIR = this.buildLeasePath( leaseID, true, "agreement-data" );
          const LEASE_JSON_PATH = path.join( LEASE_JSON_DIR, "data.json" );
          await fs.promises.writeFile( LEASE_JSON_PATH, JSON.stringify( INSERT_DOCUMENT_DATA, null, 2 ), "utf8" );


          // -------------------- Persist in DB --------------------
          const INSERT = new LeaseModel( INSERT_DATA );
          await INSERT.save();

          const actor = await ApiGuardExport.GetNormalisedAuthUser( req );
          if ( !actor ) {
            ApiResponseBuilder.internalError( res, new Error( "Authenticated user not found for notification actor." ) );
            return;
          }

          // -------------------- Notify relevant users --------------------
          await this.notificationHub.emit( {
            eventKey: 'lease:agreement.created',
            actor,
            audiences: [
              {
                mode: 'User',
                username: INSERT_DATA.tenantInformation.tenantUsername
              },
              {
                mode: 'Role',
                roleKey: 'admin',
              },
              {
                mode: 'Role',
                roleKey: 'operator',
              },
              {
                mode: 'Role',
                roleKey: 'manager',
              },
            ],
            target: {
              actionKey: 'lease:agreement.created',
              category: 'Lease',
              module: 'Lease Management',
              params: { leaseID: INSERT_DATA.leaseID },
              refId: INSERT_DATA.leaseID,
            },
            category: 'Lease',
          } );

          ApiResponseBuilder.ok( res, 'lease', INSERT, 'Agreement has been created successfully!' );
          return;
        } catch ( error ) {
          console.log( "Error in register lease agreement:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ============================================================================
  // UPDATE: Update Lease Agreement
  // PUT /update-lease-agreement/:leaseID
  // ============================================================================

  private updateLeaseAgreement(): void {
    // Reuse the same multer settings as register
    const storage = multer.diskStorage( {
      destination: ( req, file, cb ) => {
        try {
          const leaseID = this.mustString( req.params.leaseID, "Lease ID" );
          let uploadPath = "";
          switch ( file.fieldname ) {
            case "tenantScanedDocuments":
              uploadPath = this.buildLeasePath( leaseID, true, "documents" );
              break;
            case "tenantSignature":
              uploadPath = this.buildLeasePath( leaseID, true, "signatures", "tenant" );
              break;
            case "landlordSignature":
              uploadPath = this.buildLeasePath( leaseID, true, "signatures", "landlord" );
              break;
            default:
              cb( new Error( "Unexpected field: " + file.fieldname ), "" );
              return;
          }
          cb( null, uploadPath );
        } catch ( err ) {
          cb( err as Error, "" );
        }
      },
      filename: ( _req, file, cb ) => cb( null, this.sanitizeFilename( file.originalname ) ),
    } );

    const fileFilter: multer.Options[ "fileFilter" ] = ( _req, file, cb ) => {
      if ( !ALLOWED_MIME.has( file.mimetype ) ) {
        cb( new Error( `File type not allowed: ${ file.mimetype }` ) );
        return;
      }
      cb( null, true );
    };

    const upload = multer( {
      storage,
      fileFilter,
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 60 },
    } );

    this.router.put(
      "/update-lease-agreement/:leaseID",
      upload.fields( [
        { name: "tenantScanedDocuments", maxCount: 50 },
        { name: "tenantSignature", maxCount: 1 },
        { name: "landlordSignature", maxCount: 1 },
      ] ),
      async ( req: Request<{ leaseID: string; }>, res: Response ) => {
        try {
          // -------------------- Prep + base URL --------------------
          const hostBaseUrl = this.getBaseUrl( req );

          // -------------------- Required maps/guards --------------------
          const files = req.files as { [ field: string ]: Express.Multer.File[]; } | undefined;

          const leaseID = this.mustString( req.params.leaseID || req.body.leaseID, "Lease ID" );
          const leaseAgreementDB = await LeaseModel.findOne( { leaseID } ).lean<LeasePayload>().exec();
          if ( !leaseAgreementDB ) throw new Error( "Lease agreement not found!" );

          // Tenant
          const tenantUsername = this.mustString( req.body.tenantUsername, "Tenant ID" );
          const tenantFullName = this.mustString( req.body.tenantFullName, "Tenant Full Name" );
          const tenantEmail = this.mustString( req.body.tenantEmail, "Tenant Email" );
          const tenantNationality = this.mustString( req.body.tenantNationality, "Tenant Nationality" );

          const tenantDOBStr = this.mustISODate( req.body.tenantDateOfBirth, "Tenant date of birth" );
          const tenantDateOfBirth = new Date( tenantDOBStr );
          if ( Number.isNaN( tenantDateOfBirth.getTime() ) ) throw new Error( "Tenant date of birth is not a valid date." );

          if ( !this.checkIsPhoneCodeDetails( this.mustString( req.body.tenantPhoneCodeDetails, "Tenant phone code" ) ) )
            throw new Error( "Invalid tenant phone code details." );
          const tenantPhoneCodeDetails: CountryCodes = this.mustJSON( req.body.tenantPhoneCodeDetails, "Tenant phone code" );

          const tenantPhoneNumber = this.mustString( req.body.tenantPhoneNumber, "Tenant Phone Number" );
          const tenantGender = this.mustString( req.body.tenantGender, "Tenant Gender" );
          const tenantNICOrPassport = this.mustString( req.body.tenantNICOrPassport, "Tenant NIC OR Passport" );

          if ( !this.isValidTenantAddress( this.mustString( req.body.tenantAddress, "Tenant Address" ) ) )
            throw new Error(
              "Invalid tenant address: expected an address with houseNumber, street, city, stateOrProvince, postalCode, and country."
            );
          const tenantAddress: Address = this.mustJSON( req.body.tenantAddress, "Tenant Address" );

          if ( !this.checkIsEmergencyContact( req.body.emergencyContact ) )
            throw new Error( "Invalid tenant emergency contact." );
          const tenantEmergencyContact: EmergencyContact = this.mustJSON( req.body.emergencyContact, "Emergency Contact" );

          // Co-tenant (optional)
          const coTenantFullname = ( req.body.coTenantFullname as string | undefined )?.trim();
          const coTenantEmail = ( req.body.coTenantEmail as string | undefined )?.trim();
          const coTenantPhoneCodeDetails: CountryCodes = this.mustJSON( req.body.coTenantPhoneCodeDetails, "Co-tenant phone code" );
          const coTenantPhoneNumber = ( req.body.coTenantPhoneNumber as string | undefined )?.trim();
          const coTenantGender = ( req.body.coTenantGender as string | undefined )?.trim();
          const coTenantNicOrPassport = ( req.body.coTenantNicOrPassport as string | undefined )?.trim();
          const coTenantAgeStr = ( req.body.coTenantAge as string | undefined )?.trim();
          const coTenantRelationship = ( req.body.coTenantRelationship as string | undefined )?.trim();

          let UPDATE_DATA_coTenant: CoTenant | undefined;
          const anyCoTenantFieldProvided =
            !!( coTenantFullname ||
              coTenantEmail ||
              coTenantPhoneCodeDetails ||
              coTenantPhoneNumber ||
              coTenantGender ||
              coTenantNicOrPassport ||
              coTenantAgeStr ||
              coTenantRelationship );

          if ( anyCoTenantFieldProvided ) {
            const coTenantAge = coTenantAgeStr ? parseInt( coTenantAgeStr, 10 ) : undefined;
            UPDATE_DATA_coTenant = {
              fullName: coTenantFullname ?? "",
              email: coTenantEmail ?? "",
              phoneCodeDetails: coTenantPhoneCodeDetails,
              phoneNumber: coTenantPhoneNumber ?? "",
              gender: coTenantGender ?? "",
              nicOrPassport: coTenantNicOrPassport ?? "",
              age: ( coTenantAge as CoTenant[ "age" ] ) ?? 0,
              relationship: coTenantRelationship ?? "",
            };
          }

          // Property + agreement values
          const selectedProperty: Property = this.mustJSON( req.body.selectedProperty, "Selected Property" );
          const startDate = this.mustISODate( req.body.startDate, "Agreement starting date" );
          const endDate = this.mustISODate( req.body.endDate, "Agreement ending date" );
          const durationMonths = this.toInt10( req.body.durationMonths, "Agreement duration in months" );
          const monthlyRent = this.toInt10( req.body.monthlyRent, "Agreement monthly rent" );

          if ( !this.checkCurrencyFormat( this.mustString( req.body.currency, "Currency" ) ) )
            throw new Error( "Invalid currency format!" );
          const currency: CurrencyFormat = this.mustJSON( req.body.currency, "Currency" );

          if ( !this.checkPaymentFrequencyFormat( this.mustString( req.body.paymentFrequency, "Payment frequency" ) ) )
            throw new Error( "Invalid payment frequency format!" );
          const paymentFrequency: PaymentFrequency = this.mustJSON( req.body.paymentFrequency, "Payment frequency" );

          if ( !this.checkPaymentMethodFormat( this.mustString( req.body.paymentMethod, "Payment method" ) ) )
            throw new Error( "Invalid payment method format!" );
          const paymentMethod: PaymentMethod = this.mustJSON( req.body.paymentMethod, "Payment method" );

          if ( !this.checkSecurityDepositFormat( this.mustString( req.body.securityDeposit, "Security deposit" ) ) )
            throw new Error( "Invalid security deposit format!" );
          const securityDeposit: SecurityDeposit = this.mustJSON( req.body.securityDeposit, "Security deposit" );

          if ( !this.checkRentDueDateFormat( this.mustString( req.body.rentDueDate, "Rent due date" ) ) )
            throw new Error( "Invalid rent due date format!" );
          const rentDueDate: RentDueDate = this.mustJSON( req.body.rentDueDate, "Rent due date" );

          if (
            !this.checkLatePaymentPenaltiesFormat(
              this.mustString( req.body.selectedLatePaymentPenalties, "Late payment penalties" )
            )
          )
            throw new Error( "Invalid late payment penalties format!" );
          const selectedLatePaymentPenalties: LatePaymentPenalty[] = this.mustJSON(
            req.body.selectedLatePaymentPenalties,
            "Late payment penalties"
          );

          if (
            !this.checkUtilityResponsibilitiesFormat(
              this.mustString( req.body.selectedUtilityResponsibilities, "Utility responsibilities" )
            )
          )
            throw new Error( "Invalid utility responsibility format!" );
          const selectedUtilityResponsibilities: UtilityResponsibility[] = this.mustJSON(
            req.body.selectedUtilityResponsibilities,
            "Utility responsibilities"
          );

          if ( !this.checkNoticePeriodDaysFormat( this.mustString( req.body.noticePeriodDays, "Notice period days" ) ) )
            throw new Error( "Invalid notice period days format!" );
          const noticePeriodDays: NoticePeriod = this.mustJSON( req.body.noticePeriodDays, "Notice period days" );

          if ( !this.checkRuleAndRegulationsFormat( this.mustString( req.body.selectedRuleAndRegulations, "Rules & regs" ) ) )
            throw new Error( "Invalid rule and regulations format!" );
          const selectedRuleAndRegulations: RulesAndRegulations[] = this.mustJSON(
            req.body.selectedRuleAndRegulations,
            "Rules & regs"
          );

          const isReadTheCompanyPolicy = this.parseBoolean(
            this.mustString( req.body.isReadTheCompanyPolicy, "Company policy confirmation" )
          );

          const signedAtStr = this.mustISODate( req.body.signedAt, "Agreement signed at date" );
          const signedAt = new Date( signedAtStr );

          // Meta
          const ipAddress: string =
            ( req.headers[ "x-forwarded-for" ] as string | undefined ) ?? req.socket.remoteAddress ?? "Unknown IP";

          if ( !this.checkAddedBy( this.mustString( req.body.userAgent, "User agent" ) ) )
            throw new Error( "Invalid added-by format for user agent!" );
          const userAgent: AddedBy = this.mustJSON( req.body.userAgent, "User agent" );

          if ( !this.checkSystemMetaDataFormat( this.mustString( req.body.systemMetaData, "System metadata" ) ) )
            throw new Error( "Invalid system metadata format!" );
          const systemMetaData: SystemMetadata = this.mustJSON( req.body.systemMetaData, "System metadata" );
          systemMetaData.lastUpdated = new Date().toISOString();

          // scanned docs: merge & move new
          const scannedDocumentPath = this.buildLeasePath( leaseID, true, "documents" );
          const mobileScannedFolderPath = this.buildTenantPath( tenantUsername, false, "scanned", "mobile" );

          const tenantUploadedScanedDocumentsRemoved: ScannedFileRecordJSON[] = this.mustJSON(
            req.body.tenantUploadedScanedDocumentsRemoved,
            "Removed scanned docs"
          );

          const tenantUploadedScanedDocuments: ScannedFileRecordJSON[] = this.mustJSON(
            req.body.tenantUploadedScanedDocuments,
            "Tenant uploaded scanned docs"
          );

          if ( Array.isArray( tenantUploadedScanedDocumentsRemoved ) && tenantUploadedScanedDocumentsRemoved.length > 0 ) {
            tenantUploadedScanedDocumentsRemoved.forEach( ( item ) => {
              item.files.forEach( ( doc ) => {
                const filename = doc.file.filename;
                const destinationPath = path.join( scannedDocumentPath, filename );
                if ( fs.existsSync( destinationPath ) ) {
                  fs.unlinkSync( destinationPath );
                }
              } );
            } );
          }

          tenantUploadedScanedDocuments.forEach( ( item ) => {
            item.files.forEach( ( doc ) => {
              const filename = doc.file.filename;
              const sourcePath = path.join( mobileScannedFolderPath, filename );
              if ( fs.existsSync( sourcePath ) ) {
                const destinationPath = path.join( scannedDocumentPath, filename );
                doc.file.URL = `${ hostBaseUrl }/${ this.buildLeaseUrl( leaseID, "documents", filename ) }`;
                fs.renameSync( sourcePath, destinationPath );
              }
            } );
          } );

          const scannedDocuments: ScannedFileRecordJSON[] = [];
          if ( Array.isArray( tenantUploadedScanedDocuments ) && tenantUploadedScanedDocuments.length > 0 ) {
            scannedDocuments.push( ...tenantUploadedScanedDocuments );
          }

          const payloadToken: TokenPayload = { tenant: tenantUsername, issuedAt: Date.now() };
          const token = await this.cryptoService.encrypt( payloadToken );

          const tenantScanedDocuments = files?.[ "tenantScanedDocuments" ];
          const newScannedFileRecord: ScannedFileRecordJSON = {
            date: new Date().toISOString(),
            tenant: tenantUsername,
            token,
            files: [],
          };

          if ( Array.isArray( tenantScanedDocuments ) ) {
            tenantScanedDocuments.forEach( ( doc ) => {
              const data: TokenViceData = {
                ageInMinutes: 0,
                file: {
                  fieldname: doc.fieldname,
                  originalname: doc.originalname,
                  mimetype: doc.mimetype,
                  size: doc.size,
                  filename: doc.filename,
                  URL: `${ hostBaseUrl }/${ this.buildLeaseUrl( leaseID, "documents", doc.filename ) }`,
                },
              };
              newScannedFileRecord.files.push( data );
            } );
          }

          if ( newScannedFileRecord.files.length > 0 ) scannedDocuments.push( newScannedFileRecord );

          if ( !scannedDocuments.length ) {
            throw new Error(
              "No scanned identification document found. Please upload at least one document before submitting."
            );
          }

          // signatures (support old signatures JSON)
          const tSig = files?.[ "tenantSignature" ]?.[ 0 ];
          let tenantOldParsed: any;
          if ( !tSig ) {
            tenantOldParsed = this.mustJSON( req.body.tenantOldSignature, "Tenant old signature" );
            const ensureFileSig = ( o: any ): o is FILE =>
              o &&
              typeof o.fieldname === "string" &&
              typeof o.originalname === "string" &&
              typeof o.mimetype === "string" &&
              typeof o.size === "number" &&
              typeof o.filename === "string" &&
              typeof o.URL === "string";
            if ( !ensureFileSig( tenantOldParsed ) ) throw new Error( "Tenant signature is required!" );
          }
          const organizedTenantSignature: FILE = {
            fieldname: tSig?.fieldname ?? tenantOldParsed?.fieldname ?? "",
            originalname: tSig?.originalname ?? tenantOldParsed?.originalname ?? "",
            mimetype: tSig?.mimetype ?? tenantOldParsed?.mimetype ?? "",
            size: tSig?.size ?? tenantOldParsed?.size ?? 0,
            filename: tSig?.filename ?? tenantOldParsed?.filename ?? "",
            URL: tSig ? `${ hostBaseUrl }/${ this.buildLeaseUrl( leaseID, "signatures", "tenant", tSig.filename ) }` : tenantOldParsed?.URL ?? "",
          };

          const lSig = files?.[ "landlordSignature" ]?.[ 0 ];
          let landlordOldParsed: any;
          if ( !lSig ) {
            landlordOldParsed = this.mustJSON( req.body.landlordOldSignature, "Landlord old signature" );
            const ensureFileSig = ( o: any ): o is FILE =>
              o &&
              typeof o.fieldname === "string" &&
              typeof o.originalname === "string" &&
              typeof o.mimetype === "string" &&
              typeof o.size === "number" &&
              typeof o.filename === "string" &&
              typeof o.URL === "string";
            if ( !ensureFileSig( landlordOldParsed ) ) throw new Error( "Landlord signature is required!" );
          }
          const organizedLandlordSignature: FILE = {
            fieldname: lSig?.fieldname ?? landlordOldParsed?.fieldname ?? "",
            originalname: lSig?.originalname ?? landlordOldParsed?.originalname ?? "",
            mimetype: lSig?.mimetype ?? landlordOldParsed?.mimetype ?? "",
            size: lSig?.size ?? landlordOldParsed?.size ?? 0,
            filename: lSig?.filename ?? landlordOldParsed?.filename ?? "",
            URL: lSig
              ? `${ hostBaseUrl }/${ this.buildLeaseUrl( leaseID, "signatures", "landlord", lSig.filename ) }`
              : landlordOldParsed?.URL ?? "",
          };

          // sub-docs
          const UPDATE_DATA_TenantInformation: TenantInformation = {
            tenantUsername,
            fullName: tenantFullName,
            nicOrPassport: tenantNICOrPassport,
            gender: tenantGender,
            nationality: tenantNationality,
            dateOfBirth: tenantDateOfBirth,
            phoneCodeDetails: tenantPhoneCodeDetails,
            phoneNumber: tenantPhoneNumber,
            email: tenantEmail,
            permanentAddress: tenantAddress,
            emergencyContact: tenantEmergencyContact,
            scannedDocuments,
          };

          const UPDATE_DATA_leaseAgreement: LeaseAgreement = {
            startDate,
            endDate,
            durationMonths,
            monthlyRent,
            currency,
            paymentFrequency,
            paymentMethod,
            securityDeposit,
            rentDueDate,
            latePaymentPenalties: selectedLatePaymentPenalties,
            utilityResponsibilities: selectedUtilityResponsibilities,
            noticePeriodDays,
          };

          const UPDATE_DATA_signatures: Signatures = {
            tenantSignature: organizedTenantSignature,
            landlordSignature: organizedLandlordSignature,
            signedAt,
            ipAddress,
            userAgent,
          };

          // parent payloads (omit coTenant if undefined)
          const UPDATE_DATA: LeasePayload = {
            leaseID,
            tenantInformation: UPDATE_DATA_TenantInformation,
            ...( UPDATE_DATA_coTenant ? { coTenant: UPDATE_DATA_coTenant } : {} ),
            propertyID: ( selectedProperty as any ).id,
            leaseAgreement: UPDATE_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy,
            signatures: UPDATE_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          const UPDATE_DOCUMENT_DATA: LeasePayloadWithProperty = {
            leaseID,
            tenantInformation: UPDATE_DATA_TenantInformation,
            ...( UPDATE_DATA_coTenant ? { coTenant: UPDATE_DATA_coTenant } : {} ),
            property: selectedProperty,
            leaseAgreement: UPDATE_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy,
            signatures: UPDATE_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          // persist JSON snapshot (version the old copy)
          const todayStamp = new Date().toISOString().replace( /[:.]/g, "-" ).replace( "T", "_" ).replace( "Z", "" );
          const JSON_CURR = this.safeJoin( this.LEASE_UPLOAD_ROOT, leaseID, "data.json" );
          const JSON_OLD = this.safeJoin( this.LEASE_UPLOAD_ROOT, leaseID, "oldAgreements", todayStamp, "data.json" );

          if ( fs.existsSync( JSON_CURR ) ) {
            await fs.promises.mkdir( path.dirname( JSON_OLD ), { recursive: true } );
            await fs.promises.rename( JSON_CURR, JSON_OLD );
          }
          await fs.promises.mkdir( path.dirname( JSON_CURR ), { recursive: true } );
          await fs.promises.writeFile( JSON_CURR, JSON.stringify( UPDATE_DOCUMENT_DATA, null, 2 ), "utf8" );

          // DB update
          const result: LeasePayload = await LeaseModel.updateOne( { leaseID }, { $set: UPDATE_DATA } ).lean<LeasePayload>();

          const actor = await ApiGuardExport.GetNormalisedAuthUser( req );
          if ( !actor ) {
            ApiResponseBuilder.internalError( res, new Error( "Authenticated user not found for notification actor." ) );
            return;
          }

          // -------------------- Notify relevant users --------------------
          await this.notificationHub.emit( {
            eventKey: 'lease:agreement.renewed',
            actor,
            audiences: [
              {
                mode: 'User',
                username: result.tenantInformation.tenantUsername
              },
              {
                mode: 'Role',
                roleKey: 'admin',
              },
              {
                mode: 'Role',
                roleKey: 'operator',
              },
              {
                mode: 'Role',
                roleKey: 'manager',
              },
            ],
            target: {
              actionKey: 'lease:agreement.renewed',
              category: 'Lease',
              module: 'Lease Management',
              params: { leaseID: result.leaseID },
              refId: result.leaseID,
            },
            category: 'Lease',
          } );

          ApiResponseBuilder.ok( res, 'lease', result, 'Lease updated successfully!' );
          return;
        } catch ( error ) {
          console.log( "Error in update lease agreement:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }


  private deleteLeaseAgreement(): void {
    this.router.delete( "/delete-lease-agreement/:leaseID", async ( req: Request<{ leaseID: string; }>, res: Response ) => {
      try {
        const actor = await ApiGuardExport.GetAuthUser( req );
        if ( !actor ) {
          ApiResponseBuilder.internalError( res, new Error( "Authenticated user not found for notification actor." ) );
          return;
        }

        const leaseID = this.mustString( req.params.leaseID, "Lease ID" );

        const leaseAgreementDB = await LeaseModel.findOne( { leaseID } ).lean<LeasePayload>().exec();

        if ( !leaseAgreementDB ) {
          ApiResponseBuilder.notFound( res, 'Lease agreement not found!' );
          return;
        }

        const leaseFileRoot = `public/upoads/leases/${ leaseID }`;
        const scanFiles: FileMetaPacket[] = await FileMetaPacketBuilder.scanTree( {
          bucket: `${ leaseFileRoot }-documents`,
          rootPathLike: leaseFileRoot,
          req,
        } );

        const deletionPlan: DomainDeletePlan<LeasePayload> = {
          snapshotData: leaseAgreementDB as unknown as Record<string, unknown>,
          label: `Lease agreement ${ leaseID }`,
          refId: leaseID,
          sourceKey: 'Lease',
          description: `Delete lease agreement with ID ${ leaseID } and all associated documents.`,
          collectionName: LeaseModel.collection.name,
          module: 'Lease Management',
          tags: [ 'Lease', 'Agreement', 'Document Deletion' ],
          files: scanFiles,
          deleteDbRecord: async ( session?: ClientSession ): Promise<void> => {
            const opts = session ? { session } : {};
            await LeaseModel.deleteOne( { leaseID }, { opts } ).exec();
          },
        };

        const result = await this.deleteService.deleteWithRecycleBin( actor, deletionPlan );

        if ( !result.entry ) {
          ApiResponseBuilder.internalError( res, new Error( "Failed to delete lease agreement." ) );
          return;
        }

        const notificationActor = await ApiGuardExport.GetNormalisedAuthUser( req );
        if ( !notificationActor ) {
          ApiResponseBuilder.internalError( res, new Error( "Authenticated user not found for notification actor." ) );
          return;
        }

        // -------------------- Notify relevant users --------------------
        await this.notificationHub.emit( {
          eventKey: 'lease:agreement.terminated',
          actor: notificationActor,
          audiences: [
            {
              mode: 'User',
              username: leaseAgreementDB.tenantInformation.tenantUsername
            },
            {
              mode: 'Role',
              roleKey: 'admin',
            },
            {
              mode: 'Role',
              roleKey: 'operator',
            },
            {
              mode: 'Role',
              roleKey: 'manager',
            },
          ],
          target: {
            actionKey: 'lease:agreement.terminated',
            category: 'Lease',
            module: 'Lease Management',
            params: { leaseID: leaseAgreementDB.leaseID },
            refId: leaseAgreementDB.leaseID,
          },
          category: 'Lease',
        } );
      } catch ( error ) {
        console.error( "Error in delete lease agreement:", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ============================================================================
  // PREVIEW: EJS Preview (server-side render)
  // GET /preview-lease-agreement/:leaseID
  // ============================================================================

  private setupEjsPreview(): void {
    this.router.get( "/preview-lease-agreement/:leaseID", async ( req: Request<{ leaseID: string; }>, res: Response ) => {
      try {
        const leaseID = this.mustString( req.params.leaseID, "Lease ID" );
        const leaseData: LeasePayload | null = await LeaseModel.findOne( { leaseID } ).lean<LeasePayload>().exec();
        if ( !leaseData ) {
          ApiResponseBuilder.notFound( res, 'Lease not found!' );
          return;
        }
        const property: IProperty | null = await PropertyModel.findOne( { id: leaseData.leaseID } ).lean<IProperty>().exec();
        if ( !property ) {
          ApiResponseBuilder.validationError( res, 'Property not found!' );
          return;
        }

        const leaseWithProperty: LeasePayloadWithProperty = {
          ...leaseData,
          property,
        };

        res.render( "lease-agreement-pdf.ejs", { data: leaseWithProperty } );
        return;
      } catch ( error ) {
        console.log( "Error in preview lease agreement:", error );
        const message = error instanceof Error ? error.message : "Unknown error";
        ApiResponseBuilder.internalError( res, message );
        return;
      }
    } );
  }

  // ============================================================================
  // Puppeteer Browser (singleton-ish)
  // ============================================================================

  private async getBrowser(): Promise<puppeteer.Browser> {
    if ( this.puppeteerBrowser && this.puppeteerBrowser.isConnected() ) return this.puppeteerBrowser;

    const launchOptions: puppeteer.LaunchOptions = {
      headless: true,
      args: [ "--no-sandbox", "--disable-setuid-sandbox" ],
    };

    // Resolve Chrome path cross-platform if available
    const getChromePath = (): string | undefined => {
      const platform = os.platform();
      if ( platform === "win32" ) {
        const paths = [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ];
        return paths.find( ( p ) => fs.existsSync( p ) );
      }
      if ( platform === "darwin" ) {
        const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        return fs.existsSync( mac ) ? mac : undefined;
      }
      if ( platform === "linux" ) {
        const linux = [ "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium" ];
        return linux.find( ( p ) => fs.existsSync( p ) );
      }
      return undefined;
    };

    const chromePath = getChromePath();
    if ( chromePath ) launchOptions.executablePath = chromePath;

    this.puppeteerBrowser = await puppeteer.launch( launchOptions );
    return this.puppeteerBrowser;
  }

  // ============================================================================
  // Preload EJS templates + logo (memory cache)
  // ============================================================================

  private preloadTemplates(): void {
    try {
      const baseDir = path.join( __dirname, "../../public/view/leaseDocumentTemplates/" );
      this.cachedTemplates = {
        header: fs.readFileSync( path.join( baseDir, "header.ejs" ), "utf8" ),
        footer: fs.readFileSync( path.join( baseDir, "footer.ejs" ), "utf8" ),
        main: fs.readFileSync( path.join( baseDir, "lease-agreement-pdf.ejs" ), "utf8" ),
        logoBase64: fs.readFileSync( path.join( __dirname, "../../public/companyData/images/PropEase.png" ) ).toString( "base64" ),
      };
    } catch ( e ) {
      // If preload fails, leave empty; we render-time throw with a clearer error.
      console.error( "[Templates] Preload failed:", e );
      this.cachedTemplates = { header: "", footer: "", main: "", logoBase64: "" };
    }
  }

  // ============================================================================
  // Generate Lease PDF (inline view or download)
  // GET /lease-agreement-pdf/:leaseID/:type/:generator   (type: 'download'|'view')
  // ============================================================================

  private generatePDFOfLeaseAgreement(): void {
    this.router.get( "/lease-agreement-pdf/:leaseID/:type/:generator", async ( req: Request, res: Response ) => {
      try {
        const { leaseID, type, generator } = req.params;
        if ( !leaseID || !type || !generator ) throw new Error( "Missing parameters" );

        const leaseData: LeasePayload | null = await LeaseModel.findOne( { leaseID } ).lean<LeasePayload>().exec();
        if ( !leaseData ) {
          ApiResponseBuilder.notFound( res, 'Lease not found!' );
          return;
        }
        const propertyDoc: IProperty | null = await PropertyModel.findOne( { id: leaseData.propertyID } ).lean<IProperty>().exec();
        if ( !propertyDoc ) {
          ApiResponseBuilder.notFound( res, 'Property not found!' );
          return;
        }

        const leaseWithProperty: LeasePayloadWithProperty = {
          ...leaseData,
          property: propertyDoc,
        };


        if ( leaseWithProperty.tenantInformation?.dateOfBirth ) {
          leaseWithProperty.tenantInformation.dateOfBirth =
            this.formatReadableDate( leaseWithProperty.tenantInformation.dateOfBirth );
        }

        if ( leaseWithProperty.leaseAgreement?.startDate ) {
          leaseWithProperty.leaseAgreement.startDate =
            this.formatReadableDate( leaseWithProperty.leaseAgreement.startDate );
        }

        if ( leaseWithProperty.leaseAgreement?.endDate ) {
          leaseWithProperty.leaseAgreement.endDate =
            this.formatReadableDate( leaseWithProperty.leaseAgreement.endDate );
        }

        if ( leaseWithProperty.signatures?.signedAt ) {
          leaseWithProperty.signatures.signedAt =
            this.formatReadableDate( leaseWithProperty.signatures.signedAt );
        }

        if ( leaseWithProperty.systemMetadata?.lastUpdated ) {
          leaseWithProperty.systemMetadata.lastUpdated =
            this.formatReadableDate( leaseWithProperty.systemMetadata.lastUpdated );
        }

        if ( !this.cachedTemplates.main || !this.cachedTemplates.header || !this.cachedTemplates.footer ) {
          throw new Error( "Templates not loaded. Check template paths and preload." );
        }

        const html = await ejs.render( this.cachedTemplates.main, { data: leaseWithProperty } );
        const header = await ejs.render( this.cachedTemplates.header, {
          logoSrc: `data:image/png;base64,${ this.cachedTemplates.logoBase64 }`,
          companyName: "PropEase Real Estate",
        } );
        const footer = await ejs.render( this.cachedTemplates.footer, {
          qrCodeSrc: await this.generateQRCode( leaseID ),
        } );

        const browser = await this.getBrowser();
        const page = await browser.newPage();
        await page.setContent( html, { waitUntil: "networkidle0" } );
        await page.emulateMediaType( "screen" );

        const pdfBuffer = await page.pdf( {
          format: "A4",
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: header,
          footerTemplate: footer,
          margin: { top: "150px", bottom: "150px" },
          preferCSSPageSize: true,
        } );

        await page.close();

        // Notify download/view
        const actor = await ApiGuardExport.GetNormalisedAuthUser( req );
        if ( !actor ) {
          ApiResponseBuilder.internalError( res, new Error( "Authenticated user not found for notification actor." ) );
          return;
        }

        // -------------------- Notify relevant users --------------------
        await this.notificationHub.emit( {
          eventKey: type.trim().toLowerCase() === "download" ? 'lease:agreement.downloaded' : 'lease:agreement.viewed',
          actor,
          audiences: [
            {
              mode: 'User',
              username: leaseWithProperty.tenantInformation.tenantUsername
            },
            {
              mode: 'Role',
              roleKey: 'admin',
            },
            {
              mode: 'Role',
              roleKey: 'operator',
            },
            {
              mode: 'Role',
              roleKey: 'manager',
            },
          ],
          target: {
            actionKey: type.trim().toLowerCase() === "download" ? 'lease:agreement.downloaded' : 'lease:agreement.viewed',
            category: 'Lease',
            module: 'Lease Management',
            params: { leaseID: leaseWithProperty.leaseID },
            refId: leaseWithProperty.leaseID,
          },
          category: 'Lease',
        } );

        res.setHeader( "Content-Type", "application/pdf" );
        res.setHeader(
          "Content-Disposition",
          type.trim().toLowerCase() === "download" ? `attachment; filename=${ leaseID }-agreement.pdf` : `inline; filename=${ leaseID }-agreement.pdf`
        );
        res.send( pdfBuffer );
        return;
      } catch ( error ) {
        console.error( "Error generating PDF:", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ============================================================================
  // Utilities used by PDF
  // ============================================================================

  /** Generate a base64 PNG QR code from input text. */
  private async generateQRCode( data: string ): Promise<string> {
    try {
      return await QRCode.toDataURL( data, {
        errorCorrectionLevel: "H",
        type: "image/png",
        margin: 2,
        width: 512,
        color: { dark: "#000000", light: "#ffffff" },
      } );
    } catch ( error ) {
      console.error( "QR code generation failed:", error );
      return "";
    }
  }

  /** Build a Static Maps image (base64) for PDFs. Falls back to embeddedUrl string. */
  private async makeDinamicMAPURL( input: LeasePayloadWithProperty[ 'property' ][ 'location' ] ): Promise<string> {
    try {
      const APIkey = ENV.google.GOOGLE_API_KEY;

      if ( !input?.embeddedUrl || !input.lat || !input.lng ) return '';

      const lat: number = input.lat;
      const lng: number = input.lng;
      const embeddedUrl: string = input.embeddedUrl.trim();

      const staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${ lat },${ lng }&zoom=14&size=800x300&maptype=roadmap&markers=color:red%7C${ lat },${ lng }&key=${ APIkey }`;
      const response = await axios.get( staticMapUrl, { responseType: "arraybuffer", timeout: 15_000 } );
      if ( response.status === 200 ) {
        return `data:image/png;base64,${ Buffer.from( response.data ).toString( "base64" ) }`;
      }
      return embeddedUrl || "";
    } catch ( error ) {
      if ( axios.isAxiosError( error ) && error.response?.data ) {
        try {
          const text = Buffer.from( error.response.data ).toString( "utf8" );
          console.error( "Google Maps error text:", text );
        } catch {
          console.error( "Error converting Google Maps error to text" );
        }
      }
      console.error( "Error generating map URL:", error );
      return "";
    }
  }

  // Date to human friendly string
  private formatReadableDate( dateString: Date | string ): string {
    const date = new Date( dateString );
    if ( isNaN( date.getTime() ) ) return ""; // safety

    const day = date.getDate();
    const month = date.toLocaleString( "en-US", { month: "long" } );
    const year = date.getFullYear();

    const hour = date.getHours() % 12 || 12;
    const minute = date.getMinutes().toString().padStart( 2, "0" );
    const ampm = date.getHours() >= 12 ? "pm" : "am";

    // Suffix for st/nd/rd/th
    const suffix =
      day % 10 === 1 && day !== 11 ? "st" :
        day % 10 === 2 && day !== 12 ? "nd" :
          day % 10 === 3 && day !== 13 ? "rd" : "th";

    return `${ day }${ suffix } ${ month } ${ year } at ${ hour }.${ minute }${ ampm }`;
  }

  // ============================================================================
  // GET: Lease by leaseID
  // GET /lease-agreement/:leaseID
  // ============================================================================

  private getLeaseAgreementsByLeaseID(): void {
    this.router.get( "/lease-agreement/:leaseID", async ( req: Request<{ leaseID: string; }>, res: Response ) => {
      try {
        const leaseID = this.mustString( req.params.leaseID, "Lease ID" );
        const data = await LeaseModel.findOne( { leaseID } ).lean<LeasePayload>().exec();
        if ( !data ) {
          ApiResponseBuilder.validationError( res, `No lease agreements found for this lease ID (${ leaseID }).` );
          return;
        }

        ApiResponseBuilder.ok( res, 'lease', data, `Lease agreements retrieved successfully!` );
        return;
      } catch ( error ) {
        console.log( "Error in get lease by id:", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ============================================================================
  // GET: All leases by username
  // GET /lease-agreements/:username
  // ============================================================================

  private getAllLeaseAgreementsByUsername(): void {
    this.router.get( "/lease-agreements/:username", async ( req: Request<{ username: string; }>, res: Response ) => {
      try {
        const safeUsername = this.sanitizeIdentifier( req.params.username );
        if ( !safeUsername ) throw new Error( "Username is required!" );

        const leaseAgreements: LeasePayload[] = await LeaseModel.find( {
          "tenantInformation.tenantUsername": safeUsername,
        } )
          .sort( { "systemMetadata.lastUpdated": -1 } )
          .lean<LeasePayload>().exec() as unknown as LeasePayload[];

        if ( !leaseAgreements || leaseAgreements.length === 0 ) {
          ApiResponseBuilder.validationError( res, `No lease agreements found for this user.` );
          return;
        }

        ApiResponseBuilder.ok( res, 'leases', leaseAgreements, `Lease agreements retrieved successfully!` );

        return;
      } catch ( error ) {
        console.log( "Error in get all lease agreements:", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ============================================================================
  // PUT: Update validation status of a lease (by leaseID)
  // PUT /lease-status-updated/:leaseID
  // ============================================================================

  private getLeaseAgreementByIDAndUpdateValidationStatus(): void {
    const upload = multer(); // for parsing form-data without files
    this.router.put( "/lease-status-updated/:leaseID", upload.none(), async ( req: Request<{ leaseID: string; }>, res: Response ) => {
      try {
        const safeLeaseID = this.mustString( req.params.leaseID, "Lease ID" );
        const validationStatus = this.mustString( req.body.validationStatus, "Validation status" );

        if ( !this.checkIsString( validationStatus ) ) throw new Error( "Validation should be string!" );

        const lastUpdated = new Date().toISOString();

        const leaseAgreement = await LeaseModel.findOneAndUpdate(
          { leaseID: safeLeaseID },
          { "systemMetadata.validationStatus": validationStatus, "systemMetadata.lastUpdated": lastUpdated },
          { new: true }
        ).lean<LeasePayload>();

        if ( !leaseAgreement ) {
          ApiResponseBuilder.notFound( res, "No lease agreement found for this lease ID." );
          return;
        }

        ApiResponseBuilder.ok( res, 'lease', leaseAgreement, "Lease agreement has been updated successfully!" );
        return;
      } catch ( error ) {
        console.log( "Error in update lease validation status:", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ============================================================================
  // GET: All leases (with simple pagination)
  // GET /all-leases?page=&limit=
  // ============================================================================

  private getAllLeases(): void {
    this.router.get(
      '/all-leases',
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          // ──────────────────────────────────────────────
          // 1) Pagination parameters
          // ──────────────────────────────────────────────
          let limit: number = parseInt( ( req.query.limit as string ) || '20', 10 );
          if ( isNaN( limit ) || limit < 1 ) limit = 20;
          if ( limit > 100 ) limit = 100;

          let page: number;
          let skip: number;

          if ( typeof req.query.start !== 'undefined' ) {
            // Frontend sends start = skip (0-based offset)
            const startRaw: number = parseInt( req.query.start as string, 10 );
            const start: number = isNaN( startRaw ) ? 0 : Math.max( startRaw, 0 );

            skip = start;
            page = Math.floor( skip / limit ) + 1; // derive human page (1-based)
          } else {
            // Fallback: page-based API
            const pageRaw: number = parseInt( ( req.query.page as string ) || '1', 10 );
            page = isNaN( pageRaw ) ? 1 : Math.max( pageRaw, 1 );
            skip = ( page - 1 ) * limit;
          }

          // ──────────────────────────────────────────────
          // 2) Search filter (lease + property-aware)
          // ──────────────────────────────────────────────
          const rawSearch: string = this.s( req.query.search );
          const leaseFilter: FilterQuery<LeasePayload> = {};
          const propertyFilter: FilterQuery<IProperty> = {};

          // We will build an $or array for leases
          const leaseOr: FilterQuery<LeasePayload>[] = [];

          if ( rawSearch && rawSearch.trim() !== '' ) {
            const rx = new RegExp( rawSearch.trim(), 'i' );

            // 2.1 Lease direct text search
            leaseOr.push(
              { leaseID: { $regex: rx } },
              { propertyID: { $regex: rx } },
              { 'tenantInformation.tenantUsername': { $regex: rx } },
              { 'tenantInformation.fullName': { $regex: rx } }
            );

            // 2.2 Property text search
            propertyFilter.$or = [
              { id: { $regex: rx } },
              { title: { $regex: rx } },
              { type: { $regex: rx } },
              { developerName: { $regex: rx } },
              { projectName: { $regex: rx } },
              { featuresAndAmenities: { $regex: rx } },
              { 'address.houseNumber': { $regex: rx } },
              { 'address.street': { $regex: rx } },
              { 'address.city': { $regex: rx } },
              { 'address.stateOrProvince': { $regex: rx } },
              { 'address.country': { $regex: rx } }
            ];

            // 2.3 Use property results to extend lease search
            const matchedPropertiesRaw: IProperty[] = await PropertyModel.find(
              propertyFilter,
              { id: 1, _id: 0 } // only bring `id`
            )
              .lean<IProperty>()
              .exec() as unknown as IProperty[];

            // Tell TS: "this array only has an `id` field that we care about"
            const matchedProperties = matchedPropertiesRaw as Array<{ id?: unknown; }>;


            const propertyIds: string[] = matchedProperties
              .map( ( p ) => p.id )
              .filter( ( id ): id is string => typeof id === 'string' && id.trim().length > 0 );

            if ( propertyIds.length > 0 ) {
              // Add a condition: lease.propertyID is in the matched property list
              leaseOr.push( { propertyID: { $in: propertyIds } } );
            }
          }

          // Apply $or only if we actually have conditions
          if ( leaseOr.length > 0 ) {
            leaseFilter.$or = leaseOr;
          }

          // ──────────────────────────────────────────────
          // 3) Sorting
          // ──────────────────────────────────────────────
          const sortBy: string = ( req.query.sortBy as string ) || 'createdAt';
          const sortOrder: string = ( req.query.sortOrder as string ) || 'desc';

          const sort: Record<string, 1 | -1> = {
            [ sortBy ]: sortOrder === 'asc' ? 1 : -1
          };

          // ──────────────────────────────────────────────
          // 4) DB query (leases only, but property-aware)
          // ──────────────────────────────────────────────
          const [ leases, total ] = await Promise.all( [
            LeaseModel.find( leaseFilter )
              .sort( sort )
              .skip( skip )
              .limit( limit )
              .lean<LeasePayload>()
              .exec() as unknown as LeasePayload[],
            LeaseModel.countDocuments( leaseFilter )
          ] );

          // 1) Total pages (0 if no records)
          const totalPages: number = total > 0 ? Math.ceil( total / limit ) : 0;

          // 2) Zero-based page index (used internally)
          const index: number = page > 0 ? page - 1 : 0;

          // 3) If there are no results, normalize start/end to 0
          const hasResults: boolean = total > 0;

          // 4) Start = first record index for this page (0-based)
          const start: number = hasResults ? skip : 0;

          // 5) End = last record index for this page (0-based, inclusive)
          const end: number = hasResults
            ? Math.min( skip + leases.length - 1, total - 1 )
            : 0;

          // 6) Construct pagination meta
          const pagination: PaginationMeta = {
            index,                     // 0,1,2…
            limit,                     // page size
            total,                     // total records in DB
            start,                     // 0-based first record index
            end,                       // 0-based last record index
            // Correct logic: based on CURRENT page
            hasNext: page < totalPages,
            hasPrevious: page > 1 && totalPages > 0
          };

          if ( rawSearch && rawSearch.trim() !== '' ) {
            pagination.search = rawSearch.trim();  // always string here
          }


          // ──────────────────────────────────────────────
          // 5) Response
          // ──────────────────────────────────────────────
          ApiResponseBuilder.ok( res, 'leases', leases, 'All leases retrieved successfully!', { pagination } );

          return;
        } catch ( error ) {
          console.error( error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }




  // ============================================================================
  // GET: Total lease count
  // GET /get-lease-count
  // ============================================================================
  private getTotalLeaseCount() {
    this.router.get( "/get-lease-count", async ( _req: Request, res: Response ) => {
      try {
        const data = await LeaseModel.countDocuments();
        const pagination: PaginationMeta = {
          total: data,
        };
        ApiResponseBuilder.ok( res, 'other', {}, `Total number of leases are ${ data }`, { pagination } );
      } catch ( error ) {
        console.error( error );
        ApiResponseBuilder.internalError( res, error );
      }
    } );
  }

  // ============================================================================
  // GET: Get all properties that are NOT currently leased
  // GET /get-properties-that-does-not-have-lease
  // ============================================================================
  private getAllPropertiesThatDoesNotHaveLease() {
    this.router.get( "/get-properties-that-does-not-have-lease", async ( req: Request, res: Response ): Promise<void> => {
      try {
        // -----------------------------
        // Pagination: limit
        // -----------------------------
        let limit: number = parseInt( req.query.limit as string, 10 );
        if ( Number.isNaN( limit ) || limit < 1 ) limit = 20;
        if ( limit > 100 ) limit = 100;

        // -----------------------------
        // Pagination: skip
        // -----------------------------
        let page: number;
        let skip: number;

        if ( typeof req.query.start !== "undefined" || req.query.start !== null ) {
          const startRaw = parseInt( req.query.start as string, 10 );
          const start = Number.isNaN( startRaw ) ? 0 : Math.max( 0, startRaw );
          skip = start;
          page = Math.floor( skip / limit ) + 1;
        } else {
          const pageRaw = parseInt( ( req.query.page as string ) || "1", 10 );
          page = Number.isNaN( pageRaw ) ? 1 : Math.max( 1, pageRaw );
          skip = ( page - 1 ) * limit;
        }

        // -----------------------------
        // Get list of leased propertyIDs
        // -----------------------------
        const leaseProperties: LeasePayload[] = await LeaseModel
          .find()
          .select( { propertyID: 1, _id: 0 } )
          .lean<LeasePayload>()
          .exec() as unknown as LeasePayload[];

        const leasedPropertyIds: string[] = leaseProperties.map( item => item.propertyID );

        // -----------------------------
        // Base filter: Exclude leased properties
        // -----------------------------
        const filter: FilterQuery<IProperty> = {
          id: { $nin: leasedPropertyIds }
        };

        // -----------------------------
        // Search filter
        // -----------------------------
        const rawSearch = this.s( req.query.search ).trim();

        if ( rawSearch !== "" || rawSearch.length > 0 ) {
          const rx = new RegExp( rawSearch.trim(), "i" );

          filter.$or = [
            { title: { $regex: rx } },
            { id: { $regex: rx } },
            { type: { $regex: rx } },
            { listing: { $regex: rx } },
            { furnishingStatus: { $regex: rx } },
            { propertyCondition: { $regex: rx } },
            { "address.country": { $regex: rx } },
            { "address.city": { $regex: rx } },

          ];
        }

        // -----------------------------
        // Sorting
        // -----------------------------
        const sortBy = ( req.query.sortBy as string ) || "createdAt";
        const sortOrder = ( req.query.sortOrder as string ) === "asc" ? 1 : -1;

        const sort: Record<string, 1 | -1> = { [ sortBy ]: sortOrder };

        // -----------------------------
        // Query properties + count
        // -----------------------------
        const [ properties, total ] = await Promise.all( [
          PropertyModel.find( filter )
            .sort( sort )
            .skip( skip )
            .limit( limit )
            .lean<IProperty>()
            .exec() as unknown as IProperty[],
          PropertyModel.countDocuments( filter )
        ] );

        // 1) Total pages (0 if no records)
        const totalPages: number = total > 0 ? Math.ceil( total / limit ) : 0;

        // 2) Zero-based page index (used internally)
        const index: number = page > 0 ? page - 1 : 0;

        // 3) If there are no results, normalize start/end to 0
        const hasResults: boolean = total > 0;

        // 4) Start = first record index for this page (0-based)
        const start: number = hasResults ? skip : 0;

        // 5) End = last record index for this page (0-based, inclusive)
        const end: number = hasResults
          ? Math.min( skip + properties.length - 1, total - 1 )
          : 0;

        // 6) Construct pagination meta
        const pagination: PaginationMeta = {
          index,                     // 0,1,2…
          limit,                     // page size
          total,                     // total records in DB
          start,                     // 0-based first record index
          end,                       // 0-based last record index
          // Correct logic: based on CURRENT page
          hasNext: page < totalPages,
          hasPrevious: page > 1 && totalPages > 0,
          hasResults,
        };

        if ( rawSearch && rawSearch.trim() !== '' ) {
          pagination.search = rawSearch.trim();  // always string here
        }

        // `Total number of properties without lease: ${ total }`

        ApiResponseBuilder.ok( res, 'properties', properties, `Total number of properties without lease: ${ total }` );
        return;

      } catch ( error ) {
        console.error( "ERROR (get-properties-that-does-not-have-lease):", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ============================================================================
  // GET: All properties count without leases
  // GET /get-all-properties-count-without-leases
  // ============================================================================
  private getAllPropertiesCountWitoutLease() {
    this.router.get( "/get-all-properties-count-without-leases", async ( req: Request, res: Response ): Promise<void> => {
      try {
        // -----------------------------
        // Get list of leased propertyIDs
        // -----------------------------
        type LeasePropertyPick = { propertyID?: string | null; };
        const leaseProperties: LeasePropertyPick[] = await LeaseModel
          .find()
          .select( { propertyID: 1, _id: 0 } )
          .lean<LeasePropertyPick>()
          .exec() as unknown as LeasePropertyPick[];

        const leasedPropertyIds: string[] = leaseProperties
          .map( item => item.propertyID )
          .filter( ( id ): id is string => typeof id === 'string' && id.trim().length > 0 )
          .map( id => id.trim() );

        // -----------------------------
        // Base filter: Exclude leased properties
        // -----------------------------
        const filter: FilterQuery<IProperty> = {
          id: { $nin: leasedPropertyIds }
        };

        // -----------------------------
        // Query properties + count
        // -----------------------------
        const total = await PropertyModel.countDocuments( filter );


        const pagination: PaginationMeta = {
          total,
        };

        ApiResponseBuilder.ok( res, 'other', {}, `Total number of properties without lease: ${ total }`, { pagination } );
        return;

      } catch ( error ) {
        console.error( "ERROR (get-properties-that-does-not-have-lease):", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }


  // ============================================================================
  // GET: User by username
  // GET /get-tenant-by-username/:username
  // ============================================================================

  private getTenantByUsername(): void {
    this.router.get( "/get-tenant-by-username/:username", async ( req: Request<{ username: string; }>, res: Response ) => {
      try {
        const safeUsername = this.sanitizeIdentifier( req.params.username );
        if ( !safeUsername ) throw new Error( "Username is required!" );
        const user = await UserModel.findOne( { username: safeUsername }, USER_MODEL_PROJECTION ).lean<User>();
        if ( !user ) {
          ApiResponseBuilder.notFound( res, 'User not found!' );
          return;
        }
        ApiResponseBuilder.ok( res, 'user', user, "User retrieved successfully!" );
        return;
      } catch ( error ) {
        console.log( error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }


  // ============================================================================
  // Type checks (kept from your original, lightly adjusted)
  // ============================================================================


  // --- Narrow/convert ---
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

  private checkSystemMetaDataFormat( input: any ): input is SystemMetadata {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return (
      typeof data.ocrAutoFillStatus === "boolean" &&
      typeof data.validationStatus === "string" &&
      typeof data.language === "string" &&
      typeof data.leaseTemplateVersion === "string" &&
      typeof data.lastUpdated === "string"
    );
  }

  private checkRentDueDateFormat( input: any ): input is RentDueDate {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return typeof data.id === "string" && typeof data.label === "string";
  }

  private checkAddedBy( input: any ): input is AddedBy {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return (
      typeof data.username === "string" &&
      typeof data.name === "string" &&
      typeof data.email === "string" &&
      typeof data.role === "string" &&
      ( typeof data.addedAt === "string" || data.addedAt instanceof Date )
    );
  }

  private checkIsString( input: any ): input is string {
    return typeof input === "string" && input.trim().length > 0;
  }

  private checkRuleAndRegulationsFormat( input: any ): input is RulesAndRegulations[] {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !Array.isArray( data ) ) return false;
    return data.every( ( item ) => item && typeof item.rule === "string" && typeof item.description === "string" );
  }

  private checkNoticePeriodDaysFormat( input: any ): input is NoticePeriod {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return typeof data.id === "string" && typeof data.label === "string" && typeof data.days === "number" && typeof data.description === "string";
  }

  private checkUtilityResponsibilitiesFormat( input: any ): input is UtilityResponsibility[] {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !Array.isArray( data ) ) return false;
    return data.every(
      ( item ) => item && typeof item.id === "string" && typeof item.utility === "string" && typeof item.paidBy === "string" && typeof item.description === "string"
    );
  }

  private checkLatePaymentPenaltiesFormat( input: any ): input is LatePaymentPenalty[] {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !Array.isArray( data ) ) return false;
    return data.every(
      ( item ) => item && typeof item.label === "string" && typeof item.type === "string" && typeof item.value === "number" && typeof item.description === "string"
    );
  }

  private checkSecurityDepositFormat( input: any ): input is SecurityDeposit {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return typeof data.id === "string" && typeof data.name === "string" && typeof data.description === "string" && typeof data.refundable === "boolean";
  }

  private checkPaymentMethodFormat( input: any ): input is PaymentMethod {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return typeof data.id === "string" && typeof data.name === "string" && typeof data.category === "string";
  }

  private checkPaymentFrequencyFormat( input: any ): input is PaymentFrequency {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return typeof data.id === "string" && typeof data.name === "string" && typeof data.duration === "string" && typeof data.unit === "string";
  }

  private checkCurrencyFormat( input: any ): input is CurrencyFormat {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return (
      typeof data.country === "string" &&
      typeof ( data as any ).symbol === "string" && // your schema allows string
      typeof data.flags === "object" &&
      typeof data.flags.png === "string" &&
      typeof data.flags.svg === "string" &&
      typeof data.currency === "string"
    );
  }

  private checkISODate( input: any ): boolean {
    if ( typeof input !== "string" ) return false;
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}:\d{2}(.\d+)?(Z|([+-]\d{2}:\d{2})))?$/;
    return isoDateRegex.test( input ) && !isNaN( Date.parse( input ) );
  }

  private checkIsPhoneCodeDetails( input: any ): boolean {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return typeof data.name === "string" && typeof data.code === "string" && typeof data.flags === "object" && typeof data.flags.png === "string" && typeof data.flags.svg === "string";
  }

  private checkIsEmergencyContact( input: any ): input is EmergencyContact {
    try {
      const data = typeof input === "string" ? JSON.parse( input ) : input;
      if ( !data || typeof data !== "object" ) return false;
      return typeof data.name === "string" && typeof data.relationship === "string" && typeof data.contact === "string";
    } catch {
      return false;
    }
  }

  private isValidTenantAddress( input: any ): input is Address {
    const data = typeof input === "string" ? JSON.parse( input ) : input;
    if ( !data || typeof data !== "object" ) return false;
    return (
      typeof data.houseNumber === "string" &&
      typeof data.street === "string" &&
      typeof data.city === "string" &&
      typeof data.stateOrProvince === "string" &&
      typeof data.postalCode === "string" &&
      typeof data.country === "object"
    );
  }
}