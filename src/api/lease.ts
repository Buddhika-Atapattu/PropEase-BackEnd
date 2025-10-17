///src/api/lease.ts
// ============================================================================
// Lease API Controller
// - Registers and updates lease agreements (files + DB)
// - Renders EJS preview and generates Puppeteer PDFs
// - Queries leases by username/ID with safe helpers
// - Beginner-friendly comments included
// ============================================================================

import express, {Request, Response, Router} from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import multer from "multer";
import axios from "axios";
import * as libre from "libreoffice-convert"; // (kept if you later reuse for docs)
import {promisify} from "util";
import * as puppeteer from "puppeteer";
import ejs from "ejs";
import * as os from "os";
import QRCode from "qrcode";

import {
  LeaseModel,
  TenantInformation,
  CoTenant,
  Address,
  EmergencyContact,
  CurrencyFormat,
  PaymentFrequency,
  PaymentMethod,
  SecurityDeposit,
  RentDueDate,
  LatePaymentPenalty,
  UtilityResponsibility,
  NoticePeriod,
  LeaseAgreement,
  RulesAndRegulations,
  Signatures,
  SystemMetadata,
  LeaseType,
  CountryCodes,
  AddedBy,
  FILE,
  TokenViceData,
  ScannedFileRecordJSON,
  LeasePayload,
  LeasePayloadWithProperty,
} from "../models/lease.model";

import {Property} from "../models/property.model";
import {UserModel} from "../models/user.model";
import {CryptoService} from "../services/crypto.service";
import NotificationService from "../services/notification.service";

dotenv.config();

// Optional (future): promisify libre if you add DOC->PDF here
const convertToPDF = promisify(libre.convert);

// ----------------------- Small constants / limits -----------------------
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB per file as a sane cap
const ALLOWED_MIME = new Set<string>([
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
]);

type TokenPayload = {tenant?: string; issuedAt?: number};

export default class Lease {
  // --------------------------- Static roots ---------------------------
  private readonly PUBLIC_ROOT = path.resolve(__dirname, "../../public");
  private readonly UPLOADS_ROOT = path.join(this.PUBLIC_ROOT, "uploads");
  private readonly RECYCLEBIN_ROOT = path.join(this.PUBLIC_ROOT, "recyclebin");

