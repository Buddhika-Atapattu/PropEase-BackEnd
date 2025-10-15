import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import multer from "multer";
import sharp from "sharp";
import mime from "mime-types";
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
  TenantScannedFilesDataJSON,
  LeasePayload,
  LeasePayloadWithProperty,
} from "../models/lease.model";
import {CryptoService} from "../services/crypto.service";
import * as puppeteer from "puppeteer";
import ejs from "ejs";
import {Property} from "../models/property.model";
import QRCode from 'qrcode';
import axios, {HttpStatusCode} from 'axios';
import * as os from 'os';
import {UserModel} from "../models/user.model";
import NotificationService from '../services/notification.service';



dotenv.config();

export default class Lease {
  private router: Router;
  private cryptoService: CryptoService = new CryptoService();
  private newLeaseAgreement: LeasePayload | null = null;
  private puppeteerBrowser: puppeteer.Browser | null = null;
  private cachedTemplates: {
    header: string;
    footer: string;
    main: string;
    logoBase64: string;
  } = {
      header: "",
      footer: "",
      main: "",
      logoBase64: "",
    };

  constructor () {
    this.router = express.Router();
    this.cachedTemplates = {
      header: '',
      footer: '',
      main: '',
      logoBase64: ''
    };
    this.registerLeaseAgreement();
    this.updateLeaseAgreement();
    this.setupEjsPreview();
    this.generatePDFOfLeaseAgreement();
    this.getAllLeaseAgreementsByUsername();
    this.getLeaseAgreementsByLeaseID();
    this.getLeaseAgreementByIDAndUpdateValidationStatus();
    this.getBrowser();
    this.preloadTemplates();
    this.getTenantByUsername();
    this.getAllLeases()
  }

  get route(): Router {
    return this.router;
  }
  //********************************************************** ROUTERS *******************************************************************/

  //<============================================== REGISTER LEASE AGREEMENT ==============================================>
  private registerLeaseAgreement() {
    // Allowed MIME types for uploads
    const allowedTypes = [
      // Word / Office
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/rtf",

      // Excel
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "text/csv",
      "text/tab-separated-values",

      // PowerPoint
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.template",

      // OpenDocument
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",

      // PDF / Text
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
    ];

    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const leaseID = req.params.leaseID;
        if(!leaseID) return cb(new Error("Lease ID is required in the URL path."), "");

        let uploadPath = "";
        switch(file.fieldname) {
          case "tenantScanedDocuments":
            uploadPath = path.join(__dirname, `../../public/lease/${leaseID}/documents/`);
            break;
          case "tenantSignature":
            uploadPath = path.join(__dirname, `../../public/lease/${leaseID}/signatures/tenant/`);
            break;
          case "landlordSignature":
            uploadPath = path.join(__dirname, `../../public/lease/${leaseID}/signatures/landlord/`);
            break;
          default:
            return cb(new Error("Unexpected field: " + file.fieldname), "");
        }
        fs.mkdirSync(uploadPath, {recursive: true});
        cb(null, uploadPath);
      },
      filename: (_req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const sanitized = file.originalname.replace(/\s+/g, "_");
        cb(null, `${uniqueSuffix}-${sanitized}`);
      },
    });

    const fileFilter = (_req: Request, file: Express.Multer.File, cb: any) => {
      const isAllowed = allowedTypes.includes(file.mimetype);
      if(
        (file.fieldname === "tenantScanedDocuments" ||
          file.fieldname === "tenantSignature" ||
          file.fieldname === "landlordSignature") &&
        isAllowed
      ) {
        cb(null, true);
      } else {
        cb(new Error(`File type not allowed: ${file.mimetype}`));
      }
    };

    const upload = multer({storage, fileFilter});

    this.router.post(
      "/register/:leaseID",
      upload.fields([
        {name: "tenantScanedDocuments", maxCount: 50},
        {name: "tenantSignature", maxCount: 1},
        {name: "landlordSignature", maxCount: 1},
      ]),
      async (req: Request<{leaseID: string}>, res: Response) => {
        try {
          // --------------------------- basic helpers ----------------------------
          const mustString = (v: unknown, name: string) => {
            if(typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
            return v.trim();
          };
          const mustISODate = (v: unknown, name: string): string => {
            const s = mustString(v, name);
            if(!this.checkISODate(s)) throw new Error(`${name} must be ISO date (YYYY-MM-DD).`);
            return s;
          };
          const mustJSON = <T = any>(v: unknown, name: string): T => {
            const s = mustString(v, name);
            try {
              return JSON.parse(s) as T;
            } catch {
              throw new Error(`${name} must be valid JSON.`);
            }
          };
          const toInt10 = (v: unknown, name: string): number => {
            const s = mustString(v, name);
            const n = parseInt(s, 10);
            if(!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
            return n;
          };
          const ensureFileSig = (obj: any): obj is FILE =>
            obj &&
            typeof obj.fieldname === "string" &&
            typeof obj.originalname === "string" &&
            typeof obj.mimetype === "string" &&
            typeof obj.size === "number" &&
            typeof obj.filename === "string" &&
            typeof obj.URL === "string";

          // --------------------------- files map -------------------------------
          const files = req.files as {[fieldname: string]: Express.Multer.File[]} | undefined;

          // --------------------------- lease id --------------------------------
          const leaseID = mustString(req.params.leaseID || req.body.leaseID, "Lease ID");

          // --------------------------- tenant info -----------------------------
          const tenantUsername: TenantInformation["tenantUsername"] = mustString(
            req.body.tenantUsername,
            "Tenant ID"
          );
          const tenantFullName: TenantInformation["fullName"] = mustString(
            req.body.tenantFullName,
            "Tenant Full Name"
          );
          const tenantEmail: TenantInformation["email"] = mustString(
            req.body.tenantEmail,
            "Tenant Email"
          );
          const tenantNationality: TenantInformation["nationality"] = mustString(
            req.body.tenantNationality,
            "Tenant Nationality"
          );
          const tenantDateOfBirthStr = mustISODate(req.body.tenantDateOfBirth, "Tenant date of birth");
          const tenantDateOfBirth = new Date(tenantDateOfBirthStr);
          if(Number.isNaN(tenantDateOfBirth.getTime()))
            throw new Error("Tenant date of birth is not a valid date");

          if(!this.checkIsPhoneCodeDetails(mustString(req.body.tenantPhoneCodeDetails, "Tenant phone code")))
            throw new Error("Invalid tenant phone code details");
          const tenantPhoneCodeDetails: CountryCodes = mustJSON(req.body.tenantPhoneCodeDetails, "Tenant phone code");

          const tenantPhoneNumber: TenantInformation["phoneNumber"] = mustString(
            req.body.tenantPhoneNumber,
            "Tenant Phone Number"
          );
          const tenantGender: TenantInformation["gender"] = mustString(req.body.tenantGender, "Tenant Gender");
          const tenantNICOrPassport: TenantInformation["nicOrPassport"] = mustString(
            req.body.tenantNICOrPassport,
            "Tenant NIC OR Passport"
          );

          if(!this.isValidTenantAddress(mustString(req.body.tenantAddress, "Tenant Address")))
            throw new Error("Invalid tenant address object");
          const tenantAddress: Address = mustJSON(req.body.tenantAddress, "Tenant Address");

          if(!this.checkIsEmergencyContact(req.body.emergencyContact))
            throw new Error("Invalid tenant emergency contact object");
          const tenantEmergencyContact: EmergencyContact = mustJSON(req.body.emergencyContact, "Emergency Contact");

          // --------------------------- co-tenant (optional) --------------------
          // NOTE: do not build coTenant if nothing meaningful was provided.
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
            !!(coTenantFullname || coTenantEmail || coTenantPhoneCodeId || coTenantPhoneNumber || coTenantGender || coTenantNicOrPassport || coTenantAgeStr || coTenantRelationship);

          if(anyCoTenantFieldProvided) {
            // If you want stricter validation, enforce required fields here.
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
          // IMPORTANT: we will only include `coTenant` in the payload if INSERT_DATA_coTenant is defined.

          // --------------------------- property -------------------------------
          const selectedProperty: Property = mustJSON(req.body.selectedProperty, "Selected Property");

          // --------------------------- lease agreement -------------------------
          const startDate: LeaseAgreement["startDate"] = mustISODate(req.body.startDate, "Agreement starting date");
          const endDate: LeaseAgreement["endDate"] = mustISODate(req.body.endDate, "Agreement ending date");
          const durationMonths: LeaseAgreement["durationMonths"] = toInt10(
            req.body.durationMonths,
            "Agreement duration in months"
          );
          const monthlyRent: LeaseAgreement["monthlyRent"] = toInt10(
            req.body.monthlyRent,
            "Agreement monthly rent"
          );

          if(!this.checkCurrencyFormat(mustString(req.body.currency, "Currency"))) throw new Error("Invalid currency");
          const currency: LeaseAgreement["currency"] = mustJSON(req.body.currency, "Currency");

          if(!this.checkPaymentFrequencyFormat(mustString(req.body.paymentFrequency, "Payment frequency")))
            throw new Error("Invalid payment frequency");
          const paymentFrequency: LeaseAgreement["paymentFrequency"] =
            mustJSON(req.body.paymentFrequency, "Payment frequency");

          if(!this.checkPaymentMethodFormat(mustString(req.body.paymentMethod, "Payment method")))
            throw new Error("Invalid payment method");
          const paymentMethod: LeaseAgreement["paymentMethod"] = mustJSON(req.body.paymentMethod, "Payment method");

          if(!this.checkSecurityDepositFormat(mustString(req.body.securityDeposit, "Security deposit")))
            throw new Error("Invalid security deposit");
          const securityDeposit: LeaseAgreement["securityDeposit"] =
            mustJSON(req.body.securityDeposit, "Security deposit");

          if(!this.checkRentDueDateFormat(mustString(req.body.rentDueDate, "Rent due date")))
            throw new Error("Invalid rent due date");
          const rentDueDate: LeaseAgreement["rentDueDate"] = mustJSON(req.body.rentDueDate, "Rent due date");

          if(
            !this.checkLatePaymentPenaltiesFormat(
              mustString(req.body.selectedLatePaymentPenalties, "Late payment penalties")
            )
          )
            throw new Error("Invalid late payment penalties");
          const selectedLatePaymentPenalties: LeaseAgreement["latePaymentPenalties"] = mustJSON(
            req.body.selectedLatePaymentPenalties,
            "Late payment penalties"
          );

          if(
            !this.checkUtilityResponsibilitiesFormat(
              mustString(req.body.selectedUtilityResponsibilities, "Utility responsibilities")
            )
          )
            throw new Error("Invalid utility responsibilities");
          const selectedUtilityResponsibilities: LeaseAgreement["utilityResponsibilities"] = mustJSON(
            req.body.selectedUtilityResponsibilities,
            "Utility responsibilities"
          );

          if(!this.checkNoticePeriodDaysFormat(mustString(req.body.noticePeriodDays, "Notice period days")))
            throw new Error("Invalid notice period days");
          const noticePeriodDays: LeaseAgreement["noticePeriodDays"] = mustJSON(
            req.body.noticePeriodDays,
            "Notice period days"
          );

          if(!this.checkRuleAndRegulationsFormat(mustString(req.body.selectedRuleAndRegulations, "Rules & regs")))
            throw new Error("Invalid rule and regulations format");
          const selectedRuleAndRegulations: RulesAndRegulations[] = mustJSON(
            req.body.selectedRuleAndRegulations,
            "Rules & regs"
          );

          const isReadTheCompanyPolicy: LeaseType["isReadTheCompanyPolicy"] = this.checkBoolean(
            mustString(req.body.isReadTheCompanyPolicy, "Company policy confirmation")
          );

          const signedAtStr = mustISODate(req.body.signedAt, "Agreement signed at date");
          const signedAt = new Date(signedAtStr);

          const ipAddress: string =
            (req.headers["x-forwarded-for"] as string | undefined) ?? req.socket.remoteAddress ?? "Unknown IP";

          // --------------------------- organize scanned docs -------------------
          const host = req.get("host");
          const protocol = req.protocol;
          const baseUrl = `${protocol}://${host}`;

          const scannedDocumentPath = path.join(__dirname, `../../public/lease/${leaseID}/documents/`);
          const mobileScannedFolderPath = path.join(__dirname, `../../public/tenants/scanned-files/${tenantUsername}/`);

          const tenantUploadedScanedDocumentsRemoved: ScannedFileRecordJSON[] = mustJSON(
            req.body.tenantUploadedScanedDocumentsRemoved,
            "Removed scanned docs"
          );

          const JSON_PATH = path.join(__dirname, "../../public/tenants/scanned-files/tenantScannedFilesData.json");
          if(fs.existsSync(JSON_PATH)) {
            const fileContent = await fs.promises.readFile(JSON_PATH, "utf8");
            const JSON_DATA: TenantScannedFilesDataJSON = JSON.parse(fileContent);
            const tenantJSONData = JSON_DATA[tenantUsername];

            if(Array.isArray(tenantJSONData)) {
              const updatedTenantJSONData = tenantJSONData.filter(
                (data) => !tenantUploadedScanedDocumentsRemoved.some((item) => item.token === data.token)
              );
              JSON_DATA[tenantUsername] = updatedTenantJSONData;
              await fs.promises.writeFile(JSON_PATH, JSON.stringify(JSON_DATA, null, 2));
            } else {
              console.warn(`No JSON data found for tenant: ${tenantUsername}`);
            }
          } else {
            console.warn(`[WARN] No JSON data found for tenant '${tenantUsername}' at ${JSON_PATH}`);
          }

          const tenantUploadedScanedDocuments: ScannedFileRecordJSON[] = mustJSON(
            req.body.tenantUploadedScanedDocuments,
            "Tenant uploaded scanned docs"
          );

          // Move mobile-uploaded scans to lease folder
          tenantUploadedScanedDocuments.forEach((item) => {
            const files = item.files;
            item.folder = scannedDocumentPath;
            files.forEach((doc) => {
              const filename = doc.file.filename;
              const sourcePath = path.join(mobileScannedFolderPath, filename);
              if(fs.existsSync(sourcePath)) {
                const destinationPath = path.join(scannedDocumentPath, filename);
                doc.file.URL = `${baseUrl}/lease/${leaseID}/documents/${filename}`;
                doc.folder = scannedDocumentPath;
                fs.renameSync(sourcePath, destinationPath);
              }
            });
          });

          const scannedDocuments: ScannedFileRecordJSON[] = [];
          if(Array.isArray(tenantUploadedScanedDocuments) && tenantUploadedScanedDocuments.length > 0) {
            scannedDocuments.push(...tenantUploadedScanedDocuments);
          }

          // Create a token for new uploaded docs
          const payload = {tenant: tenantUsername, issuedAt: Date.now()};
          const token = await this.cryptoService.encrypt(payload);

          const tenantScanedDocuments = files?.["tenantScanedDocuments"];
          const newScannedFileRecord: ScannedFileRecordJSON = {
            date: new Date().toISOString(),
            tenant: tenantUsername,
            token: token,
            files: [],
            folder: scannedDocumentPath,
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
                  URL: `${baseUrl}/lease/${leaseID}/documents/${doc.filename}`,
                },
              };
              newScannedFileRecord.files.push(data);
            });
          }

          if(newScannedFileRecord.files.length > 0) {
            scannedDocuments.push(newScannedFileRecord);
          }

          if(!scannedDocuments.length) {
            throw new Error(
              "No scanned identification document found. Please upload at least one document before submitting."
            );
          }

          // --------------------------- signatures ------------------------------
          const tenantSignature = files?.["tenantSignature"]?.[0];
          const tenantOldSignature = req.body.tenantOldSignature;
          let fallbackTenantSignature: FILE | undefined;
          if(!tenantSignature) {
            if(!ensureFileSig(tenantOldSignature)) throw new Error("Tenant signature is required!");
            fallbackTenantSignature = tenantOldSignature;
          }
          const organizedTenantSignature: FILE = {
            fieldname: tenantSignature?.fieldname ?? fallbackTenantSignature?.fieldname ?? "",
            originalname: tenantSignature?.originalname ?? fallbackTenantSignature?.originalname ?? "",
            mimetype: tenantSignature?.mimetype ?? fallbackTenantSignature?.mimetype ?? "",
            size: tenantSignature?.size ?? fallbackTenantSignature?.size ?? 0,
            filename: tenantSignature?.filename ?? fallbackTenantSignature?.filename ?? "",
            URL: tenantSignature
              ? `${baseUrl}/lease/${leaseID}/signatures/tenant/${tenantSignature.filename}`
              : fallbackTenantSignature?.URL ?? "",
          };

          const landlordSignature = files?.["landlordSignature"]?.[0];
          const landlordOldSignature = req.body.landlordOldSignature;
          let fallbackLandlordSignature: FILE | undefined;
          if(!landlordSignature) {
            if(!ensureFileSig(landlordOldSignature)) throw new Error("Landlord signature is required!");
            fallbackLandlordSignature = landlordOldSignature;
          }
          const organizedLandlordSignature: FILE = {
            fieldname: landlordSignature?.fieldname ?? fallbackLandlordSignature?.fieldname ?? "",
            originalname: landlordSignature?.originalname ?? fallbackLandlordSignature?.originalname ?? "",
            mimetype: landlordSignature?.mimetype ?? fallbackLandlordSignature?.mimetype ?? "",
            size: landlordSignature?.size ?? fallbackLandlordSignature?.size ?? 0,
            filename: landlordSignature?.filename ?? fallbackLandlordSignature?.filename ?? "",
            URL: landlordSignature
              ? `${baseUrl}/lease/${leaseID}/signatures/landlord/${landlordSignature.filename}`
              : fallbackLandlordSignature?.URL ?? "",
          };

          // --------------------------- assemble sub-docs -----------------------
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
            userAgent: mustJSON(req.body.userAgent, "User agent"),
          };

          if(!this.checkSystemMetaDataFormat(mustString(req.body.systemMetaData, "System metadata")))
            throw new Error("Invalid system metadata");
          const systemMetaData: SystemMetadata = mustJSON(req.body.systemMetaData, "System metadata");

          // --------------------------- parent payloads -------------------------
          // IMPORTANT: coTenant is added only if defined — this is what fixes your TS error.
          const INSERT_DATA: LeasePayload = {
            leaseID,
            tenantInformation: INSERT_DATA_TenantInformation,
            ...(INSERT_DATA_coTenant ? {coTenant: INSERT_DATA_coTenant} : {}),
            propertyID: selectedProperty.id,
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

          // --------------------------- save JSON (for pdf) ---------------------
          const LEASE_JSON_PATH = path.join(
            __dirname,
            `../../public/lease/${leaseID}/agreement-data/${leaseID}.json`
          );
          await fs.promises.mkdir(path.dirname(LEASE_JSON_PATH), {recursive: true});
          await fs.promises.writeFile(LEASE_JSON_PATH, JSON.stringify(INSERT_DOCUMENT_DATA, null, 2));

          // --------------------------- persist in DB ---------------------------
          const INSERT = new LeaseModel(INSERT_DATA);
          await INSERT.save();

          if(INSERT) {
            // Notify: tenant (user) + admins/operators (roles).
            const notificationService = new NotificationService();
            const io = req.app.get("io") as import("socket.io").Server;

            await notificationService.createNotification(
              {
                title: "New Lease",
                body: `New lease agreement has been created with ID: ${leaseID}. Please review and validate the agreement.`,
                type: "create",
                severity: "info",
                audience: {mode: "role", usernames: [tenantUsername], roles: ["admin", "operator", 'manager']},
                channels: ["inapp", "email"],
                metadata: {
                  tenantUsername,
                  newLeaseData: INSERT_DOCUMENT_DATA,
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
          } else {
            res.status(501).json({
              status: "error",
              message: "Agreement creation failed. Please try again later or contact support.",
            });
          }
        } catch(error) {
          console.log("Error in register lease agreement:", error);
          if(error instanceof Error) {
            res.status(500).json({status: "error", error: error.message});
          } else {
            res.status(500).json({status: "error", error: "An unknown error occurred." + error});
          }
        }
      }
    );
  }
  //<============================================== END REGISTER LEASE AGREEMENT ==============================================>
  //<============================================== UPDATE THE LEASE AGREEMENT ==============================================>
  private updateLeaseAgreement() {
    // Allowed MIME types
    const allowedTypes = [
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
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/bmp",
      "image/tiff",
      "image/webp",
      "image/svg+xml",
      "image/ico",
    ];

    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const leaseID = req.params.leaseID;
        if(!leaseID) return cb(new Error("Lease ID is required in the URL path."), "");

        let uploadPath = "";
        switch(file.fieldname) {
          case "tenantScanedDocuments":
            uploadPath = path.join(__dirname, `../../public/lease/${leaseID}/documents/`);
            break;
          case "tenantSignature":
            uploadPath = path.join(__dirname, `../../public/lease/${leaseID}/signatures/tenant/`);
            break;
          case "landlordSignature":
            uploadPath = path.join(__dirname, `../../public/lease/${leaseID}/signatures/landlord/`);
            break;
          default:
            return cb(new Error("Unexpected field: " + file.fieldname), "");
        }
        fs.mkdirSync(uploadPath, {recursive: true});
        cb(null, uploadPath);
      },
      filename: (_req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const sanitized = file.originalname.replace(/\s+/g, "_");
        cb(null, `${uniqueSuffix}-${sanitized}`);
      },
    });

    const fileFilter = (_req: Request, file: Express.Multer.File, cb: any) => {
      const isAllowed = allowedTypes.includes(file.mimetype);
      if(
        (file.fieldname === "tenantScanedDocuments" ||
          file.fieldname === "tenantSignature" ||
          file.fieldname === "landlordSignature") &&
        isAllowed
      ) {
        cb(null, true);
      } else {
        cb(new Error(`File type not allowed: ${file.mimetype}`));
      }
    };

    const upload = multer({storage, fileFilter});

    // ---------- small helpers (strict-safe parsing) ----------
    const mustString = (v: unknown, name: string): string => {
      if(typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
      return v.trim();
    };
    const mustISODate = (v: unknown, name: string): string => {
      const s = mustString(v, name);
      if(!this.checkISODate(s)) throw new Error(`${name} must be ISO date (YYYY-MM-DD).`);
      return s;
    };
    const mustJSON = <T = any>(v: unknown, name: string): T => {
      const s = mustString(v, name);
      try {
        return JSON.parse(s) as T;
      } catch {
        throw new Error(`${name} must be valid JSON.`);
      }
    };
    const toInt10 = (v: unknown, name: string): number => {
      const s = mustString(v, name);
      const n = parseInt(s, 10);
      if(!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
      return n;
    };
    const ensureFileSig = (obj: any): obj is FILE =>
      obj &&
      typeof obj.fieldname === "string" &&
      typeof obj.originalname === "string" &&
      typeof obj.mimetype === "string" &&
      typeof obj.size === "number" &&
      typeof obj.filename === "string" &&
      typeof obj.URL === "string";

    this.router.put(
      "/update-lease-agreement/:leaseID",
      upload.fields([
        {name: "tenantScanedDocuments", maxCount: 50},
        {name: "tenantSignature", maxCount: 1},
        {name: "landlordSignature", maxCount: 1},
      ]),
      async (req: Request<{leaseID: string}>, res: Response) => {
        try {
          const files = req.files as {[fieldname: string]: Express.Multer.File[]} | undefined;

          // Lease ID
          const leaseID = mustString(req.params.leaseID || req.body.leaseID, "Lease ID");
          const leaseAgreementDB = await LeaseModel.findOne({leaseID});
          if(!leaseAgreementDB) throw new Error("Lease agreement not found!");

          // Tenant
          const tenantUsername: TenantInformation["tenantUsername"] = mustString(
            req.body.tenantUsername,
            "Tenant ID"
          );
          const tenantFullName: TenantInformation["fullName"] = mustString(
            req.body.tenantFullName,
            "Tenant Full Name"
          );
          const tenantEmail: TenantInformation["email"] = mustString(req.body.tenantEmail, "Tenant Email");
          const tenantNationality: TenantInformation["nationality"] = mustString(
            req.body.tenantNationality,
            "Tenant Nationality"
          );
          const tenantDOBStr = mustISODate(req.body.tenantDateOfBirth, "Tenant date of birth");
          const tenantDateOfBirth = new Date(tenantDOBStr);
          if(Number.isNaN(tenantDateOfBirth.getTime()))
            throw new Error("Tenant date of birth is not a valid date.");

          if(!this.checkIsPhoneCodeDetails(mustString(req.body.tenantPhoneCodeDetails, "Tenant phone code")))
            throw new Error("Invalid tenant phone code details.");
          const tenantPhoneCodeDetails: CountryCodes = mustJSON(
            req.body.tenantPhoneCodeDetails,
            "Tenant phone code"
          );

          const tenantPhoneNumber: TenantInformation["phoneNumber"] = mustString(
            req.body.tenantPhoneNumber,
            "Tenant Phone Number"
          );
          const tenantGender: TenantInformation["gender"] = mustString(req.body.tenantGender, "Tenant Gender");
          const tenantNICOrPassport: TenantInformation["nicOrPassport"] = mustString(
            req.body.tenantNICOrPassport,
            "Tenant NIC OR Passport"
          );

          if(!this.isValidTenantAddress(mustString(req.body.tenantAddress, "Tenant Address")))
            throw new Error(
              "Invalid tenant address: expected an address with houseNumber, street, city, stateOrProvince, postalCode, and country."
            );
          const tenantAddress: Address = mustJSON(req.body.tenantAddress, "Tenant Address");

          if(!this.checkIsEmergencyContact(req.body.emergencyContact))
            throw new Error("Invalid tenant emergency contact.");
          const tenantEmergencyContact: EmergencyContact = mustJSON(
            req.body.emergencyContact,
            "Emergency Contact"
          );

          // Co-tenant (optional) — only include when provided
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

          // Property
          const selectedProperty: Property = mustJSON(req.body.selectedProperty, "Selected Property");

          // Lease agreement values
          const startDate: LeaseAgreement["startDate"] = mustISODate(
            req.body.startDate,
            "Agreement starting date"
          );
          const endDate: LeaseAgreement["endDate"] = mustISODate(req.body.endDate, "Agreement ending date");
          const durationMonths: LeaseAgreement["durationMonths"] = toInt10(
            req.body.durationMonths,
            "Agreement duration in months"
          );
          const monthlyRent: LeaseAgreement["monthlyRent"] = toInt10(
            req.body.monthlyRent,
            "Agreement monthly rent"
          );

          if(!this.checkCurrencyFormat(mustString(req.body.currency, "Currency")))
            throw new Error("Invalid currency format!");
          const currency: LeaseAgreement["currency"] = mustJSON(req.body.currency, "Currency");

          if(!this.checkPaymentFrequencyFormat(mustString(req.body.paymentFrequency, "Payment frequency")))
            throw new Error("Invalid payment frequency format!");
          const paymentFrequency: LeaseAgreement["paymentFrequency"] = mustJSON(
            req.body.paymentFrequency,
            "Payment frequency"
          );

          if(!this.checkPaymentMethodFormat(mustString(req.body.paymentMethod, "Payment method")))
            throw new Error("Invalid payment method format!");
          const paymentMethod: LeaseAgreement["paymentMethod"] = mustJSON(
            req.body.paymentMethod,
            "Payment method"
          );

          if(!this.checkSecurityDepositFormat(mustString(req.body.securityDeposit, "Security deposit")))
            throw new Error("Invalid security deposit format!");
          const securityDeposit: LeaseAgreement["securityDeposit"] = mustJSON(
            req.body.securityDeposit,
            "Security deposit"
          );

          if(!this.checkRentDueDateFormat(mustString(req.body.rentDueDate, "Rent due date")))
            throw new Error("Invalid rent due date format!");
          const rentDueDate: LeaseAgreement["rentDueDate"] = mustJSON(
            req.body.rentDueDate,
            "Rent due date"
          );

          if(
            !this.checkLatePaymentPenaltiesFormat(
              mustString(req.body.selectedLatePaymentPenalties, "Late payment penalties")
            )
          )
            throw new Error("Invalid late payment penalties format!");
          const selectedLatePaymentPenalties: LeaseAgreement["latePaymentPenalties"] = mustJSON(
            req.body.selectedLatePaymentPenalties,
            "Late payment penalties"
          );

          if(
            !this.checkUtilityResponsibilitiesFormat(
              mustString(req.body.selectedUtilityResponsibilities, "Utility responsibilities")
            )
          )
            throw new Error("Invalid utility responsibility format!");
          const selectedUtilityResponsibilities: LeaseAgreement["utilityResponsibilities"] = mustJSON(
            req.body.selectedUtilityResponsibilities,
            "Utility responsibilities"
          );

          if(!this.checkNoticePeriodDaysFormat(mustString(req.body.noticePeriodDays, "Notice period days")))
            throw new Error("Invalid notice period days format!");
          const noticePeriodDays: LeaseAgreement["noticePeriodDays"] = mustJSON(
            req.body.noticePeriodDays,
            "Notice period days"
          );

          if(!this.checkRuleAndRegulationsFormat(mustString(req.body.selectedRuleAndRegulations, "Rules & regs")))
            throw new Error("Invalid rule and regulations format!");
          const selectedRuleAndRegulations: RulesAndRegulations[] = mustJSON(
            req.body.selectedRuleAndRegulations,
            "Rules & regs"
          );

          const isReadTheCompanyPolicy: LeaseType["isReadTheCompanyPolicy"] = this.checkBoolean(
            mustString(req.body.isReadTheCompanyPolicy, "Company policy confirmation")
          );

          const signedAtStr = mustISODate(req.body.signedAt, "Agreement signed at date");
          const signedAt: Signatures["signedAt"] = new Date(signedAtStr);

          // Meta
          const ipAddress: string =
            (req.headers["x-forwarded-for"] as string | undefined) ?? req.socket.remoteAddress ?? "Unknown IP";

          if(!this.checkAddedBy(mustString(req.body.userAgent, "User agent")))
            throw new Error("Invalid added-by format for user agent!");
          const userAgent: AddedBy = mustJSON(req.body.userAgent, "User agent");

          if(!this.checkSystemMetaDataFormat(mustString(req.body.systemMetaData, "System metadata")))
            throw new Error("Invalid system metadata format!");
          const systemMetaData: SystemMetadata = mustJSON(req.body.systemMetaData, "System metadata");
          systemMetaData.lastUpdated = new Date().toISOString();

          // ---------- scanned docs: merge & move ----------
          const host = req.get("host");
          const protocol = req.protocol;
          const baseUrl = `${protocol}://${host}`;

          const scannedDocumentPath = path.join(__dirname, `../../public/lease/${leaseID}/documents/`);
          const mobileScannedFolderPath = path.join(
            __dirname,
            `../../public/tenants/scanned-files/${tenantUsername}/`
          );

          const tenantUploadedScanedDocumentsRemoved: ScannedFileRecordJSON[] = mustJSON(
            req.body.tenantUploadedScanedDocumentsRemoved,
            "Removed scanned docs"
          );

          const JSON_PATH = path.join(
            __dirname,
            "../../public/tenants/scanned-files/tenantScannedFilesData.json"
          );
          if(fs.existsSync(JSON_PATH)) {
            const fileContent = await fs.promises.readFile(JSON_PATH, "utf8");
            const JSON_DATA: TenantScannedFilesDataJSON = JSON.parse(fileContent);
            const tenantJSONData = JSON_DATA[tenantUsername];

            if(Array.isArray(tenantJSONData)) {
              const updatedTenantJSONData = tenantJSONData.filter(
                (data) => !tenantUploadedScanedDocumentsRemoved.some((item) => item.token === data.token)
              );
              JSON_DATA[tenantUsername] = updatedTenantJSONData;
              await fs.promises.writeFile(JSON_PATH, JSON.stringify(JSON_DATA, null, 2));
            } else {
              console.warn(`No JSON data found for tenant: ${tenantUsername}`);
            }
          } else {
            console.warn(`[WARN] No JSON data found for tenant '${tenantUsername}' at ${JSON_PATH}`);
          }

          const tenantUploadedScanedDocuments: ScannedFileRecordJSON[] = mustJSON(
            req.body.tenantUploadedScanedDocuments,
            "Tenant uploaded scanned docs"
          );

          tenantUploadedScanedDocuments.forEach((item) => {
            item.folder = scannedDocumentPath;
            item.files.forEach((doc) => {
              const filename = doc.file.filename;
              const sourcePath = path.join(mobileScannedFolderPath, filename);
              if(fs.existsSync(sourcePath)) {
                const destinationPath = path.join(scannedDocumentPath, filename);
                doc.file.URL = `${baseUrl}/lease/${leaseID}/documents/${filename}`;
                doc.folder = scannedDocumentPath;
                fs.renameSync(sourcePath, destinationPath);
              }
            });
          });

          const scannedDocuments: ScannedFileRecordJSON[] = [];
          if(Array.isArray(tenantUploadedScanedDocuments) && tenantUploadedScanedDocuments.length > 0) {
            scannedDocuments.push(...tenantUploadedScanedDocuments);
          }

          const payloadToken = {tenant: tenantUsername, issuedAt: Date.now()};
          const token = await this.cryptoService.encrypt(payloadToken);

          const tenantScanedDocuments = files?.["tenantScanedDocuments"];
          const newScannedFileRecord: ScannedFileRecordJSON = {
            date: new Date().toISOString(),
            tenant: tenantUsername,
            token,
            files: [],
            folder: scannedDocumentPath,
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
                  URL: `${baseUrl}/lease/${leaseID}/documents/${doc.filename}`,
                },
              };
              newScannedFileRecord.files.push(data);
            });
          }

          if(newScannedFileRecord.files.length > 0) {
            scannedDocuments.push(newScannedFileRecord);
          }

          if(!scannedDocuments.length) {
            throw new Error(
              "No scanned identification document found. Please upload at least one document before submitting."
            );
          }

          // ---------- signatures (support old signatures JSON) ----------
          const tSig = files?.["tenantSignature"]?.[0];
          let tenantOldParsed: any;
          if(!tSig) {
            tenantOldParsed = mustJSON(req.body.tenantOldSignature, "Tenant old signature");
            if(!ensureFileSig(tenantOldParsed)) throw new Error("Tenant signature is required!");
          }
          const organizedTenantSignature: FILE = {
            fieldname: tSig?.fieldname ?? tenantOldParsed?.fieldname ?? "",
            originalname: tSig?.originalname ?? tenantOldParsed?.originalname ?? "",
            mimetype: tSig?.mimetype ?? tenantOldParsed?.mimetype ?? "",
            size: tSig?.size ?? tenantOldParsed?.size ?? 0,
            filename: tSig?.filename ?? tenantOldParsed?.filename ?? "",
            URL: tSig
              ? `${baseUrl}/lease/${leaseID}/signatures/tenant/${tSig.filename}`
              : tenantOldParsed?.URL ?? "",
          };

          const lSig = files?.["landlordSignature"]?.[0];
          let landlordOldParsed: any;
          if(!lSig) {
            landlordOldParsed = mustJSON(req.body.landlordOldSignature, "Landlord old signature");
            if(!ensureFileSig(landlordOldParsed)) throw new Error("Landlord signature is required!");
          }
          const organizedLandlordSignature: FILE = {
            fieldname: lSig?.fieldname ?? landlordOldParsed?.fieldname ?? "",
            originalname: lSig?.originalname ?? landlordOldParsed?.originalname ?? "",
            mimetype: lSig?.mimetype ?? landlordOldParsed?.mimetype ?? "",
            size: lSig?.size ?? landlordOldParsed?.size ?? 0,
            filename: lSig?.filename ?? landlordOldParsed?.filename ?? "",
            URL: lSig
              ? `${baseUrl}/lease/${leaseID}/signatures/landlord/${lSig.filename}`
              : landlordOldParsed?.URL ?? "",
          };

          // ---------- sub-docs ----------
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

          // ---------- parent payloads (omit coTenant if undefined) ----------
          const UPDATE_DATA: LeasePayload = {
            leaseID,
            tenantInformation: UPDATE_DATA_TenantInformation,
            ...(UPDATE_DATA_coTenant ? {coTenant: UPDATE_DATA_coTenant} : {}),
            propertyID: selectedProperty.id,
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

          // ---------- persist JSON snapshot (keep old copies) ----------
          const todayStamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .replace("T", "_")
            .replace("Z", "");

          const JSON_CURR = path.join(__dirname, `../../public/lease/${leaseID}/agreement-data/${leaseID}.json`);
          const JSON_OLD = path.join(
            __dirname,
            `../../public/lease/${leaseID}/agreement-data/old/${todayStamp}/${leaseID}.json`
          );

          if(fs.existsSync(JSON_CURR)) {
            await fs.promises.mkdir(path.dirname(JSON_OLD), {recursive: true});
            await fs.promises.rename(JSON_CURR, JSON_OLD);
          }
          await fs.promises.mkdir(path.dirname(JSON_CURR), {recursive: true});
          await fs.promises.writeFile(JSON_CURR, JSON.stringify(UPDATE_DOCUMENT_DATA, null, 2));

          // ---------- DB update ----------
          const leaseAgreement = await LeaseModel.updateOne(
            {leaseID},
            {$set: UPDATE_DATA}
          );

          if(leaseAgreement) {
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
                  updatedLeaseAgreement: UPDATE_DOCUMENT_DATA,
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
              data: leaseAgreement,
            });
          } else {
            res.status(501).json({
              status: "error",
              message: "Agreement update failed. Please try again later or contact support.",
            });
          }
        } catch(error) {
          console.log("Error in update lease agreement:", error);
          if(error instanceof Error) {
            res.status(500).json({status: "error", error: error.message});
          } else {
            res.status(500).json({status: "error", error: "An unknown error occurred." + error});
          }
        }
      }
    );
  }
  //<============================================== END UPDATE THE LEASE AGREEMENT ==============================================>

  //<============================================== PREVIEW EJS FILE (ROUTE HANDLER) ==============================================>
  private setupEjsPreview() {
    this.router.get(
      "/preview-lease-agreement/:leaseID",
      async (req: Request<{leaseID: string}>, res: Response) => {
        try {
          const leaseID = req.params.leaseID;
          if(!leaseID) throw new Error("Lease ID is required!");

          const LEASE_AGREEMENT_JSON_DATA_FILE_PATH = path.join(
            __dirname,
            `../../public/lease/${leaseID}/agreement-data/${leaseID}.json`
          );

          if(!fs.existsSync(LEASE_AGREEMENT_JSON_DATA_FILE_PATH))
            throw new Error("Agreement data not found!");

          const fileContent = await fs.promises.readFile(
            LEASE_AGREEMENT_JSON_DATA_FILE_PATH,
            "utf8"
          );
          const JSON_DATA: LeasePayload = JSON.parse(fileContent);

          // Render the EJS file and pass JSON_DATA as "data"
          res.render("lease-agreement-pdf.ejs", {data: JSON_DATA});

        } catch(error) {
          console.log("Error in preview lease agreement:", error);
          if(error instanceof Error) {
            res.status(500).json({status: "error", error: error.message});
          } else {
            res.status(500).json({
              status: "error",
              error: "An unknown error occurred." + error,
            });
          }
        }
      }
    );
  }
  //<============================================== END PREVIEW EJS FILE ==============================================>

  //<============================================== LAUNCH OR RETURN EXISTING PUPPETEER BROWSER  ==============================================>
  /**
   * Launch or return existing Puppeteer browser instance
   * Used for rendering PDF with consistent performance
   */
  private async getBrowser(): Promise<puppeteer.Browser> {
    if(this.puppeteerBrowser && this.puppeteerBrowser.isConnected()) {
      return this.puppeteerBrowser;
    }

    const launchOptions: puppeteer.LaunchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };

    // Cross-platform Chrome path
    const getChromePath = (): string | undefined => {
      const platform = os.platform();

      if(platform === 'win32') {
        const chromePaths = [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ];
        return chromePaths.find(p => fs.existsSync(p));
      }

      if(platform === 'darwin') {
        const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        return fs.existsSync(macPath) ? macPath : undefined;
      }

      if(platform === 'linux') {
        const linuxPaths = [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium'
        ];
        return linuxPaths.find(p => fs.existsSync(p));
      }

      return undefined;
    };

    const chromePath = getChromePath();
    if(chromePath) {
      launchOptions.executablePath = chromePath;
    }

    this.puppeteerBrowser = await puppeteer.launch(launchOptions);
    return this.puppeteerBrowser;
  }
  //<============================================== END LAUNCH OR RETURN EXISTING PUPPETEER BROWSER  ==============================================>

  //<============================================== GPRELOAD EJS TEMPLATE AND LOGO ==============================================>
  /**
  * Preload EJS templates and base64 logo to memory for performance
  */
  private preloadTemplates() {
    const baseDir = path.join(__dirname, '../../public/view/leaseDocumentTemplates/');
    this.cachedTemplates = {
      header: fs.readFileSync(path.join(baseDir, 'header.ejs'), 'utf8'),
      footer: fs.readFileSync(path.join(baseDir, 'footer.ejs'), 'utf8'),
      main: fs.readFileSync(path.join(baseDir, 'lease-agreement-pdf.ejs'), 'utf8'),
      logoBase64: fs.readFileSync(path.join(__dirname, '../../public/companyData/images/PropEase.png')).toString('base64')
    };
  }
  //<============================================== END GPRELOAD EJS TEMPLATE AND LOGO ==============================================>

  //<============================================== GENERATE LEASE AGREEMENT PDF BASED ON LEASE ID AND RESPONSE TYPE "download/view" ==============================================>
  /**
   * Generate PDF from lease agreement data and return as HTTP response
   * Supports both inline view and file download based on route param `type`
   */
  private generatePDFOfLeaseAgreement() {
    this.router.get("/lease-agreement-pdf/:leaseID/:type/:generator", async (req: Request, res: Response) => {
      try {
        const {leaseID, type, generator} = req.params;
        if(!leaseID || !type || !generator) throw new Error("Missing parameters");

        const jsonPath = path.join(__dirname, `../../public/lease/${leaseID}/agreement-data/${leaseID}.json`);
        if(!fs.existsSync(jsonPath)) throw new Error("Lease data not found");

        const leaseData = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));

        if(leaseData.property?.location) {
          leaseData.property.location.embeddedUrl = await this.makeDinamicMAPURL(leaseData.property.location);
        }

        const formatDate = (d: string) => {
          const dt = new Date(d);
          return `${dt.getFullYear()}/${(dt.getMonth() + 1).toString().padStart(2, '0')}/${dt.getDate().toString().padStart(2, '0')}`;
        };
        leaseData.tenantInformation.dateOfBirth = formatDate(leaseData.tenantInformation.dateOfBirth);
        leaseData.leaseAgreement.startDate = formatDate(leaseData.leaseAgreement.startDate);
        leaseData.leaseAgreement.endDate = formatDate(leaseData.leaseAgreement.endDate);

        leaseData.signatures.signedAt = formatDate(leaseData.signatures.signedAt);
        leaseData.systemMetadata.lastUpdated = formatDate(new Date(leaseData.systemMetadata.lastUpdated).toISOString());

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
        await page.setContent(html, {waitUntil: 'networkidle0'});
        await page.emulateMediaType('screen');

        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: header,
          footerTemplate: footer,
          margin: {top: '150px', bottom: '150px'},
          preferCSSPageSize: true,
        });

        await page.close();

        // Send notification about the PDF generation
        const notificationService = new NotificationService();
        const io = req.app.get('io') as import('socket.io').Server;
        await notificationService.createNotification(
          {
            title: 'Lease Agreement Download',
            body: `Lease agreement PDF has been generated successfully with ID: ${leaseID}.`,
            type: 'download',          // OK (your entity allows custom strings)
            severity: 'info',
            audience: {mode: 'role', usernames: [leaseData.tenantInformation.tenantUsername], roles: ['admin', 'operator']}, // target the user
            channels: ['inapp', 'email'], // keep if you'll email later; harmless otherwise 
            metadata: {
              leaseID: leaseID,
              tenantUsername: leaseData.tenantInformation.tenantUsername,
              generatedAt: new Date().toISOString(),
              generatedBy: generator,
              ipAddress: req.ip,
              userAgent: req.headers['user-agent'],
            },
            // DO NOT send createdAt here; NotificationService sets it
          },
          // Real-time emit callback: send to each audience room
          (rooms, payload) => {
            rooms.forEach((room) => {
              io.to(room).emit('notification.new', payload);
            });
          }
        );


        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition",
          type === 'download'
            ? `attachment; filename=${leaseID}-agreement.pdf`
            : `inline; filename=${leaseID}-agreement.pdf`
        );

        res.send(pdfBuffer);

      } catch(error) {
        console.error("Error generating PDF:", error);
        res.status(500).json({
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }
  //<============================================== END GENERATE LEASE AGREEMENT PDF BASED ON LEASE ID AND RESPONSE TYPE "download/view" ==============================================>

  //<============================================== GENERATE QR CODE IMAGE ==============================================>
  /**
   * Generate a QR Code (base64 image) from lease ID or string input
   */
  private async generateQRCode(data: string): Promise<string> {
    try {
      return await QRCode.toDataURL(data, {
        errorCorrectionLevel: 'H',
        type: 'image/png',
        margin: 2,
        width: 512,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });
    } catch(error) {
      console.error('QR code generation failed:', error);
      return '';
    }
  }
  //<============================================== END GENERATE QR CODE IMAGE ==============================================>

  //<============================================== BUILD STATIC GOOGLE MAP URL (WITH FALLBACK) ==============================================>
  /**
   * Generate static Google Map image URL (base64 PNG) from coordinates
   * Used when rendering property location in PDF
   */
  private async makeDinamicMAPURL(input: any): Promise<string> {
    try {
      const APIkey = process.env.GOOGLE_API_KEY;
      const {lat, lng, embeddedUrl} = input;
      const staticMapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=14&size=800x300&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${APIkey}`;
      const response = await axios.get(staticMapUrl, {responseType: 'arraybuffer'});
      if(response.status === 200) {
        return `data:image/png;base64,${Buffer.from(response.data, 'binary').toString('base64')}`;
      }
      return embeddedUrl || '';
    } catch(error) {
      console.error("Error generating map URL:", error);
      return '';
    }
  }
  //<============================================== END BUILD STATIC GOOGLE MAP URL (WITH FALLBACK) ==============================================>

  //<============================================== GET LEASE AGREEMENTS BASE ON THE LEASE ID ==============================================>
  private getLeaseAgreementsByLeaseID() {
    this.router.get(
      "/lease-agreement/:leaseID", async (req: Request<{leaseID: string}>, res: Response) => {
        try {
          const {leaseID} = req.params;
          const safeLeaseID = leaseID.trim()
          if(!safeLeaseID) throw new Error("Lease ID is required!");

          const data = await LeaseModel.findOne({leaseID: safeLeaseID}, {});
          if(data) {
            res.status(200).json({
              status: "success",
              message: "Lease agreements retrieved successfully!",
              data: data,
            })
          }
          else {
            res.status(404).json({
              status: "error",
              message: `No lease agreements found for this lease ID (${leaseID}).`,
            })
          }
        }
        catch(error) {
          console.log("Error in preview lease agreement:", error);
          if(error instanceof Error) {
            res.status(500).json({status: "error", error: error.message});
          } else {
            res.status(500).json({
              status: "error",
              error: "An unknown error occurred." + error,
            });
          }
        }
      })
  }
  //<============================================== END GET LEASE AGREEMENTS BASE ON THE LEASE ID ==============================================>

  //<============================================== GET ALL LEASE AGREEMENTS BASE ON THE USERNAME ==============================================>
  private getAllLeaseAgreementsByUsername() {
    this.router.get(
      "/lease-agreements/:username",
      async (req: Request<{username: string}>, res: Response) => {
        try {
          const {username} = req.params;
          const safeUsername = this.sanitizeInput(username);
          if(!safeUsername) throw new Error("Username is required!");

          const leaseAgreements = await LeaseModel.find({
            "tenantInformation.tenantUsername": safeUsername,
          }).sort({"systemMetadata.lastUpdated": -1});

          if(leaseAgreements) {
            res.status(200).json({
              status: "success",
              message: "Lease agreements retrieved successfully!",
              data: leaseAgreements,
            });
          } else {
            res.status(404).json({
              status: "error",
              message: "No lease agreements found for this user.",
            });
          }

        } catch(error) {
          console.log("Error in get all lease agreements:", error);
          if(error instanceof Error) {
            res.status(500).json({status: "error", error: error.message});
          } else {
            res.status(500).json({
              status: "error",
              error: "An unknown error occurred." + error,
            });
          }
        }
      }
    );
  }
  //<============================================== END GET ALL LEASE AGREEMENTS BASE ON THE USERNAME ==============================================>

  //<============================================== GET THE LEASE AGREEMENT BY ID AND UPDATE LEASE VALIDATION STATUS ==============================================>
  private getLeaseAgreementByIDAndUpdateValidationStatus() {
    const upload = multer();
    this.router.put("/lease-status-updated/:leaseID", upload.none(), async (req: Request<{leaseID: string}>, res: Response) => {
      try {
        const {leaseID} = req.params;
        const safeLeaseID = leaseID.trim();
        if(!safeLeaseID) throw new Error("Lease ID is required!");

        const validationStatus = req.body.validationStatus;
        if(!validationStatus) throw new Error("Validation status is required!");

        if(!this.checkIsString(validationStatus.trim())) throw new Error("Validation should be string!");

        const today = new Date();
        const lastUpdated = today.toISOString();

        const leaseAgreement = await LeaseModel.findOneAndUpdate(
          {leaseID: safeLeaseID},
          {
            "systemMetadata.validationStatus": validationStatus,
            "systemMetadata.lastUpdated": lastUpdated
          },
          {new: true}
        );

        if(leaseAgreement) {
          res.status(200).json({
            status: "success",
            message: "Lease agreement has been updated successfully!",
            data: leaseAgreement,
          });
        }
        else {
          res.status(404).json({
            status: "error",
            message: "No lease agreement found for this lease ID.",
          });
        }
      }
      catch(error) {
        console.log("Error in get all lease agreements:", error);
        if(error instanceof Error) {
          res.status(500).json({status: "error", error: error.message});
        } else {
          res.status(500).json({
            status: "error",
            error: "An unknown error occurred." + error,
          });
        }
      }
    })
  }
  //<============================================== END GET THE LEASE AGREEMENT BY ID AND UPDATE LEASE VALIDATION STATUS ==============================================>

  //<============================================== GET ALL LEASES ==============================================>
  private getAllLeases() {
    this.router.get("/all-leases", async (req: Request, res: Response) => {
      try {
        const leases = await LeaseModel.find();
        console.log(leases)
        if(!leases) throw new Error('No leases found');
        res.status(200).json({status: "success", message: "All leases have been retrieved successfully!", data: leases});
      }
      catch(error) {
        console.log(error)
        res.status(500).json({status: 'error', error: 'An unknown error occurred: ' + error})
      }
    });
  }
  //<============================================== END GET ALL LEASES ==============================================>

  //********************************************************** END ROUTERS *******************************************************************/

  //********************************************************** OPERATIONS *******************************************************************/

  //<============================================== SANITIZE INPUT ==============================================>
  private sanitizeInput(input: string): string {
    if(typeof input !== 'string') return '';

    // Trim whitespace
    let sanitized = input.trim();

    // Replace common HTML special characters
    sanitized = sanitized
      .replace(/&/g, '&amp;')   // Escape ampersands first
      .replace(/</g, '&lt;')    // Escape <
      .replace(/>/g, '&gt;')    // Escape >
      .replace(/"/g, '&quot;')  // Escape double quotes
      .replace(/'/g, '&#x27;')  // Escape single quotes
      .replace(/\//g, '&#x2F;'); // Escape forward slashes

    return sanitized;
  }
  //<============================================== END SANITIZE INPUT ==============================================>

  //<============================================== GET TENANT BY USERNAME ==============================================>
  private getTenantByUsername() {
    this.router.get(
      "/get-tenant-by-username/:username", async (req: Request<{username: string}>, res: Response) => {
        try {
          const {username} = req.params;
          const safeUsername = username.trim();
          const user = await UserModel.findOne({username: safeUsername});
          if(!user) throw new Error("User not found!");
          res.status(200).json({
            status: "success",
            message: "User retrieved successfully!",
            data: user,
          })
        }
        catch(error) {
          console.log(error)
          res.status(500).json({status: "error", error: "An unknown error occurred: " + error})
        }
      });
  }
  //<============================================== END GET TENANT BY USERNAME ==============================================>

  //********************************************************** END OPERATIONS *******************************************************************/

  //********************************************************** TYPE CHECKING *******************************************************************/

  //<============================================== CHECK ADDED BY FORMAT TYPE ==============================================>
  private checkSystemMetaDataFormat(input: any): input is SystemMetadata {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.ocrAutoFillStatus === "boolean" &&
      typeof data.validationStatus === "string" &&
      typeof data.language === "string" &&
      typeof data.leaseTemplateVersion === "string" &&
      typeof data.lastUpdated === "string"
    );
  }
  //<============================================== END CHECK ADDED BY FORMAT TYPE ==============================================>

  //<============================================== CHECK ADDED BY FORMAT TYPE ==============================================>
  private checkRentDueDateFormat(input: any): input is RentDueDate {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data && typeof data.id === "string" && typeof data.label === "string"
    );
  }
  //<============================================== END CHECK ADDED BY FORMAT TYPE ==============================================>

  //<============================================== CHECK ADDED BY FORMAT TYPE ==============================================>
  private checkAddedBy(input: any): input is AddedBy {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.username === "string" &&
      typeof data.name === "string" &&
      typeof data.email === "string" &&
      typeof data.role === "string" &&
      (typeof data.addedAt === "string" || data.addedAt instanceof Date)
    );
  }
  //<============================================== END CHECK ADDED BY FORMAT TYPE ==============================================>

  //<============================================== CHECK BOOLEAN TYPE ==============================================>
  private checkBoolean(input: any): boolean {
    return input.toLowerCase() === "true";
  }
  //<============================================== END CHECK BOOLEAN FORMAT TYPE ==============================================>

  //<============================================== CHECK LATE PAYMENT PENALTIES FORMAT TYPE ==============================================>
  private checkRuleAndRegulationsFormat(
    input: any
  ): input is RulesAndRegulations[] {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!Array.isArray(data)) return false;

    return data.every(
      (item) =>
        item &&
        typeof item.rule === "string" &&
        typeof item.description === "string"
    );
  }
  //<============================================== END CHECK LATE PAYMENT PENALTIES FORMAT TYPE ==============================================>

  //<============================================== CHECK NOTICE PERIOD DAYS FORMAT TYPE ==============================================>
  private checkNoticePeriodDaysFormat(input: any): input is NoticePeriod {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.id === "string" &&
      typeof data.label === "string" &&
      typeof data.days === "number" &&
      typeof data.description === "string"
    );
  }
  //<============================================== END CHECK NOTICE PERIOD DAYS FORMAT TYPE ==============================================>

  //<============================================== CHECK LATE PAYMENT PENALTIES FORMAT TYPE ==============================================>
  private checkUtilityResponsibilitiesFormat(
    input: any
  ): input is UtilityResponsibility[] {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!Array.isArray(data)) return false;

    return data.every(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.utility === "string" &&
        typeof item.paidBy === "string" &&
        typeof item.description === "string"
    );
  }
  //<============================================== END CHECK LATE PAYMENT PENALTIES FORMAT TYPE ==============================================>

  //<============================================== CHECK LATE PAYMENT PENALTIES FORMAT TYPE ==============================================>
  private checkLatePaymentPenaltiesFormat(
    input: any
  ): input is LatePaymentPenalty[] {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!Array.isArray(data)) return false;
    return data.every(
      (item) =>
        item &&
        typeof item.label === "string" &&
        typeof item.type === "string" &&
        typeof item.value === "number" &&
        typeof item.description === "string"
    );
  }
  //<============================================== END CHECK LATE PAYMENT PENALTIES FORMAT TYPE ==============================================>

  //<============================================== CHECK SECURITY DEPOSIT FORMAT TYPE ==============================================>
  private checkSecurityDepositFormat(input: any): input is SecurityDeposit {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.id === "string" &&
      typeof data.name === "string" &&
      typeof data.description === "string" &&
      typeof data.refundable === "boolean"
    );
  }
  //<============================================== END CHECK SECURITY DEPOSIT FORMAT TYPE ==============================================>

  //<============================================== CHECK PAYMENT METHOD FORMAT TYPE ==============================================>
  private checkPaymentMethodFormat(input: any): input is PaymentMethod {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.id === "string" &&
      typeof data.name === "string" &&
      typeof data.category === "string"
    );
  }
  //<============================================== END CHECK PAYMENT METHOD FORMAT TYPE ==============================================>

  //<============================================== CHECK PAYMENT FREQUENCY FORMAT TYPE ==============================================>
  private checkPaymentFrequencyFormat(input: any): input is PaymentFrequency {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.id === "string" &&
      typeof data.name === "string" &&
      typeof data.duration === "string" &&
      typeof data.unit === "string"
    );
  }
  //<============================================== END CHECK PAYMENT FREQUENCY FORMAT TYPE ==============================================>

  //<============================================== CHECK CURRENCY FORMAT TYPE ==============================================>
  private checkCurrencyFormat(input: any): input is CurrencyFormat {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.country === "string" &&
      typeof data.symbol === "string" &&
      typeof data.flags === "object" &&
      typeof data.flags.png === "string" &&
      typeof data.flags.svg === "string" &&
      typeof data.currency === "string"
    );
  }
  //<============================================== END CHECK CURRENCY FORMAT TYPE ==============================================>

  //<============================================== CHECK ISO DATE TYPE ==============================================>
  private checkISODate(input: any): boolean {
    if(typeof input !== "string") return false;
    const isoDateRegex =
      /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}:\d{2}(.\d+)?(Z|([+-]\d{2}:\d{2})))?$/;
    return isoDateRegex.test(input) && !isNaN(Date.parse(input));
  }
  //<============================================== END CHECK ISO DATE TYPE ==============================================>

  //<============================================== CHECK STRING TYPE ==============================================>
  private checkIsString(input: any): input is string {
    return typeof input === "string" && input.trim().length > 0;
  }
  //<============================================== END CHECK STRING TYPE ==============================================>

  //<============================================== CHECK PHONE CODE DETAILS TYPE ==============================================>
  private checkIsPhoneCodeDetails(input: any): boolean {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      typeof data.name === "string" &&
      typeof data.code === "string" &&
      typeof data.flags === "object" &&
      typeof data.flags.png === "string" &&
      typeof data.flags.svg === "string"
    );
  }
  //<============================================== END CHECK PHONE CODE DETAILS TYPE ==============================================>

  //<============================================== CHECK EMERGENCY CONTACT TYPE ==============================================>
  private checkIsEmergencyContact(input: any): input is EmergencyContact {
    try {
      const data = typeof input === "string" ? JSON.parse(input) : input;
      if(!data || typeof data !== "object") return false;
      return (
        data &&
        typeof data.name === "string" &&
        typeof data.relationship === "string" &&
        typeof data.contact === "string"
      );
    } catch(error) {
      console.error("Failed to parse emergency contact:", error);
      return false;
    }
  }
  //<============================================== END CHECK EMERGENCY CONTACT TYPE ==============================================>

  //<============================================== CHECK ADDRESS TYPE ==============================================>
  private isValidTenantAddress(input: any): input is Address {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.houseNumber === "string" &&
      typeof data.street === "string" &&
      typeof data.city === "string" &&
      typeof data.stateOrProvince === "string" &&
      typeof data.postalCode === "string" &&
      typeof data.country === "object"
    );
  }
  //<============================================== END CHECK ADDRESS TYPE ==============================================>

  //<============================================== CHECK ADDRESS TYPE ==============================================>
  private isValidAddress(input: any): input is Address {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.houseNumber === "string" &&
      typeof data.street === "string" &&
      typeof data.city === "string" &&
      typeof data.stateOrProvince === "string" &&
      typeof data.postalCode === "string" &&
      typeof data.country === "string"
    );
  }
  //<============================================== END CHECK ADDRESS TYPE ==============================================>

  //<============================================== CHECK ADDED BY TYPE ==============================================>
  private isValidAddedBy(input: any): input is AddedBy {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if(!data || typeof data !== "object") return false;
    return (
      data &&
      typeof data.username === "string" &&
      typeof data.name === "string" &&
      typeof data.email === "string" &&
      typeof data.role === "string"
    );
  }
  //<============================================== END CHECK ADDED BY TYPE ==============================================>

  //********************************************************** END TYPE CHECKING *******************************************************************/
}