  // Leases
  private readonly LEASE_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, "leases");
  private readonly LEASE_UPLOAD_DIR_URL = "uploads/leases";
  private readonly LEASE_RECYCLE_ROOT = path.join(this.RECYCLEBIN_ROOT, "leases");
  private readonly LEASE_RECYCLE_DIR_URL = "recyclebin/leases";

  // Tenants (for mobile scanned docs)
  private readonly TENANT_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, "tenants");
  private readonly TENANT_UPLOAD_DIR_URL = "uploads/tenants";
  private readonly TENANT_RECYCLE_ROOT = path.join(this.RECYCLEBIN_ROOT, "tenants");
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
  } = {header: "", footer: "", main: "", logoBase64: ""};

  constructor () {
    this.router = express.Router();

    // Register routes
    this.registerLeaseAgreement();                 // POST /register/:leaseID   (create)
    this.updateLeaseAgreement();                   // PUT  /update-lease-agreement/:leaseID  (update)
    this.setupEjsPreview();                        // GET  /preview-lease-agreement/:leaseID (EJS preview)
    this.generatePDFOfLeaseAgreement();            // GET  /lease-agreement-pdf/:leaseID/:type/:generator
    this.getAllLeaseAgreementsByUsername();        // GET  /lease-agreements/:username
    this.getLeaseAgreementsByLeaseID();            // GET  /lease-agreement/:leaseID
    this.getLeaseAgreementByIDAndUpdateValidationStatus(); // PUT /lease-status-updated/:leaseID
    this.getTenantByUsername();                    // GET  /get-tenant-by-username/:username
    this.getAllLeases();                           // GET  /all-leases?page=&limit=

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
  private getBaseUrl(req: Request): string {
    const forwardedProto = (req.headers["x-forwarded-proto"] as string) || "";
    const protocol = forwardedProto.split(",")[0]?.trim() || req.protocol;
    const host = req.get("host") || "localhost";
    return `${protocol}://${host}`;
  }

  /** Prevent path traversal by normalizing under a root. */
  private safeJoin(root: string, ...segments: string[]): string {
    const target = path.normalize(path.join(root, ...segments));
    const normalizedRoot = path.normalize(root);
    if(!target.startsWith(normalizedRoot)) {
      throw new Error("Unsafe path resolution detected.");
    }
    return target;
  }

  /** Create/return lease directory path; optionally ensure (mkdir -p). */
  private buildLeasePath(leaseID: string, ensure = false, ...segments: string[]): string {
    const p = this.safeJoin(this.LEASE_UPLOAD_ROOT, leaseID, ...segments);
    if(ensure) fs.mkdirSync(p, {recursive: true});
    return p;
  }

  /** Public URL under /public for lease files. */
  private buildLeaseUrl(leaseID: string, ...segments: string[]): string {
    return [this.LEASE_UPLOAD_DIR_URL, leaseID, ...segments].join("/");
  }

  /** Build tenant path (e.g., scanned/mobile). */
  private buildTenantPath(username: string, ensure = false, ...segments: string[]): string {
    const p = this.safeJoin(this.TENANT_UPLOAD_ROOT, username, ...segments);
    if(ensure) fs.mkdirSync(p, {recursive: true});
    return p;
  }

  /** Public URL for tenant files. */
  private buildTenantUrl(username: string, ...segments: string[]): string {
    return [this.TENANT_UPLOAD_DIR_URL, username, ...segments].join("/");
  }

  /** Simple filename sanitizer to avoid weird characters + collisions. */
  private sanitizeFilename(original: string): string {
    const base = original.replace(/\s+/g, "_").replace(/[^\w.\-]/g, "");
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    return `${uniqueSuffix}-${base}`;
  }

  /** Parse a required string from any input; throws a helpful error. */
  private mustString(v: unknown, name: string): string {
    if(typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
    return v.trim();
  }

  /** Parse and validate an ISO date string (YYYY-MM-DD or full ISO). */
  private mustISODate(v: unknown, name: string): string {
    const s = this.mustString(v, name);
    if(!this.checkISODate(s)) throw new Error(`${name} must be ISO date (YYYY-MM-DD).`);
    return s;
  }

  /** Parse JSON from string with typed generics and friendly error. */
  private mustJSON<T = any>(v: unknown, name: string): T {
    const s = this.mustString(v, name);
    try {
      return JSON.parse(s) as T;
    } catch {
      throw new Error(`${name} must be valid JSON.`);
    }
  }

  /** Parse integer in base-10 with nice error. */
  private toInt10(v: unknown, name: string): number {
    const s = this.mustString(v, name);
    const n = parseInt(s, 10);
    if(!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
    return n;
  }

  /** Parse boolean from common forms ("true"/"false"/"1"/"0"). */
  private parseBoolean(input: string): boolean {
    const val = input?.toString().trim().toLowerCase();
    return val === "true" || val === "1";
  }

  /** Minimal ID/username sanitizer for queries (letters, numbers, _ - .). */
  private sanitizeIdentifier(input: string): string {
    return (input || "").trim().replace(/[^\w.\-]/g, "");
  }

  // ============================================================================
  // CREATE: Register Lease Agreement
  // POST /register/:leaseID
  // ============================================================================

  private registerLeaseAgreement(): void {
    // 1) Configure multer storage and filtering
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        try {
          const leaseID = this.mustString(req.params.leaseID, "Lease ID");
          let uploadPath = "";
          // NOTE: field names are matched exactly; keep existing names for compatibility
          switch(file.fieldname) {
            case "tenantScanedDocuments":
              uploadPath = this.buildLeasePath(leaseID, true, "documents");
              break;
            case "tenantSignature":
              uploadPath = this.buildLeasePath(leaseID, true, "signatures", "tenant");
              break;
            case "landlordSignature":
              uploadPath = this.buildLeasePath(leaseID, true, "signatures", "landlord");
              break;
            default:
              cb(new Error("Unexpected field: " + file.fieldname), "");
              return;
          }
          cb(null, uploadPath);
        } catch(err) {
          cb(err as Error, "");
        }
      },
      filename: (_req, file, cb) => cb(null, this.sanitizeFilename(file.originalname)),
    });

    const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
      if(!ALLOWED_MIME.has(file.mimetype)) {
        cb(new Error(`File type not allowed: ${file.mimetype}`));
        return;
      }
      cb(null, true);
    };

    const upload = multer({
      storage,
      fileFilter,
      limits: {fileSize: MAX_UPLOAD_BYTES, files: 60}, // 50 docs + 2 signatures (+ buffer)
    });

    // 2) Route handler
    this.router.post(
      "/register/:leaseID",
      upload.fields([
        {name: "tenantScanedDocuments", maxCount: 50},
        {name: "tenantSignature", maxCount: 1},
        {name: "landlordSignature", maxCount: 1},
      ]),
      async (req: Request<{leaseID: string}>, res: Response) => {
        try {
          // -------------------- Required maps/guards --------------------
          const ensureFileSig = (obj: any): obj is FILE =>
            obj &&
            typeof obj.fieldname === "string" &&
            typeof obj.originalname === "string" &&
            typeof obj.mimetype === "string" &&
            typeof obj.size === "number" &&
            typeof obj.filename === "string" &&
            typeof obj.URL === "string";

          const files = req.files as {[field: string]: Express.Multer.File[]} | undefined;
          const leaseID = this.mustString(req.params.leaseID || req.body.leaseID, "Lease ID");

          // -------------------- Tenant info --------------------
          const tenantUsername = this.mustString(req.body.tenantUsername, "Tenant ID");
          const tenantFullName = this.mustString(req.body.tenantFullName, "Tenant Full Name");
          const tenantEmail = this.mustString(req.body.tenantEmail, "Tenant Email");
          const tenantNationality = this.mustString(req.body.tenantNationality, "Tenant Nationality");

          const tenantDateOfBirthStr = this.mustISODate(req.body.tenantDateOfBirth, "Tenant date of birth");
          const tenantDateOfBirth = new Date(tenantDateOfBirthStr);
          if(Number.isNaN(tenantDateOfBirth.getTime())) throw new Error("Tenant date of birth is not a valid date");

          if(!this.checkIsPhoneCodeDetails(this.mustString(req.body.tenantPhoneCodeDetails, "Tenant phone code")))
            throw new Error("Invalid tenant phone code details");
          const tenantPhoneCodeDetails: CountryCodes = this.mustJSON(req.body.tenantPhoneCodeDetails, "Tenant phone code");

          const tenantPhoneNumber = this.mustString(req.body.tenantPhoneNumber, "Tenant Phone Number");
          const tenantGender = this.mustString(req.body.tenantGender, "Tenant Gender");
          const tenantNICOrPassport = this.mustString(req.body.tenantNICOrPassport, "Tenant NIC OR Passport");

          if(!this.isValidTenantAddress(this.mustString(req.body.tenantAddress, "Tenant Address")))
            throw new Error("Invalid tenant address object");
          const tenantAddress: Address = this.mustJSON(req.body.tenantAddress, "Tenant Address");

          if(!this.checkIsEmergencyContact(req.body.emergencyContact))
            throw new Error("Invalid tenant emergency contact object");
          const tenantEmergencyContact: EmergencyContact = this.mustJSON(req.body.emergencyContact, "Emergency Contact");

          // -------------------- Co-tenant (optional) --------------------
          const coTenantFullname = (req.body.coTenantFullname as string | undefined)?.trim();
          const coTenantEmail = (req.body.coTenantEmail as string | undefined)?.trim();
          const coTenantPhoneCodeId = (req.body.coTenantPhoneCodeId as string | undefined)?.trim();
          const coTenantPhoneNumber = (req.body.coTenantPhoneNumber as string | undefined)?.trim();
          const coTenantGender = (req.body.coTenantGender as string | undefined)?.trim();
          const coTenantNicOrPassport = (req.body.coTenantNicOrPassport as string | undefined)?.trim();
          const coTenantAgeStr = (req.body.coTenantAge as string | undefined)?.trim();
          const coTenantRelationship = (req.body.coTenantRelationship as string | undefined)?.trim();

          let INSERT_DATA_coTenant: CoTenant | undefined;
          const anyCoTenantFieldProvided =
            !!(coTenantFullname ||
              coTenantEmail ||
              coTenantPhoneCodeId ||
              coTenantPhoneNumber ||
              coTenantGender ||
              coTenantNicOrPassport ||
              coTenantAgeStr ||
              coTenantRelationship);

          if(anyCoTenantFieldProvided) {
            const coTenantAge = coTenantAgeStr ? parseInt(coTenantAgeStr, 10) : undefined;
            INSERT_DATA_coTenant = {
              fullName: coTenantFullname ?? "",
              email: coTenantEmail ?? "",
              phoneCode: coTenantPhoneCodeId ?? "",
              phoneNumber: coTenantPhoneNumber ?? "",
              gender: coTenantGender ?? "",
              nicOrPassport: coTenantNicOrPassport ?? "",
              age: (coTenantAge as CoTenant["age"]) ?? 0,
              relationship: coTenantRelationship ?? "",
            };
          }

          // -------------------- Property + agreement core --------------------
          const selectedProperty: Property = this.mustJSON(req.body.selectedProperty, "Selected Property");

          const startDate = this.mustISODate(req.body.startDate, "Agreement starting date");
          const endDate = this.mustISODate(req.body.endDate, "Agreement ending date");
          const durationMonths = this.toInt10(req.body.durationMonths, "Agreement duration in months");
          const monthlyRent = this.toInt10(req.body.monthlyRent, "Agreement monthly rent");

          if(!this.checkCurrencyFormat(this.mustString(req.body.currency, "Currency")))
            throw new Error("Invalid currency");
          const currency: CurrencyFormat = this.mustJSON(req.body.currency, "Currency");

          if(!this.checkPaymentFrequencyFormat(this.mustString(req.body.paymentFrequency, "Payment frequency")))
            throw new Error("Invalid payment frequency");
          const paymentFrequency: PaymentFrequency = this.mustJSON(req.body.paymentFrequency, "Payment frequency");

          if(!this.checkPaymentMethodFormat(this.mustString(req.body.paymentMethod, "Payment method")))
            throw new Error("Invalid payment method");
          const paymentMethod: PaymentMethod = this.mustJSON(req.body.paymentMethod, "Payment method");

          if(!this.checkSecurityDepositFormat(this.mustString(req.body.securityDeposit, "Security deposit")))
            throw new Error("Invalid security deposit");
          const securityDeposit: SecurityDeposit = this.mustJSON(req.body.securityDeposit, "Security deposit");

          if(!this.checkRentDueDateFormat(this.mustString(req.body.rentDueDate, "Rent due date")))
            throw new Error("Invalid rent due date");
          const rentDueDate: RentDueDate = this.mustJSON(req.body.rentDueDate, "Rent due date");

          if(
            !this.checkLatePaymentPenaltiesFormat(
              this.mustString(req.body.selectedLatePaymentPenalties, "Late payment penalties")
            )
          )
            throw new Error("Invalid late payment penalties");
          const selectedLatePaymentPenalties: LatePaymentPenalty[] = this.mustJSON(
            req.body.selectedLatePaymentPenalties,
            "Late payment penalties"
          );

          if(
            !this.checkUtilityResponsibilitiesFormat(
              this.mustString(req.body.selectedUtilityResponsibilities, "Utility responsibilities")
            )
          )
            throw new Error("Invalid utility responsibilities");
          const selectedUtilityResponsibilities: UtilityResponsibility[] = this.mustJSON(
            req.body.selectedUtilityResponsibilities,
            "Utility responsibilities"
          );

          if(!this.checkNoticePeriodDaysFormat(this.mustString(req.body.noticePeriodDays, "Notice period days")))
            throw new Error("Invalid notice period days");
          const noticePeriodDays: NoticePeriod = this.mustJSON(req.body.noticePeriodDays, "Notice period days");

          if(!this.checkRuleAndRegulationsFormat(this.mustString(req.body.selectedRuleAndRegulations, "Rules & regs")))
            throw new Error("Invalid rule and regulations format");
          const selectedRuleAndRegulations: RulesAndRegulations[] = this.mustJSON(
            req.body.selectedRuleAndRegulations,
            "Rules & regs"
          );

          const isReadTheCompanyPolicy: boolean = this.parseBoolean(
            this.mustString(req.body.isReadTheCompanyPolicy, "Company policy confirmation")
          );

          // -------------------- Signatures + meta --------------------
          const signedAtStr = this.mustISODate(req.body.signedAt, "Agreement signed at date");
          const signedAt = new Date(signedAtStr);

          const ipAddress: string =
            (req.headers["x-forwarded-for"] as string | undefined) ?? req.socket.remoteAddress ?? "Unknown IP";

          const baseUrl = this.getBaseUrl(req);

          // -------------------- Move tenant mobile scans into lease folder --------------------
          const scannedDocumentPath = this.buildLeasePath(leaseID, true, "documents");
          const mobileScannedFolderPath = this.buildTenantPath(tenantUsername, false, "scanned", "mobile");

          // removed tokens (currently not mutating the ledger file — kept for future)
          const tenantUploadedScanedDocumentsRemoved: ScannedFileRecordJSON[] = this.mustJSON(
            req.body.tenantUploadedScanedDocumentsRemoved,
            "Removed scanned docs"
          );

          const tenantUploadedScanedDocuments: ScannedFileRecordJSON[] = this.mustJSON(
            req.body.tenantUploadedScanedDocuments,
            "Tenant uploaded scanned docs"
          );

          // Move each referenced file from tenant mobile folder -> lease documents
          tenantUploadedScanedDocuments.forEach((item) => {
            item.files.forEach((doc) => {
              const filename = doc.file.filename;
              const sourcePath = path.join(mobileScannedFolderPath, filename);
              if(fs.existsSync(sourcePath)) {
                const destPath = path.join(scannedDocumentPath, filename);
                doc.file.URL = `${baseUrl}/${this.buildLeaseUrl(leaseID, "documents", filename)}`;
                fs.renameSync(sourcePath, destPath);
              }
            });
          });

          const scannedDocuments: ScannedFileRecordJSON[] = [];
          if(Array.isArray(tenantUploadedScanedDocuments) && tenantUploadedScanedDocuments.length > 0) {
            scannedDocuments.push(...tenantUploadedScanedDocuments);
          }

          // Also include new uploads that came with this request (tenantScanedDocuments)
          const payloadForToken: TokenPayload = {tenant: tenantUsername, issuedAt: Date.now()};
          const token = await this.cryptoService.encrypt(payloadForToken);

          const leaseDocsNow = (files?.["tenantScanedDocuments"] ?? []) as Express.Multer.File[];
          const newScannedBatch: ScannedFileRecordJSON = {
            date: new Date().toISOString(),
            tenant: tenantUsername,
            token,
            files: [],
          };

          leaseDocsNow.forEach((doc) => {
            const data: TokenViceData = {
              ageInMinutes: 0,
              file: {
                fieldname: doc.fieldname,
                originalname: doc.originalname,
                mimetype: doc.mimetype,
                size: doc.size,
                filename: doc.filename,
                URL: `${baseUrl}/${this.buildLeaseUrl(leaseID, "documents", doc.filename)}`,
              },
            };
            newScannedBatch.files.push(data);
          });

          if(newScannedBatch.files.length > 0) scannedDocuments.push(newScannedBatch);

          if(!scannedDocuments.length) {
            throw new Error(
              "No scanned identification document found. Please upload at least one document before submitting."
            );
          }

          // -------------------- Signatures (file or old JSON) --------------------
          const tSig = files?.["tenantSignature"]?.[0];
          const tenantOldSignature = req.body.tenantOldSignature;
          let fallbackTenantSignature: FILE | undefined;
          if(!tSig) {
            if(!ensureFileSig(tenantOldSignature)) throw new Error("Tenant signature is required!");
            fallbackTenantSignature = tenantOldSignature;
          }
          const organizedTenantSignature: FILE = {
            fieldname: tSig?.fieldname ?? fallbackTenantSignature?.fieldname ?? "",
            originalname: tSig?.originalname ?? fallbackTenantSignature?.originalname ?? "",
            mimetype: tSig?.mimetype ?? fallbackTenantSignature?.mimetype ?? "",
            size: tSig?.size ?? fallbackTenantSignature?.size ?? 0,
            filename: tSig?.filename ?? fallbackTenantSignature?.filename ?? "",
            URL: tSig
              ? `${this.buildLeaseUrl(leaseID, "signatures", "tenant", tSig.filename)}`
              : fallbackTenantSignature?.URL ?? "",
          };

          const lSig = files?.["landlordSignature"]?.[0];
          const landlordOldSignature = req.body.landlordOldSignature;
          let fallbackLandlordSignature: FILE | undefined;
          if(!lSig) {
            if(!ensureFileSig(landlordOldSignature)) throw new Error("Landlord signature is required!");
            fallbackLandlordSignature = landlordOldSignature;
          }
          const organizedLandlordSignature: FILE = {
            fieldname: lSig?.fieldname ?? fallbackLandlordSignature?.fieldname ?? "",
            originalname: lSig?.originalname ?? fallbackLandlordSignature?.originalname ?? "",
            mimetype: lSig?.mimetype ?? fallbackLandlordSignature?.mimetype ?? "",
            size: lSig?.size ?? fallbackLandlordSignature?.size ?? 0,
            filename: lSig?.filename ?? fallbackLandlordSignature?.filename ?? "",
            URL: lSig
              ? `${this.buildLeaseUrl(leaseID, "signatures", "landlord", lSig.filename)}`
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
            userAgent: this.mustJSON(req.body.userAgent, "User agent"),
          };

          if(!this.checkSystemMetaDataFormat(this.mustString(req.body.systemMetaData, "System metadata")))
            throw new Error("Invalid system metadata");
          const systemMetaData: SystemMetadata = this.mustJSON(req.body.systemMetaData, "System metadata");

          // -------------------- Parent payloads --------------------
          const INSERT_DATA: LeasePayload = {
            leaseID,
            tenantInformation: INSERT_DATA_TenantInformation,
            ...(INSERT_DATA_coTenant ? {coTenant: INSERT_DATA_coTenant} : {}),
            propertyID: (selectedProperty as any).id, // keep as your current FE sends
            leaseAgreement: INSERT_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy,
            signatures: INSERT_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          const INSERT_DOCUMENT_DATA: LeasePayloadWithProperty = {
            leaseID,
            tenantInformation: INSERT_DATA_TenantInformation,
            ...(INSERT_DATA_coTenant ? {coTenant: INSERT_DATA_coTenant} : {}),
            property: selectedProperty,
            leaseAgreement: INSERT_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy,
            signatures: INSERT_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          // -------------------- Save JSON snapshot for PDF --------------------
          const LEASE_JSON_PATH = this.buildLeasePath(leaseID, true, "agreement-data", "data.json");
          await fs.promises.writeFile(LEASE_JSON_PATH, JSON.stringify(INSERT_DOCUMENT_DATA, null, 2), "utf8");

          // -------------------- Persist in DB --------------------
          const INSERT = new LeaseModel(INSERT_DATA);
          await INSERT.save();

          // -------------------- Notify relevant users --------------------
          const notificationService = new NotificationService();
          const io = req.app.get("io") as import("socket.io").Server;

          await notificationService.createNotification(
            {
              title: "New Lease",
              body: `New lease agreement has been created with ID: ${leaseID}. Please review and validate the agreement.`,
              type: "create",
              severity: "info",
              audience: {mode: "role", usernames: [tenantUsername], roles: ["admin", "operator", "manager"]},
              channels: ["inapp", "email"],
              metadata: {
                tenantUsername,
                lease: INSERT_DOCUMENT_DATA,
                leaseID,
                action: "created",
                performedBy: INSERT_DATA_signatures.userAgent,
                ipAddress,
              },
            },
            (rooms, payload) => rooms.forEach((room) => io.to(room).emit("notification.new", payload))
          );

          res.status(200).json({
            status: "success",
            message: "Agreement has been created successfully!",
            data: INSERT,
          });
          return;
        } catch(error) {
          console.log("Error in register lease agreement:", error);
          res.status(500).json({
            status: "error",
            error: error instanceof Error ? error.message : "An unknown error occurred.",
          });
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
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        try {
          const leaseID = this.mustString(req.params.leaseID, "Lease ID");
          let uploadPath = "";
          switch(file.fieldname) {
            case "tenantScanedDocuments":
              uploadPath = this.buildLeasePath(leaseID, true, "documents");
              break;
            case "tenantSignature":
              uploadPath = this.buildLeasePath(leaseID, true, "signatures", "tenant");
              break;
            case "landlordSignature":
              uploadPath = this.buildLeasePath(leaseID, true, "signatures", "landlord");
              break;
            default:
              cb(new Error("Unexpected field: " + file.fieldname), "");
              return;
          }
          cb(null, uploadPath);
        } catch(err) {
          cb(err as Error, "");
        }
      },
      filename: (_req, file, cb) => cb(null, this.sanitizeFilename(file.originalname)),
    });

    const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
      if(!ALLOWED_MIME.has(file.mimetype)) {
        cb(new Error(`File type not allowed: ${file.mimetype}`));
        return;
      }
      cb(null, true);
    };

    const upload = multer({
      storage,
      fileFilter,
      limits: {fileSize: MAX_UPLOAD_BYTES, files: 60},
    });

    this.router.put(
      "/update-lease-agreement/:leaseID",
      upload.fields([
        {name: "tenantScanedDocuments", maxCount: 50},
        {name: "tenantSignature", maxCount: 1},
        {name: "landlordSignature", maxCount: 1},
      ]),
      async (req: Request<{leaseID: string}>, res: Response) => {
        try {
          const files = req.files as {[field: string]: Express.Multer.File[]} | undefined;

          const leaseID = this.mustString(req.params.leaseID || req.body.leaseID, "Lease ID");
          const leaseAgreementDB = await LeaseModel.findOne({leaseID});
          if(!leaseAgreementDB) throw new Error("Lease agreement not found!");

          // Tenant
          const tenantUsername = this.mustString(req.body.tenantUsername, "Tenant ID");
          const tenantFullName = this.mustString(req.body.tenantFullName, "Tenant Full Name");
          const tenantEmail = this.mustString(req.body.tenantEmail, "Tenant Email");
          const tenantNationality = this.mustString(req.body.tenantNationality, "Tenant Nationality");

          const tenantDOBStr = this.mustISODate(req.body.tenantDateOfBirth, "Tenant date of birth");
          const tenantDateOfBirth = new Date(tenantDOBStr);
          if(Number.isNaN(tenantDateOfBirth.getTime())) throw new Error("Tenant date of birth is not a valid date.");

          if(!this.checkIsPhoneCodeDetails(this.mustString(req.body.tenantPhoneCodeDetails, "Tenant phone code")))
            throw new Error("Invalid tenant phone code details.");
          const tenantPhoneCodeDetails: CountryCodes = this.mustJSON(req.body.tenantPhoneCodeDetails, "Tenant phone code");

          const tenantPhoneNumber = this.mustString(req.body.tenantPhoneNumber, "Tenant Phone Number");
          const tenantGender = this.mustString(req.body.tenantGender, "Tenant Gender");
          const tenantNICOrPassport = this.mustString(req.body.tenantNICOrPassport, "Tenant NIC OR Passport");

          if(!this.isValidTenantAddress(this.mustString(req.body.tenantAddress, "Tenant Address")))
            throw new Error(
              "Invalid tenant address: expected an address with houseNumber, street, city, stateOrProvince, postalCode, and country."
            );
          const tenantAddress: Address = this.mustJSON(req.body.tenantAddress, "Tenant Address");

          if(!this.checkIsEmergencyContact(req.body.emergencyContact))
            throw new Error("Invalid tenant emergency contact.");
          const tenantEmergencyContact: EmergencyContact = this.mustJSON(req.body.emergencyContact, "Emergency Contact");

          // Co-tenant (optional)
          const coTenantFullname = (req.body.coTenantFullname as string | undefined)?.trim();
          const coTenantEmail = (req.body.coTenantEmail as string | undefined)?.trim();
          const coTenantPhoneCodeId = (req.body.coTenantPhoneCodeId as string | undefined)?.trim();
          const coTenantPhoneNumber = (req.body.coTenantPhoneNumber as string | undefined)?.trim();
          const coTenantGender = (req.body.coTenantGender as string | undefined)?.trim();
          const coTenantNicOrPassport = (req.body.coTenantNicOrPassport as string | undefined)?.trim();
          const coTenantAgeStr = (req.body.coTenantAge as string | undefined)?.trim();
          const coTenantRelationship = (req.body.coTenantRelationship as string | undefined)?.trim();

          let UPDATE_DATA_coTenant: CoTenant | undefined;
          const anyCoTenantFieldProvided =
            !!(coTenantFullname ||
              coTenantEmail ||
              coTenantPhoneCodeId ||
              coTenantPhoneNumber ||
              coTenantGender ||
              coTenantNicOrPassport ||
              coTenantAgeStr ||
              coTenantRelationship);

          if(anyCoTenantFieldProvided) {
            const coTenantAge = coTenantAgeStr ? parseInt(coTenantAgeStr, 10) : undefined;
            UPDATE_DATA_coTenant = {
              fullName: coTenantFullname ?? "",
              email: coTenantEmail ?? "",
              phoneCode: coTenantPhoneCodeId ?? "",
              phoneNumber: coTenantPhoneNumber ?? "",
              gender: coTenantGender ?? "",
              nicOrPassport: coTenantNicOrPassport ?? "",
              age: (coTenantAge as CoTenant["age"]) ?? 0,
              relationship: coTenantRelationship ?? "",
            };
          }

          // Property + agreement values
          const selectedProperty: Property = this.mustJSON(req.body.selectedProperty, "Selected Property");
          const startDate = this.mustISODate(req.body.startDate, "Agreement starting date");
          const endDate = this.mustISODate(req.body.endDate, "Agreement ending date");
          const durationMonths = this.toInt10(req.body.durationMonths, "Agreement duration in months");
          const monthlyRent = this.toInt10(req.body.monthlyRent, "Agreement monthly rent");

          if(!this.checkCurrencyFormat(this.mustString(req.body.currency, "Currency")))
            throw new Error("Invalid currency format!");
          const currency: CurrencyFormat = this.mustJSON(req.body.currency, "Currency");

          if(!this.checkPaymentFrequencyFormat(this.mustString(req.body.paymentFrequency, "Payment frequency")))
            throw new Error("Invalid payment frequency format!");
          const paymentFrequency: PaymentFrequency = this.mustJSON(req.body.paymentFrequency, "Payment frequency");

          if(!this.checkPaymentMethodFormat(this.mustString(req.body.paymentMethod, "Payment method")))
            throw new Error("Invalid payment method format!");
          const paymentMethod: PaymentMethod = this.mustJSON(req.body.paymentMethod, "Payment method");

          if(!this.checkSecurityDepositFormat(this.mustString(req.body.securityDeposit, "Security deposit")))
            throw new Error("Invalid security deposit format!");
          const securityDeposit: SecurityDeposit = this.mustJSON(req.body.securityDeposit, "Security deposit");

          if(!this.checkRentDueDateFormat(this.mustString(req.body.rentDueDate, "Rent due date")))
            throw new Error("Invalid rent due date format!");
          const rentDueDate: RentDueDate = this.mustJSON(req.body.rentDueDate, "Rent due date");

          if(
            !this.checkLatePaymentPenaltiesFormat(
              this.mustString(req.body.selectedLatePaymentPenalties, "Late payment penalties")
            )
          )
            throw new Error("Invalid late payment penalties format!");
          const selectedLatePaymentPenalties: LatePaymentPenalty[] = this.mustJSON(
            req.body.selectedLatePaymentPenalties,
            "Late payment penalties"
          );

          if(
            !this.checkUtilityResponsibilitiesFormat(
              this.mustString(req.body.selectedUtilityResponsibilities, "Utility responsibilities")
            )
          )
            throw new Error("Invalid utility responsibility format!");
          const selectedUtilityResponsibilities: UtilityResponsibility[] = this.mustJSON(
            req.body.selectedUtilityResponsibilities,
            "Utility responsibilities"
          );

          if(!this.checkNoticePeriodDaysFormat(this.mustString(req.body.noticePeriodDays, "Notice period days")))
            throw new Error("Invalid notice period days format!");
          const noticePeriodDays: NoticePeriod = this.mustJSON(req.body.noticePeriodDays, "Notice period days");

          if(!this.checkRuleAndRegulationsFormat(this.mustString(req.body.selectedRuleAndRegulations, "Rules & regs")))
            throw new Error("Invalid rule and regulations format!");
          const selectedRuleAndRegulations: RulesAndRegulations[] = this.mustJSON(
            req.body.selectedRuleAndRegulations,
            "Rules & regs"
          );

          const isReadTheCompanyPolicy = this.parseBoolean(
            this.mustString(req.body.isReadTheCompanyPolicy, "Company policy confirmation")
          );

          const signedAtStr = this.mustISODate(req.body.signedAt, "Agreement signed at date");
          const signedAt = new Date(signedAtStr);

          // Meta
          const ipAddress: string =
            (req.headers["x-forwarded-for"] as string | undefined) ?? req.socket.remoteAddress ?? "Unknown IP";

          if(!this.checkAddedBy(this.mustString(req.body.userAgent, "User agent")))
            throw new Error("Invalid added-by format for user agent!");
          const userAgent: AddedBy = this.mustJSON(req.body.userAgent, "User agent");

          if(!this.checkSystemMetaDataFormat(this.mustString(req.body.systemMetaData, "System metadata")))
            throw new Error("Invalid system metadata format!");
          const systemMetaData: SystemMetadata = this.mustJSON(req.body.systemMetaData, "System metadata");
          systemMetaData.lastUpdated = new Date().toISOString();

          // scanned docs: merge & move new
          const baseUrl = this.getBaseUrl(req);
          const scannedDocumentPath = this.buildLeasePath(leaseID, true, "documents");
          const mobileScannedFolderPath = this.buildTenantPath(tenantUsername, false, "scanned", "mobile");

          const tenantUploadedScanedDocumentsRemoved: ScannedFileRecordJSON[] = this.mustJSON(
            req.body.tenantUploadedScanedDocumentsRemoved,
            "Removed scanned docs"
          );

          const tenantUploadedScanedDocuments: ScannedFileRecordJSON[] = this.mustJSON(
            req.body.tenantUploadedScanedDocuments,
            "Tenant uploaded scanned docs"
          );

          tenantUploadedScanedDocuments.forEach((item) => {
            item.files.forEach((doc) => {
              const filename = doc.file.filename;
              const sourcePath = path.join(mobileScannedFolderPath, filename);
              if(fs.existsSync(sourcePath)) {
                const destinationPath = path.join(scannedDocumentPath, filename);
                doc.file.URL = `${baseUrl}/${this.buildLeaseUrl(leaseID, "documents", filename)}`;
                fs.renameSync(sourcePath, destinationPath);
              }
            });
          });

          const scannedDocuments: ScannedFileRecordJSON[] = [];
          if(Array.isArray(tenantUploadedScanedDocuments) && tenantUploadedScanedDocuments.length > 0) {
            scannedDocuments.push(...tenantUploadedScanedDocuments);
          }

          const payloadToken: TokenPayload = {tenant: tenantUsername, issuedAt: Date.now()};
          const token = await this.cryptoService.encrypt(payloadToken);

          const tenantScanedDocuments = files?.["tenantScanedDocuments"];
          const newScannedFileRecord: ScannedFileRecordJSON = {
            date: new Date().toISOString(),
            tenant: tenantUsername,
            token,
            files: [],
          };

          if(Array.isArray(tenantScanedDocuments)) {
            tenantScanedDocuments.forEach((doc) => {
              const data: TokenViceData = {
                ageInMinutes: 0,
                file: {
                  fieldname: doc.fieldname,
                  originalname: doc.originalname,
                  mimetype: doc.mimetype,
                  size: doc.size,
                  filename: doc.filename,
                  URL: `${baseUrl}/${this.buildLeaseUrl(leaseID, "documents", doc.filename)}`,
                },
              };
              newScannedFileRecord.files.push(data);
            });
          }

          if(newScannedFileRecord.files.length > 0) scannedDocuments.push(newScannedFileRecord);

          if(!scannedDocuments.length) {
            throw new Error(
              "No scanned identification document found. Please upload at least one document before submitting."
            );
          }

          // signatures (support old signatures JSON)
          const tSig = files?.["tenantSignature"]?.[0];
          let tenantOldParsed: any;
          if(!tSig) {
            tenantOldParsed = this.mustJSON(req.body.tenantOldSignature, "Tenant old signature");
            const ensureFileSig = (o: any): o is FILE =>
              o &&
              typeof o.fieldname === "string" &&
              typeof o.originalname === "string" &&
              typeof o.mimetype === "string" &&
              typeof o.size === "number" &&
              typeof o.filename === "string" &&
              typeof o.URL === "string";
            if(!ensureFileSig(tenantOldParsed)) throw new Error("Tenant signature is required!");
          }
          const organizedTenantSignature: FILE = {
            fieldname: tSig?.fieldname ?? tenantOldParsed?.fieldname ?? "",
            originalname: tSig?.originalname ?? tenantOldParsed?.originalname ?? "",
            mimetype: tSig?.mimetype ?? tenantOldParsed?.mimetype ?? "",
            size: tSig?.size ?? tenantOldParsed?.size ?? 0,
            filename: tSig?.filename ?? tenantOldParsed?.filename ?? "",
            URL: tSig ? `${this.buildLeaseUrl(leaseID, "signatures", "tenant", tSig.filename)}` : tenantOldParsed?.URL ?? "",
          };

          const lSig = files?.["landlordSignature"]?.[0];
          let landlordOldParsed: any;
          if(!lSig) {
            landlordOldParsed = this.mustJSON(req.body.landlordOldSignature, "Landlord old signature");
            const ensureFileSig = (o: any): o is FILE =>
              o &&
              typeof o.fieldname === "string" &&
              typeof o.originalname === "string" &&
              typeof o.mimetype === "string" &&
              typeof o.size === "number" &&
              typeof o.filename === "string" &&
              typeof o.URL === "string";
            if(!ensureFileSig(landlordOldParsed)) throw new Error("Landlord signature is required!");
          }
          const organizedLandlordSignature: FILE = {
            fieldname: lSig?.fieldname ?? landlordOldParsed?.fieldname ?? "",
            originalname: lSig?.originalname ?? landlordOldParsed?.originalname ?? "",
            mimetype: lSig?.mimetype ?? landlordOldParsed?.mimetype ?? "",
            size: lSig?.size ?? landlordOldParsed?.size ?? 0,
            filename: lSig?.filename ?? landlordOldParsed?.filename ?? "",
            URL: lSig
              ? `${this.buildLeaseUrl(leaseID, "signatures", "landlord", lSig.filename)}`
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
            ...(UPDATE_DATA_coTenant ? {coTenant: UPDATE_DATA_coTenant} : {}),
            propertyID: (selectedProperty as any).id,
            leaseAgreement: UPDATE_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy,
            signatures: UPDATE_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          const UPDATE_DOCUMENT_DATA: LeasePayloadWithProperty = {
            leaseID,
            tenantInformation: UPDATE_DATA_TenantInformation,
            ...(UPDATE_DATA_coTenant ? {coTenant: UPDATE_DATA_coTenant} : {}),
            property: selectedProperty,
            leaseAgreement: UPDATE_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy,
            signatures: UPDATE_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          // persist JSON snapshot (version the old copy)
          const todayStamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
          const JSON_CURR = this.safeJoin(this.LEASE_UPLOAD_ROOT, leaseID, "data.json");
          const JSON_OLD = this.safeJoin(this.LEASE_UPLOAD_ROOT, leaseID, "oldAgreements", todayStamp, "data.json");

          if(fs.existsSync(JSON_CURR)) {
            await fs.promises.mkdir(path.dirname(JSON_OLD), {recursive: true});
            await fs.promises.rename(JSON_CURR, JSON_OLD);
          }
          await fs.promises.mkdir(path.dirname(JSON_CURR), {recursive: true});
          await fs.promises.writeFile(JSON_CURR, JSON.stringify(UPDATE_DOCUMENT_DATA, null, 2), "utf8");

          // DB update
          const result = await LeaseModel.updateOne({leaseID}, {$set: UPDATE_DATA});

          // notify
          const notificationService = new NotificationService();
          const io = req.app.get("io") as import("socket.io").Server;

          await notificationService.createNotification(
            {
              title: "Update Lease",
              body: `Lease agreement has been updated successfully with ID: ${leaseID}. Please review and validate the agreement.`,
              type: "update",
              severity: "info",
              audience: {mode: "user", usernames: [tenantUsername], roles: ["admin", "operator"]},
              channels: ["inapp", "email"],
              metadata: {
                lease: UPDATE_DOCUMENT_DATA,
                leaseID,
                tenantUsername,
                updatedBy: userAgent,
                ipAddress,
                updatedAt: new Date().toISOString(),
              },
            },
            (rooms, payload) => rooms.forEach((room) => io.to(room).emit("notification.new", payload))
          );

          res.status(200).json({
            status: "success",
            message: "Agreement has been updated successfully!",
            data: result,
          });
          return;
        } catch(error) {
          console.log("Error in update lease agreement:", error);
          res.status(500).json({
            status: "error",
            error: error instanceof Error ? error.message : "An unknown error occurred.",
          });
          return;
        }
      }
    );
  }

  // ============================================================================
  // PREVIEW: EJS Preview (server-side render)
  // GET /preview-lease-agreement/:leaseID
  // ============================================================================

  private setupEjsPreview(): void {
    this.router.get("/preview-lease-agreement/:leaseID", async (req: Request<{leaseID: string}>, res: Response) => {
      try {
        const leaseID = this.mustString(req.params.leaseID, "Lease ID");
        const jsonPath = this.safeJoin(this.LEASE_UPLOAD_ROOT, leaseID, "data.json");
        if(!fs.existsSync(jsonPath)) throw new Error("Agreement data not found!");
        const fileContent = await fs.promises.readFile(jsonPath, "utf8");
        const JSON_DATA: LeasePayload = JSON.parse(fileContent);
        // Render the EJS file and pass JSON_DATA as "data"
        res.render("lease-agreement-pdf.ejs", {data: JSON_DATA});
        return;
      } catch(error) {
        console.log("Error in preview lease agreement:", error);
        res.status(500).json({status: "error", error: error instanceof Error ? error.message : "Unknown error"});
        return;
      }
    });
  }

  // ============================================================================
  // Puppeteer Browser (singleton-ish)
  // ============================================================================

  private async getBrowser(): Promise<puppeteer.Browser> {
    if(this.puppeteerBrowser && this.puppeteerBrowser.isConnected()) return this.puppeteerBrowser;

    const launchOptions: puppeteer.LaunchOptions = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    };

    // Resolve Chrome path cross-platform if available
    const getChromePath = (): string | undefined => {
      const platform = os.platform();
      if(platform === "win32") {
        const paths = [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ];
        return paths.find((p) => fs.existsSync(p));
      }
      if(platform === "darwin") {
        const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        return fs.existsSync(mac) ? mac : undefined;
      }
      if(platform === "linux") {
        const linux = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
        return linux.find((p) => fs.existsSync(p));
      }
      return undefined;
    };

    const chromePath = getChromePath();
    if(chromePath) launchOptions.executablePath = chromePath;

    this.puppeteerBrowser = await puppeteer.launch(launchOptions);
    return this.puppeteerBrowser;
  }

  // ============================================================================
  // Preload EJS templates + logo (memory cache)
  // ============================================================================

  private preloadTemplates(): void {
    try {
      const baseDir = path.join(__dirname, "../../public/view/leaseDocumentTemplates/");
      this.cachedTemplates = {
        header: fs.readFileSync(path.join(baseDir, "header.ejs"), "utf8"),
        footer: fs.readFileSync(path.join(baseDir, "footer.ejs"), "utf8"),
        main: fs.readFileSync(path.join(baseDir, "lease-agreement-pdf.ejs"), "utf8"),
        logoBase64: fs.readFileSync(path.join(__dirname, "../../public/companyData/images/PropEase.png")).toString("base64"),
      };
    } catch(e) {
      // If preload fails, leave empty; we render-time throw with a clearer error.
      console.error("[Templates] Preload failed:", e);
      this.cachedTemplates = {header: "", footer: "", main: "", logoBase64: ""};
    }
  }

  // ============================================================================
  // Generate Lease PDF (inline view or download)
  // GET /lease-agreement-pdf/:leaseID/:type/:generator   (type: 'download'|'view')
  // ============================================================================

  private generatePDFOfLeaseAgreement(): void {
    this.router.get("/lease-agreement-pdf/:leaseID/:type/:generator", async (req: Request, res: Response) => {
      try {
        const {leaseID, type, generator} = req.params;
        if(!leaseID || !type || !generator) throw new Error("Missing parameters");

        const jsonPath = this.safeJoin(this.LEASE_UPLOAD_ROOT, leaseID, "data.json");
        if(!fs.existsSync(jsonPath)) throw new Error("Lease data not found");

        const leaseData = JSON.parse(await fs.promises.readFile(jsonPath, "utf8"));

        // Attach map as data URL if location present
        if(leaseData.property?.location) {
          leaseData.property.location.embeddedUrl = await this.makeDinamicMAPURL(leaseData.property.location);
        }

        // Small date formatter for printable output
        const fmt = (d: string) => {
          const dt = new Date(d);
          const y = dt.getFullYear();
          const m = (dt.getMonth() + 1).toString().padStart(2, "0");
          const dd = dt.getDate().toString().padStart(2, "0");
          return `${y}/${m}/${dd}`;
        };

        leaseData.tenantInformation.dateOfBirth = fmt(leaseData.tenantInformation.dateOfBirth);
        leaseData.leaseAgreement.startDate = fmt(leaseData.leaseAgreement.startDate);
        leaseData.leaseAgreement.endDate = fmt(leaseData.leaseAgreement.endDate);
        leaseData.signatures.signedAt = fmt(leaseData.signatures.signedAt);
        leaseData.systemMetadata.lastUpdated = fmt(new Date(leaseData.systemMetadata.lastUpdated).toISOString());

        if(!this.cachedTemplates.main || !this.cachedTemplates.header || !this.cachedTemplates.footer) {
          throw new Error("Templates not loaded. Check template paths and preload.");
        }

        const html = await ejs.render(this.cachedTemplates.main, {data: leaseData});
        const header = await ejs.render(this.cachedTemplates.header, {
          logoSrc: `data:image/png;base64,${this.cachedTemplates.logoBase64}`,
          companyName: "PropEase Real Estate",
        });
        const footer = await ejs.render(this.cachedTemplates.footer, {
          qrCodeSrc: await this.generateQRCode(leaseID),
        });

        const browser = await this.getBrowser();
        const page = await browser.newPage();
        await page.setContent(html, {waitUntil: "networkidle0"});
        await page.emulateMediaType("screen");

        const pdfBuffer = await page.pdf({
          format: "A4",
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: header,
          footerTemplate: footer,
          margin: {top: "150px", bottom: "150px"},
          preferCSSPageSize: true,
        });

        await page.close();

        // Notify download/view
        const notificationService = new NotificationService();
        const io = req.app.get("io") as import("socket.io").Server;
        await notificationService.createNotification(
          {
            title: "Lease Agreement Download",
            body: `Lease agreement PDF has been generated successfully with ID: ${leaseID}.`,
            type: "download",
            severity: "info",
            audience: {mode: "role", usernames: [leaseData.tenantInformation.tenantUsername], roles: ["admin", "operator"]},
            channels: ["inapp", "email"],
            metadata: {
              lease: leaseData,
              generatedAt: new Date().toISOString(),
              generatedBy: generator,
              ipAddress: req.ip,
              userAgent: req.headers["user-agent"],
            },
          },
          (rooms, payload) => rooms.forEach((room) => io.to(room).emit("notification.new", payload))
        );

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          type === "download" ? `attachment; filename=${leaseID}-agreement.pdf` : `inline; filename=${leaseID}-agreement.pdf`
        );
        res.send(pdfBuffer);
        return;
      } catch(error) {
        console.error("Error generating PDF:", error);
        res.status(500).json({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    });
  }

  // ============================================================================
  // Utilities used by PDF
  // ============================================================================

  /** Generate a base64 PNG QR code from input text. */
  private async generateQRCode(data: string): Promise<string> {
    try {
      return await QRCode.toDataURL(data, {
        errorCorrectionLevel: "H",
        type: "image/png",
        margin: 2,
        width: 512,
        color: {dark: "#000000", light: "#ffffff"},
      });
    } catch(error) {
      console.error("QR code generation failed:", error);
      return "";
    }
  }

  /** Build a Static Maps image (base64) for PDFs. Falls back to embeddedUrl string. */
  private async makeDinamicMAPURL(input: any): Promise<string> {
    try {
      const APIkey = process.env.GOOGLE_API_KEY;
      const {lat, lng, embeddedUrl} = input;
      const staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=14&size=800x300&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${APIkey}`;
      const response = await axios.get(staticMapUrl, {responseType: "arraybuffer", timeout: 15_000});
      if(response.status === 200) {
        return `data:image/png;base64,${Buffer.from(response.data).toString("base64")}`;
      }
      return embeddedUrl || "";
    } catch(error) {
      console.error("Error generating map URL:", error);
      return "";
    }
  }

  // ============================================================================
  // GET: Lease by leaseID
  // GET /lease-agreement/:leaseID
  // ============================================================================

  private getLeaseAgreementsByLeaseID(): void {
    this.router.get("/lease-agreement/:leaseID", async (req: Request<{leaseID: string}>, res: Response) => {
      try {
        const leaseID = this.mustString(req.params.leaseID, "Lease ID");
        const data = await LeaseModel.findOne({leaseID}).lean();
        if(!data) {
          res.status(404).json({status: "error", message: `No lease agreements found for this lease ID (${leaseID}).`});
          return;
        }
        res.status(200).json({status: "success", message: "Lease agreements retrieved successfully!", data});
        return;
      } catch(error) {
        console.log("Error in get lease by id:", error);
        res.status(500).json({status: "error", error: error instanceof Error ? error.message : "Unknown error"});
        return;
      }
    });
  }

  // ============================================================================
  // GET: All leases by username
  // GET /lease-agreements/:username
  // ============================================================================

  private getAllLeaseAgreementsByUsername(): void {
    this.router.get("/lease-agreements/:username", async (req: Request<{username: string}>, res: Response) => {
      try {
        const safeUsername = this.sanitizeIdentifier(req.params.username);
        if(!safeUsername) throw new Error("Username is required!");

        const leaseAgreements = await LeaseModel.find({
          "tenantInformation.tenantUsername": safeUsername,
        })
          .sort({"systemMetadata.lastUpdated": -1})
          .lean();

        if(!leaseAgreements || leaseAgreements.length === 0) {
          res.status(404).json({status: "error", message: "No lease agreements found for this user."});
          return;
        }

        res.status(200).json({
          status: "success",
          message: "Lease agreements retrieved successfully!",
          data: leaseAgreements,
        });
        return;
      } catch(error) {
        console.log("Error in get all lease agreements:", error);
        res.status(500).json({
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return;
      }
    });
  }

  // ============================================================================
  // PUT: Update validation status of a lease (by leaseID)
  // PUT /lease-status-updated/:leaseID
  // ============================================================================

  private getLeaseAgreementByIDAndUpdateValidationStatus(): void {
    const upload = multer(); // for parsing form-data without files
    this.router.put("/lease-status-updated/:leaseID", upload.none(), async (req: Request<{leaseID: string}>, res: Response) => {
      try {
        const safeLeaseID = this.mustString(req.params.leaseID, "Lease ID");
        const validationStatus = this.mustString(req.body.validationStatus, "Validation status");

        if(!this.checkIsString(validationStatus)) throw new Error("Validation should be string!");

        const lastUpdated = new Date().toISOString();

        const leaseAgreement = await LeaseModel.findOneAndUpdate(
          {leaseID: safeLeaseID},
          {"systemMetadata.validationStatus": validationStatus, "systemMetadata.lastUpdated": lastUpdated},
          {new: true}
        ).lean();

        if(!leaseAgreement) {
          res.status(404).json({status: "error", message: "No lease agreement found for this lease ID."});
          return;
        }

        res.status(200).json({
          status: "success",
          message: "Lease agreement has been updated successfully!",
          data: leaseAgreement,
        });
        return;
      } catch(error) {
        console.log("Error in update lease validation status:", error);
        res.status(500).json({status: "error", error: error instanceof Error ? error.message : "Unknown error"});
        return;
      }
    });
  }

  // ============================================================================
  // GET: All leases (with simple pagination)
  // GET /all-leases?page=&limit=
  // ============================================================================

  private getAllLeases(): void {
    this.router.get("/all-leases", async (req: Request, res: Response) => {
      try {
        const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
        const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "20", 10), 1), 100);
        const skip = (page - 1) * limit;

        const [data, total] = await Promise.all([
          LeaseModel.find().skip(skip).limit(limit).lean(),
          LeaseModel.countDocuments(),
        ]);

        res.status(200).json({
          status: "success",
          message: "All leases retrieved successfully!",
          page,
          limit,
          total,
          data,
        });
        return;
      } catch(error) {
        console.log(error);
        res.status(500).json({status: "error", error: "An unknown error occurred: " + error});
        return;
      }
    });
  }

  // ============================================================================
  // GET: User by username
  // GET /get-tenant-by-username/:username
  // ============================================================================

  private getTenantByUsername(): void {
    this.router.get("/get-tenant-by-username/:username", async (req: Request<{username: string}>, res: Response) => {
      try {
        const safeUsername = this.sanitizeIdentifier(req.params.username);
        if(!safeUsername) throw new Error("Username is required!");
        const user = await UserModel.findOne({username: safeUsername}).lean();
        if(!user) {
          res.status(404).json({status: "error", message: "User not found!"});
          return;
        }
        res.status(200).json({status: "success", message: "User retrieved successfully!", data: user});
        return;
      } catch(error) {
        console.log(error);
        res.status(500).json({status: "error", error: "An unknown error occurred: " + (error as any)});
        return;
      }
    });
  }

  // ============================================================================
  // Type checks (kept from your original, lightly adjusted)
  // ============================================================================

  private checkSystemMetaDataFormat(input: any): input is SystemMetadata {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      typeof data.ocrAutoFillStatus === "boolean" &&
      typeof data.validationStatus === "string" &&
      typeof data.language === "string" &&
      typeof data.leaseTemplateVersion === "string" &&
      typeof data.lastUpdated === "string"
    );
  }

  private checkRentDueDateFormat(input: any): input is RentDueDate {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return typeof data.id === "string" && typeof data.label === "string";
  }

  private checkAddedBy(input: any): input is AddedBy {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      typeof data.username === "string" &&
      typeof data.name === "string" &&
      typeof data.email === "string" &&
      typeof data.role === "string" &&
      (typeof data.addedAt === "string" || data.addedAt instanceof Date)
    );
  }

  private checkIsString(input: any): input is string {
    return typeof input === "string" && input.trim().length > 0;
  }

  private checkRuleAndRegulationsFormat(input: any): input is RulesAndRegulations[] {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!Array.isArray(data)) return false;
    return data.every((item) => item && typeof item.rule === "string" && typeof item.description === "string");
  }

  private checkNoticePeriodDaysFormat(input: any): input is NoticePeriod {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return typeof data.id === "string" && typeof data.label === "string" && typeof data.days === "number" && typeof data.description === "string";
  }

  private checkUtilityResponsibilitiesFormat(input: any): input is UtilityResponsibility[] {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!Array.isArray(data)) return false;
    return data.every(
      (item) => item && typeof item.id === "string" && typeof item.utility === "string" && typeof item.paidBy === "string" && typeof item.description === "string"
    );
  }

  private checkLatePaymentPenaltiesFormat(input: any): input is LatePaymentPenalty[] {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!Array.isArray(data)) return false;
    return data.every(
      (item) => item && typeof item.label === "string" && typeof item.type === "string" && typeof item.value === "number" && typeof item.description === "string"
    );
  }

  private checkSecurityDepositFormat(input: any): input is SecurityDeposit {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return typeof data.id === "string" && typeof data.name === "string" && typeof data.description === "string" && typeof data.refundable === "boolean";
  }

  private checkPaymentMethodFormat(input: any): input is PaymentMethod {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return typeof data.id === "string" && typeof data.name === "string" && typeof data.category === "string";
  }

  private checkPaymentFrequencyFormat(input: any): input is PaymentFrequency {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return typeof data.id === "string" && typeof data.name === "string" && typeof data.duration === "string" && typeof data.unit === "string";
  }

  private checkCurrencyFormat(input: any): input is CurrencyFormat {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      typeof data.country === "string" &&
      typeof (data as any).symbol === "string" && // your schema allows string
      typeof data.flags === "object" &&
      typeof data.flags.png === "string" &&
      typeof data.flags.svg === "string" &&
      typeof data.currency === "string"
    );
  }

  private checkISODate(input: any): boolean {
    if(typeof input !== "string") return false;
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}:\d{2}(.\d+)?(Z|([+-]\d{2}:\d{2})))?$/;
    return isoDateRegex.test(input) && !isNaN(Date.parse(input));
  }

  private checkIsPhoneCodeDetails(input: any): boolean {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return typeof data.name === "string" && typeof data.code === "string" && typeof data.flags === "object" && typeof data.flags.png === "string" && typeof data.flags.svg === "string";
  }

  private checkIsEmergencyContact(input: any): input is EmergencyContact {
    try {
      const data = typeof input === "string" ? JSON.parse(input) : input;
      if(!data || typeof data !== "object") return false;
      return typeof data.name === "string" && typeof data.relationship === "string" && typeof data.contact === "string";
    } catch {
      return false;
    }
  }

  private isValidTenantAddress(input: any): input is Address {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
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
