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
    // Define allowed document types
    // You can add more types as per your requirements
    const allowedTypes = [
      // Word Documents
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/rtf",

      // Excel Documents
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "text/csv",
      "text/tab-separated-values",

      // PowerPoint Documents
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.template",

      // OpenDocument Formats
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",

      // PDF
      "application/pdf",

      // Plain Text
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
      // Dynamically determine destination path for uploaded files based on field name
      destination: (req, file, cb) => {
        const leaseID = req.params.leaseID;

        // Lease ID must be provided to associate uploaded files correctly
        if(!leaseID) {
          return cb(new Error("Lease ID is required in the URL path."), "");
        }

        let uploadPath = "";

        // Determine storage folder based on field name
        switch(file.fieldname) {
          case "tenantScanedDocuments":
            uploadPath = path.join(
              __dirname,
              `../../public/lease/${leaseID}/documents/`
            );
            break;
          case "tenantSignature":
            uploadPath = path.join(
              __dirname,
              `../../public/lease/${leaseID}/signatures/tenant/`
            );
            break;
          case "landlordSignature":
            uploadPath = path.join(
              __dirname,
              `../../public/lease/${leaseID}/signatures/landlord/`
            );
            break;
          default:
            return cb(new Error("Unexpected field: " + file.fieldname), "");
        }

        // Ensure the directory exists
        fs.mkdirSync(uploadPath, {recursive: true});

        // Pass the upload path to multer
        cb(null, uploadPath);
      },

      // Generate a unique filename to prevent conflicts
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const sanitized = file.originalname.replace(/\s+/g, "_");
        cb(null, `${uniqueSuffix}-${sanitized}`);
      },
    });

    // File filter to allow only specific file types based on field
    const fileFilter = (req: Request, file: Express.Multer.File, cb: any) => {
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

    // Create multer upload instance with defined storage and filter
    const upload = multer({storage, fileFilter});

    this.router.post(
      "/register/:leaseID",
      upload.fields([
        {name: "tenantScanedDocuments", maxCount: 50}, // allow up to 50 scanned files
        {name: "tenantSignature", maxCount: 1}, // only one signature expected
        {name: "landlordSignature", maxCount: 1}, // only one signature expected
      ]),
      async (req: Request<{leaseID: string}>, res: Response) => {
        try {
          // define the files to check whether the files are uploaded
          const files = req.files as
            | {[fieldname: string]: Express.Multer.File[]}
            | undefined;

          // Lease ID
          if(
            !this.checkIsString(
              req.params.leaseID.trim() || req.body.leaseID.trim()
            )
          )
            throw new Error("Lease ID is required");
          const leaseID = req.params.leaseID.trim() || req.body.leaseID.trim();
          if(!leaseID) throw new Error("Lease ID is required");
          // Tenant Information

          // Teanant ID
          if(!this.checkIsString(req.body.tenantUsername.trim()))
            throw new Error("Tenant ID is required");
          const tenantUsername: TenantInformation["tenantUsername"] =
            req.body.tenantUsername.trim();

          // Tenant Fullname
          if(!this.checkIsString(req.body.tenantFullName.trim()))
            throw new Error("Tenant Full Name is required");
          const tenantFullName: TenantInformation["fullName"] =
            req.body.tenantFullName.trim();

          // Tenant Email
          if(!this.checkIsString(req.body.tenantEmail.trim()))
            throw new Error("Tenant Email is required");
          const tenantEmail: TenantInformation["email"] =
            req.body.tenantEmail.trim();

          // Tenant Nationality
          if(!this.checkIsString(req.body.tenantNationality.trim()))
            throw new Error("Tenant Nationality is required");
          const tenantNationality: TenantInformation["nationality"] =
            req.body.tenantNationality.trim();

          // Tenant Birthday
          if(
            !this.checkIsString(req.body.tenantDateOfBirth.trim()) ||
            !this.checkISODate(req.body.tenantDateOfBirth.trim())
          ) {
            throw new Error(
              "Tenant date of birth must be provided as a valid ISO date string (YYYY-MM-DD)."
            );
          }
          const tenantDateOfBirth: TenantInformation["dateOfBirth"] = new Date(
            req.body.tenantDateOfBirth.trim()
          );
          if(isNaN(tenantDateOfBirth.getTime())) {
            throw new Error("Tenant date of birth is not a valid date.");
          }

          // Tenant Phone Code Details
          if(
            !this.checkIsPhoneCodeDetails(
              req.body.tenantPhoneCodeDetails.trim()
            )
          ) {
            throw new Error(
              "Invalid tenant phone code details: expected a valid country code object with name, code, and flag images."
            );
          }
          const tenantPhoneCodeDetails: CountryCodes = JSON.parse(
            req.body.tenantPhoneCodeDetails.trim()
          );

          // Tenant Phone Number
          if(!this.checkIsString(req.body.tenantPhoneNumber.trim()))
            throw new Error("Tenant Phone Number is required");
          const tenantPhoneNumber: TenantInformation["phoneNumber"] =
            req.body.tenantPhoneNumber.trim();

          // Tenant Gender
          if(!this.checkIsString(req.body.tenantGender.trim()))
            throw new Error("Tenant Gender is required");
          const tenantGender: TenantInformation["gender"] =
            req.body.tenantGender.trim();

          // Tenant NIC OR Passport
          if(!this.checkIsString(req.body.tenantNICOrPassport.trim()))
            throw new Error("Tenant NIC OR Passport is required");
          const tenantNICOrPassport: TenantInformation["nicOrPassport"] =
            req.body.tenantNICOrPassport.trim();

          // Tenant address
          if(!this.isValidTenantAddress(req.body.tenantAddress.trim()))
            throw new Error(
              "Invalid tenant address: expected a valid address object with houseNumber, street, city, stateOrProvince, postalCode, and country."
            );
          const tenantAddress: Address = JSON.parse(
            req.body.tenantAddress.trim()
          );

          // Emergency Contact
          if(!this.checkIsEmergencyContact(req.body.emergencyContact))
            throw new Error(
              "Invalid tenant emergency contact: expected a valid emergency contact object with name, relationship, and contact."
            );
          const tenantEmergencyContact: EmergencyContact = JSON.parse(
            req.body.emergencyContact
          );

          // Co-Tenant Details
          const coTenantFullname: CoTenant["fullName"] =
            req.body.coTenantFullname.trim();
          const coTenantEmail: CoTenant["email"] =
            req.body.coTenantEmail.trim();
          const coTenantPhoneCodeId: CoTenant["phoneCode"] =
            req.body.coTenantPhoneCodeId.trim();
          const coTenantPhoneNumber: CoTenant["phoneNumber"] =
            req.body.coTenantPhoneNumber.trim();
          const coTenantGender: CoTenant["gender"] =
            req.body.coTenantGender.trim();
          const coTenantNicOrPassport: CoTenant["nicOrPassport"] =
            req.body.coTenantNicOrPassport.trim();
          const coTenantAge: CoTenant["age"] = parseInt(
            req.body.coTenantAge.trim()
          );
          const coTenantRelationship = req.body.coTenantRelationship.trim();

          // Property Details
          const selectedProperty: Property = JSON.parse(
            req.body.selectedProperty
          );

          // Lease Agreement startDate
          if(
            !this.checkIsString(req.body.startDate.trim()) ||
            !this.checkISODate(req.body.startDate.trim())
          )
            throw new Error(
              "Agreement starting date must be provided as a valid ISO date string (YYYY-MM-DD)."
            );
          const startDate: LeaseAgreement["startDate"] =
            req.body.startDate.trim();

          // Lease Agreement endDate
          if(
            !this.checkIsString(req.body.endDate.trim()) ||
            !this.checkISODate(req.body.endDate.trim())
          )
            throw new Error(
              "Agreement ending date must be provided as a valid ISO date string (YYYY-MM-DD)."
            );
          const endDate: LeaseAgreement["endDate"] = req.body.endDate.trim();

          // Lease Agreement duration
          if(!this.checkIsString(req.body.durationMonths.trim()))
            throw new Error(
              "Agreement duration in months must be provided as a valid number."
            );
          const durationMonths: LeaseAgreement["durationMonths"] = parseInt(
            req.body.durationMonths.trim()
          );

          // Lease Agreement monthly rent
          if(!this.checkIsString(req.body.monthlyRent.trim()))
            throw new Error(
              "Agreement monthly rent must be provided as a valid number."
            );
          const monthlyRent: LeaseAgreement["monthlyRent"] = parseInt(
            req.body.monthlyRent.trim()
          );

          // Lease Agreement currency
          if(!this.checkCurrencyFormat(req.body.currency.trim()))
            throw new Error("Invalid currency format!");
          const currency: LeaseAgreement["currency"] = JSON.parse(
            req.body.currency.trim()
          );

          // Lease Agreement payment frequency
          if(
            !this.checkPaymentFrequencyFormat(req.body.paymentFrequency.trim())
          )
            throw new Error("Invalid payment frequency format!");
          const paymentFrequency: LeaseAgreement["paymentFrequency"] =
            JSON.parse(req.body.paymentFrequency.trim());

          // Lease Agreement payment method
          if(!this.checkPaymentMethodFormat(req.body.paymentMethod.trim()))
            throw new Error("Invalid payment method format!");
          const paymentMethod: LeaseAgreement["paymentMethod"] = JSON.parse(
            req.body.paymentMethod.trim()
          );

          // Lease Agreement security deposit
          if(!this.checkSecurityDepositFormat(req.body.securityDeposit.trim()))
            throw new Error("Invalid security deposit format!");
          const securityDeposit: LeaseAgreement["securityDeposit"] = JSON.parse(
            req.body.securityDeposit.trim()
          );

          // Lease Agreement rent due date
          if(!this.checkRentDueDateFormat(req.body.rentDueDate.trim()))
            throw new Error("Invalid rent due date format!");
          const rentDueDate: LeaseAgreement["rentDueDate"] = JSON.parse(
            req.body.rentDueDate.trim()
          );

          // Lease Agreement selected late payment penalties
          if(
            !this.checkLatePaymentPenaltiesFormat(
              req.body.selectedLatePaymentPenalties.trim()
            )
          )
            throw new Error("Invalid late payment penalties format!");
          const selectedLatePaymentPenalties: LeaseAgreement["latePaymentPenalties"] =
            JSON.parse(req.body.selectedLatePaymentPenalties.trim());

          // Lease Agreement selected utility responsibilities
          if(
            !this.checkUtilityResponsibilitiesFormat(
              req.body.selectedUtilityResponsibilities.trim()
            )
          )
            throw new Error("Invalid utility responsibility format!");
          const selectedUtilityResponsibilities: LeaseAgreement["utilityResponsibilities"] =
            JSON.parse(req.body.selectedUtilityResponsibilities.trim());

          // Lease Agreement notice period days
          if(
            !this.checkNoticePeriodDaysFormat(req.body.noticePeriodDays.trim())
          )
            throw new Error("Invalid notice period days format!");
          const noticePeriodDays: LeaseAgreement["noticePeriodDays"] =
            JSON.parse(req.body.noticePeriodDays.trim());

          // Lease Agreement selected rule and regulations
          if(
            !this.checkRuleAndRegulationsFormat(
              req.body.selectedRuleAndRegulations.trim()
            )
          )
            throw new Error("Invalid rule and regulations format!");
          const selectedRuleAndRegulations: RulesAndRegulations[] = JSON.parse(
            req.body.selectedRuleAndRegulations.trim()
          );

          // Lease Agreement company policy read
          if(!this.checkIsString(req.body.isReadTheCompanyPolicy.trim()))
            throw new Error("Must confirm the company policy!");
          const isReadTheCompanyPolicy: LeaseType["isReadTheCompanyPolicy"] =
            this.checkBoolean(req.body.isReadTheCompanyPolicy.trim());

          // Lease Agreement signed at
          if(
            !this.checkIsString(req.body.signedAt.trim()) ||
            !this.checkISODate(req.body.signedAt.trim())
          )
            throw new Error(
              "Agreement signed at date must be provided as a valid ISO date string (YYYY-MM-DD)."
            );
          const signedAt: Signatures["signedAt"] = new Date(
            req.body.signedAt.trim()
          );

          // Lease Agreement ip address
          const ipAddress: string =
            (req.headers["x-forwarded-for"] as string | undefined) ??
            req.socket.remoteAddress ??
            "Unknown IP";

          // Define upload scanned document insert array
          const scannedDocuments: ScannedFileRecordJSON[] = [];

          // Lease Agreement added by (agent)
          if(!this.checkAddedBy(req.body.userAgent.trim()))
            throw new Error("Invalid added by format for user agent!");
          const userAgent: AddedBy = JSON.parse(req.body.userAgent.trim());

          // Sytem metadata
          if(!this.checkSystemMetaDataFormat(req.body.systemMetaData.trim()))
            throw new Error("Invalid syste metadata format!");
          const systemMetaData: SystemMetadata = JSON.parse(
            req.body.systemMetaData.trim()
          );

          // File Organization

          // Define base URL
          const host = req.get("host");
          const protocol = req.protocol;
          const baseUrl = `${protocol}://${host}`;

          // Define the scanned documents path
          const scannedDocumentPath = path.join(
            __dirname,
            `../../public/lease/${leaseID}/documents/`
          );

          // Defined the mobile scanned documents path
          const mobileScannedFolderPath = path.join(
            __dirname,
            `../../public/tenants/scanned-files/${tenantUsername}/`
          );

          // Get the list of scanned documents that were removed by the tenant before submission
          const tenantUploadedScanedDocumentsRemoved: ScannedFileRecordJSON[] =
            JSON.parse(req.body.tenantUploadedScanedDocumentsRemoved);

          // Defined the JSON data file path
          const JSON_PATH = path.join(
            __dirname,
            "../../public/tenants/scanned-files/tenantScannedFilesData.json"
          );

          // Remove data that has already removed from the frontend
          if(fs.existsSync(JSON_PATH)) {
            // Define the file JSON file data
            const fileContent = await fs.promises.readFile(JSON_PATH, "utf8");
            // Converte to the data into JSON format
            const JSON_DATA: TenantScannedFilesDataJSON =
              JSON.parse(fileContent);

            // Extract data that under tenant
            const tenantJSONData = JSON_DATA[tenantUsername];

            if(Array.isArray(tenantJSONData)) {
              // Make new array that not include removed data
              const updatedTenantJSONData = tenantJSONData.filter(
                (data) =>
                  !tenantUploadedScanedDocumentsRemoved.some(
                    (item) => item.token === data.token
                  )
              );

              // Update JSON data
              JSON_DATA[tenantUsername] = updatedTenantJSONData;

              // Save back to JSON file
              await fs.promises.writeFile(
                JSON_PATH,
                JSON.stringify(JSON_DATA, null, 2)
              );
            } else {
              console.warn(`No JSON data found for tenant: ${tenantUsername}`);
            }
          } else {
            console.warn(
              `[WARN] No JSON data found for tenant '${tenantUsername}' at ${JSON_PATH}`
            );
          }

          // Get the list of mobile scanned documents uploaded via web interface (tenant-uploaded via mobile scan)
          const tenantUploadedScanedDocuments: ScannedFileRecordJSON[] =
            JSON.parse(req.body.tenantUploadedScanedDocuments);

          // Organize the tenant mobile scanned documents and move files to the lease folder
          tenantUploadedScanedDocuments.forEach((item) => {
            const files = item.files;
            item.folder = scannedDocumentPath;
            files.forEach((doc) => {
              const filename = doc.file.filename;
              const sourcePath = path.join(mobileScannedFolderPath, filename);
              if(fs.existsSync(sourcePath)) {
                const destinationPath = path.join(
                  scannedDocumentPath,
                  filename
                );
                doc.file.URL = `${baseUrl}/lease/${leaseID}/documents/${filename}`;
                doc.folder = scannedDocumentPath;
                fs.renameSync(sourcePath, destinationPath);
              }
            });
          });

          // Push already uploaded data into the insert array
          if(
            Array.isArray(tenantUploadedScanedDocuments) &&
            tenantUploadedScanedDocuments.length > 0
          ) {
            scannedDocuments.push(...tenantUploadedScanedDocuments);
          }

          // Generate custom token for the selected files
          const payload = {
            tenant: tenantUsername,
            issuedAt: Date.now(),
          };
          const token = await this.cryptoService.encrypt(payload);

          // Scanned documents that has selected from frontend
          const tenantScanedDocuments = files?.["tenantScanedDocuments"];

          const newScannedFileRecord: ScannedFileRecordJSON = {
            date: new Date().toISOString(),
            tenant: tenantUsername,
            token: token,
            files: [],
            folder: scannedDocumentPath,
          };

          if(Array.isArray(tenantScanedDocuments)) {
            tenantScanedDocuments?.forEach((doc) => {
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

          // Push scanned selected files into the insert array
          if(
            Array.isArray(newScannedFileRecord.files) &&
            newScannedFileRecord.files.length > 0
          ) {
            scannedDocuments.push(newScannedFileRecord);
          }

          if(
            !Array.isArray(scannedDocuments) ||
            scannedDocuments.length === 0
          ) {
            throw new Error(
              "No scanned identification document found. Please upload at least one document before submitting."
            );
          }


          // Runtime type guard for the FILE shape
          const isValidOldSignature = (obj: any): obj is FILE => {
            return obj &&
              typeof obj.fieldname === 'string' &&
              typeof obj.originalname === 'string' &&
              typeof obj.mimetype === 'string' &&
              typeof obj.size === 'number' &&
              typeof obj.filename === 'string' &&
              typeof obj.URL === 'string';
          };

          // ========== Tenant Signature ==========
          const tenantSignature = files?.["tenantSignature"]?.[0];
          const tenantOldSignature = req.body.tenantOldSignature;

          let fallbackTenantSignature: FILE | undefined;

          if(!tenantSignature) {
            if(!isValidOldSignature(tenantOldSignature)) {
              throw new Error("Tenant signature is required!");
            }
            fallbackTenantSignature = tenantOldSignature;
          }

          const organizedTenantSignature: FILE = {
            fieldname: tenantSignature?.fieldname ?? fallbackTenantSignature?.fieldname ?? '',
            originalname: tenantSignature?.originalname ?? fallbackTenantSignature?.originalname ?? '',
            mimetype: tenantSignature?.mimetype ?? fallbackTenantSignature?.mimetype ?? '',
            size: tenantSignature?.size ?? fallbackTenantSignature?.size ?? 0,
            filename: tenantSignature?.filename ?? fallbackTenantSignature?.filename ?? '',
            URL: tenantSignature
              ? `${baseUrl}/lease/${leaseID}/signatures/tenant/${tenantSignature.filename}`
              : fallbackTenantSignature?.URL ?? '',
          };

          // ========== Landlord Signature ==========
          const landlordSignature = files?.["landlordSignature"]?.[0];
          const landlordOldSignature = req.body.landlordOldSignature;

          let fallbackLandlordSignature: FILE | undefined;

          if(!landlordSignature) {
            if(!isValidOldSignature(landlordOldSignature)) {
              throw new Error("Landlord signature is required!");
            }
            fallbackLandlordSignature = landlordOldSignature;
          }

          const organizedLandlordSignature: FILE = {
            fieldname: landlordSignature?.fieldname ?? fallbackLandlordSignature?.fieldname ?? '',
            originalname: landlordSignature?.originalname ?? fallbackLandlordSignature?.originalname ?? '',
            mimetype: landlordSignature?.mimetype ?? fallbackLandlordSignature?.mimetype ?? '',
            size: landlordSignature?.size ?? fallbackLandlordSignature?.size ?? 0,
            filename: landlordSignature?.filename ?? fallbackLandlordSignature?.filename ?? '',
            URL: landlordSignature
              ? `${baseUrl}/lease/${leaseID}/signatures/landlord/${landlordSignature.filename}`
              : fallbackLandlordSignature?.URL ?? '',
          };
          // Assign value to schemas

          // Tenant information
          const INSERT_DATA_TenantInformation: TenantInformation = {
            tenantUsername: tenantUsername,
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
            scannedDocuments: scannedDocuments,
          };

          // Co-Tenant information
          let INSERT_DATA_coTenant: CoTenant | undefined = undefined;
          if(coTenantFullname) {
            INSERT_DATA_coTenant = {
              fullName: coTenantFullname,
              email: coTenantEmail,
              phoneCode: coTenantPhoneCodeId,
              phoneNumber: coTenantPhoneNumber,
              gender: coTenantGender,
              nicOrPassport: coTenantNicOrPassport,
              age: coTenantAge,
              relationship: coTenantRelationship,
            };
          }

          // Lease agreement
          const INSERT_DATA_leaseAgreement: LeaseAgreement = {
            startDate: startDate,
            endDate: endDate,
            durationMonths: durationMonths,
            monthlyRent: monthlyRent,
            currency: currency,
            paymentFrequency: paymentFrequency,
            paymentMethod: paymentMethod,
            securityDeposit: securityDeposit,
            rentDueDate: rentDueDate,
            latePaymentPenalties: selectedLatePaymentPenalties,
            utilityResponsibilities: selectedUtilityResponsibilities,
            noticePeriodDays: noticePeriodDays,
          };

          // Signature and important data
          const INSERT_DATA_signatures: Signatures = {
            tenantSignature: organizedTenantSignature,
            landlordSignature: organizedLandlordSignature,
            signedAt: signedAt,
            ipAddress: ipAddress,
            userAgent: userAgent,
          };

          // Parent Lease document
          const INSERT_DATA: LeasePayload = {
            leaseID: leaseID,
            tenantInformation: INSERT_DATA_TenantInformation,
            coTenant: INSERT_DATA_coTenant,
            propertyID: selectedProperty.id,
            leaseAgreement: INSERT_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy: isReadTheCompanyPolicy,
            signatures: INSERT_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          // Parent Lease document
          const INSERT_DOCUMENT_DATA: LeasePayloadWithProperty = {
            leaseID: leaseID,
            tenantInformation: INSERT_DATA_TenantInformation,
            coTenant: INSERT_DATA_coTenant,
            property: selectedProperty,
            leaseAgreement: INSERT_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy: isReadTheCompanyPolicy,
            signatures: INSERT_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          // Save in the localdirectory for creating a pdf
          const LEASE_AGREEMENT_JSON_DATA_FILE_PATH = path.join(
            __dirname,
            `../../public/lease/${leaseID}/agreement-data/${leaseID}.json`
          );
          await fs.promises.mkdir(
            path.dirname(LEASE_AGREEMENT_JSON_DATA_FILE_PATH),
            {recursive: true}
          );
          await fs.promises.writeFile(
            LEASE_AGREEMENT_JSON_DATA_FILE_PATH,
            JSON.stringify(INSERT_DOCUMENT_DATA, null, 2)
          );

          // Insert data
          const INSERT = new LeaseModel(INSERT_DATA);
          await INSERT.save();


          if(INSERT) {
            // Send notification to the tenant
            // Notify all admins about the new property added
            const notificationService = new NotificationService();

            // get the Socket.IO instance you attached in app.ts (this.app.set('io', this.io))
            const io = req.app.get('io') as import('socket.io').Server;


            await notificationService.createNotification(
              {
                title: 'Created New Lease Agreement',
                body: `New lease agreement has been created with ID: ${leaseID}. Please review and validate the agreement.`,
                type: 'lease',          // OK (your entity allows custom strings)
                severity: 'info',
                audience: {mode: 'user', usernames: [tenantUsername], roles: ['admin']}, // target the user
                channels: ['inapp', 'email'], // keep if you'll email later; harmless otherwise
                metadata: {leaseID: leaseID, tenant: tenantUsername, property: selectedProperty.id, agent: userAgent.username},
                // DO NOT send createdAt here; NotificationService sets it
              },
              // Real-time emit callback: send to each audience room
              (rooms, payload) => {
                rooms.forEach((room) => {
                  io.to(room).emit('notification.new', payload);
                });
              }
            );

            res.status(200).json({
              status: "success",
              message: "Agreement has been created successfully!",
              data: INSERT,
            });
          } else {
            res.status(501).json({
              status: "error",
              message:
                "Agreement creation failed. Please try again later or contact support.",
            });
          }
        } catch(error) {
          console.log("Error in register lease agreement:", error);
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
  //<============================================== END REGISTER LEASE AGREEMENT ==============================================>

  //<============================================== UPDATE THE LEASE AGREEMENT ==============================================>
  private updateLeaseAgreement() {
    // Define allowed document types
    // You can add more types as per your requirements
    const allowedTypes = [
      // Word Documents
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/rtf",

      // Excel Documents
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "text/csv",
      "text/tab-separated-values",

      // PowerPoint Documents
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.template",

      // OpenDocument Formats
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",

      // PDF
      "application/pdf",

      // Plain Text
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
      // Dynamically determine destination path for uploaded files based on field name
      destination: (req, file, cb) => {
        const leaseID = req.params.leaseID;

        // Lease ID must be provided to associate uploaded files correctly
        if(!leaseID) {
          return cb(new Error("Lease ID is required in the URL path."), "");
        }

        let uploadPath = "";

        // Determine storage folder based on field name
        switch(file.fieldname) {
          case "tenantScanedDocuments":
            uploadPath = path.join(
              __dirname,
              `../../public/lease/${leaseID}/documents/`
            );
            break;
          case "tenantSignature":
            uploadPath = path.join(
              __dirname,
              `../../public/lease/${leaseID}/signatures/tenant/`
            );
            break;
          case "landlordSignature":
            uploadPath = path.join(
              __dirname,
              `../../public/lease/${leaseID}/signatures/landlord/`
            );
            break;
          default:
            return cb(new Error("Unexpected field: " + file.fieldname), "");
        }

        // Ensure the directory exists
        fs.mkdirSync(uploadPath, {recursive: true});

        // Pass the upload path to multer
        cb(null, uploadPath);
      },

      // Generate a unique filename to prevent conflicts
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const sanitized = file.originalname.replace(/\s+/g, "_");
        cb(null, `${uniqueSuffix}-${sanitized}`);
      },
    });

    // File filter to allow only specific file types based on field
    const fileFilter = (req: Request, file: Express.Multer.File, cb: any) => {
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

    // Create multer upload instance with defined storage and filter
    const upload = multer({storage, fileFilter});

    this.router.put(
      "/update-lease-agreement/:leaseID",
      upload.fields([
        {name: "tenantScanedDocuments", maxCount: 50}, // allow up to 50 scanned files
        {name: "tenantSignature", maxCount: 1}, // only one signature expected
        {name: "landlordSignature", maxCount: 1}, // only one signature expected
      ]),
      async (req: Request<{leaseID: string}>, res: Response) => {
        try {
          console.log(req.body)
          // define the files to check whether the files are uploaded
          const files = req.files as
            | {[fieldname: string]: Express.Multer.File[]}
            | undefined;

          // Lease ID
          if(
            !this.checkIsString(
              req.params.leaseID.trim() || req.body.leaseID.trim()
            )
          )
            throw new Error("Lease ID is required");
          const leaseID = req.params.leaseID.trim() || req.body.leaseID.trim();
          if(!leaseID) throw new Error("Lease ID is required");

          const leaseAgreementDB = await LeaseModel.findOne({
            leaseID: leaseID,
          });

          if(!leaseAgreementDB) throw new Error('Lease agreement not found!')

          // Tenant Information

          // Teanant ID
          if(!this.checkIsString(req.body.tenantUsername.trim()))
            throw new Error("Tenant ID is required");
          const tenantUsername: TenantInformation["tenantUsername"] =
            req.body.tenantUsername.trim();

          // Tenant Fullname
          if(!this.checkIsString(req.body.tenantFullName.trim()))
            throw new Error("Tenant Full Name is required");
          const tenantFullName: TenantInformation["fullName"] =
            req.body.tenantFullName.trim();

          // Tenant Email
          if(!this.checkIsString(req.body.tenantEmail.trim()))
            throw new Error("Tenant Email is required");
          const tenantEmail: TenantInformation["email"] =
            req.body.tenantEmail.trim();

          // Tenant Nationality
          if(!this.checkIsString(req.body.tenantNationality.trim()))
            throw new Error("Tenant Nationality is required");
          const tenantNationality: TenantInformation["nationality"] =
            req.body.tenantNationality.trim();

          // Tenant Birthday
          if(
            !this.checkIsString(req.body.tenantDateOfBirth.trim()) ||
            !this.checkISODate(req.body.tenantDateOfBirth.trim())
          ) {
            throw new Error(
              "Tenant date of birth must be provided as a valid ISO date string (YYYY-MM-DD)."
            );
          }
          const tenantDateOfBirth: TenantInformation["dateOfBirth"] = new Date(
            req.body.tenantDateOfBirth.trim()
          );
          if(isNaN(tenantDateOfBirth.getTime())) {
            throw new Error("Tenant date of birth is not a valid date.");
          }

          // Tenant Phone Code Details
          if(
            !this.checkIsPhoneCodeDetails(
              req.body.tenantPhoneCodeDetails.trim()
            )
          ) {
            throw new Error(
              "Invalid tenant phone code details: expected a valid country code object with name, code, and flag images."
            );
          }
          const tenantPhoneCodeDetails: CountryCodes = JSON.parse(
            req.body.tenantPhoneCodeDetails.trim()
          );

          // Tenant Phone Number
          if(!this.checkIsString(req.body.tenantPhoneNumber.trim()))
            throw new Error("Tenant Phone Number is required");
          const tenantPhoneNumber: TenantInformation["phoneNumber"] =
            req.body.tenantPhoneNumber.trim();

          // Tenant Gender
          if(!this.checkIsString(req.body.tenantGender.trim()))
            throw new Error("Tenant Gender is required");
          const tenantGender: TenantInformation["gender"] =
            req.body.tenantGender.trim();

          // Tenant NIC OR Passport
          if(!this.checkIsString(req.body.tenantNICOrPassport.trim()))
            throw new Error("Tenant NIC OR Passport is required");
          const tenantNICOrPassport: TenantInformation["nicOrPassport"] =
            req.body.tenantNICOrPassport.trim();

          // Tenant address
          if(!this.isValidTenantAddress(req.body.tenantAddress.trim()))
            throw new Error(
              "Invalid tenant address: expected a valid address object with houseNumber, street, city, stateOrProvince, postalCode, and country."
            );
          const tenantAddress: Address = JSON.parse(
            req.body.tenantAddress.trim()
          );

          // Emergency Contact
          if(!this.checkIsEmergencyContact(req.body.emergencyContact))
            throw new Error(
              "Invalid tenant emergency contact: expected a valid emergency contact object with name, relationship, and contact."
            );
          const tenantEmergencyContact: EmergencyContact = JSON.parse(
            req.body.emergencyContact
          );

          // Co-Tenant Details
          const coTenantFullname: CoTenant["fullName"] =
            req.body.coTenantFullname.trim();
          const coTenantEmail: CoTenant["email"] =
            req.body.coTenantEmail.trim();
          const coTenantPhoneCodeId: CoTenant["phoneCode"] =
            req.body.coTenantPhoneCodeId.trim();
          const coTenantPhoneNumber: CoTenant["phoneNumber"] =
            req.body.coTenantPhoneNumber.trim();
          const coTenantGender: CoTenant["gender"] =
            req.body.coTenantGender.trim();
          const coTenantNicOrPassport: CoTenant["nicOrPassport"] =
            req.body.coTenantNicOrPassport.trim();
          const coTenantAge: CoTenant["age"] = parseInt(
            req.body.coTenantAge.trim()
          );
          const coTenantRelationship = req.body.coTenantRelationship.trim();

          // Property Details
          const selectedProperty: Property = JSON.parse(
            req.body.selectedProperty
          );

          // Lease Agreement startDate
          if(
            !this.checkIsString(req.body.startDate.trim()) ||
            !this.checkISODate(req.body.startDate.trim())
          )
            throw new Error(
              "Agreement starting date must be provided as a valid ISO date string (YYYY-MM-DD)."
            );
          const startDate: LeaseAgreement["startDate"] =
            req.body.startDate.trim();

          // Lease Agreement endDate
          if(
            !this.checkIsString(req.body.endDate.trim()) ||
            !this.checkISODate(req.body.endDate.trim())
          )
            throw new Error(
              "Agreement ending date must be provided as a valid ISO date string (YYYY-MM-DD)."
            );
          const endDate: LeaseAgreement["endDate"] = req.body.endDate.trim();

          // Lease Agreement duration
          if(!this.checkIsString(req.body.durationMonths.trim()))
            throw new Error(
              "Agreement duration in months must be provided as a valid number."
            );
          const durationMonths: LeaseAgreement["durationMonths"] = parseInt(
            req.body.durationMonths.trim()
          );

          // Lease Agreement monthly rent
          if(!this.checkIsString(req.body.monthlyRent.trim()))
            throw new Error(
              "Agreement monthly rent must be provided as a valid number."
            );
          const monthlyRent: LeaseAgreement["monthlyRent"] = parseInt(
            req.body.monthlyRent.trim()
          );

          // Lease Agreement currency
          if(!this.checkCurrencyFormat(req.body.currency.trim()))
            throw new Error("Invalid currency format!");
          const currency: LeaseAgreement["currency"] = JSON.parse(
            req.body.currency.trim()
          );

          // Lease Agreement payment frequency
          if(
            !this.checkPaymentFrequencyFormat(req.body.paymentFrequency.trim())
          )
            throw new Error("Invalid payment frequency format!");
          const paymentFrequency: LeaseAgreement["paymentFrequency"] =
            JSON.parse(req.body.paymentFrequency.trim());

          // Lease Agreement payment method
          if(!this.checkPaymentMethodFormat(req.body.paymentMethod.trim()))
            throw new Error("Invalid payment method format!");
          const paymentMethod: LeaseAgreement["paymentMethod"] = JSON.parse(
            req.body.paymentMethod.trim()
          );

          // Lease Agreement security deposit
          if(!this.checkSecurityDepositFormat(req.body.securityDeposit.trim()))
            throw new Error("Invalid security deposit format!");
          const securityDeposit: LeaseAgreement["securityDeposit"] = JSON.parse(
            req.body.securityDeposit.trim()
          );

          // Lease Agreement rent due date
          if(!this.checkRentDueDateFormat(req.body.rentDueDate.trim()))
            throw new Error("Invalid rent due date format!");
          const rentDueDate: LeaseAgreement["rentDueDate"] = JSON.parse(
            req.body.rentDueDate.trim()
          );

          // Lease Agreement selected late payment penalties
          if(
            !this.checkLatePaymentPenaltiesFormat(
              req.body.selectedLatePaymentPenalties.trim()
            )
          )
            throw new Error("Invalid late payment penalties format!");
          const selectedLatePaymentPenalties: LeaseAgreement["latePaymentPenalties"] =
            JSON.parse(req.body.selectedLatePaymentPenalties.trim());

          // Lease Agreement selected utility responsibilities
          if(
            !this.checkUtilityResponsibilitiesFormat(
              req.body.selectedUtilityResponsibilities.trim()
            )
          )
            throw new Error("Invalid utility responsibility format!");
          const selectedUtilityResponsibilities: LeaseAgreement["utilityResponsibilities"] =
            JSON.parse(req.body.selectedUtilityResponsibilities.trim());

          // Lease Agreement notice period days
          if(
            !this.checkNoticePeriodDaysFormat(req.body.noticePeriodDays.trim())
          )
            throw new Error("Invalid notice period days format!");
          const noticePeriodDays: LeaseAgreement["noticePeriodDays"] =
            JSON.parse(req.body.noticePeriodDays.trim());

          // Lease Agreement selected rule and regulations
          if(
            !this.checkRuleAndRegulationsFormat(
              req.body.selectedRuleAndRegulations.trim()
            )
          )
            throw new Error("Invalid rule and regulations format!");
          const selectedRuleAndRegulations: RulesAndRegulations[] = JSON.parse(
            req.body.selectedRuleAndRegulations.trim()
          );

          // Lease Agreement company policy read
          if(!this.checkIsString(req.body.isReadTheCompanyPolicy.trim()))
            throw new Error("Must confirm the company policy!");
          const isReadTheCompanyPolicy: LeaseType["isReadTheCompanyPolicy"] =
            this.checkBoolean(req.body.isReadTheCompanyPolicy.trim());

          // Lease Agreement signed at
          if(
            !this.checkIsString(req.body.signedAt.trim()) ||
            !this.checkISODate(req.body.signedAt.trim())
          )
            throw new Error(
              "Agreement signed at date must be provided as a valid ISO date string (YYYY-MM-DD)."
            );
          const signedAt: Signatures["signedAt"] = new Date(
            req.body.signedAt.trim()
          );

          // Lease Agreement ip address
          const ipAddress: string =
            (req.headers["x-forwarded-for"] as string | undefined) ??
            req.socket.remoteAddress ??
            "Unknown IP";

          // Define upload scanned document insert array
          const scannedDocuments: ScannedFileRecordJSON[] = [];

          // Lease Agreement added by (agent)
          if(!this.checkAddedBy(req.body.userAgent.trim()))
            throw new Error("Invalid added by format for user agent!");
          const userAgent: AddedBy = JSON.parse(req.body.userAgent.trim());

          // Sytem metadata
          if(!this.checkSystemMetaDataFormat(req.body.systemMetaData.trim()))
            throw new Error("Invalid syste metadata format!");
          const systemMetaData: SystemMetadata = JSON.parse(
            req.body.systemMetaData.trim()
          );

          systemMetaData.lastUpdated = new Date().toISOString();

          // File Organization

          // Define base URL
          const host = req.get("host");
          const protocol = req.protocol;
          const baseUrl = `${protocol}://${host}`;

          // Define the scanned documents path
          const scannedDocumentPath = path.join(
            __dirname,
            `../../public/lease/${leaseID}/documents/`
          );

          // Defined the mobile scanned documents path
          const mobileScannedFolderPath = path.join(
            __dirname,
            `../../public/tenants/scanned-files/${tenantUsername}/`
          );

          // Get the list of scanned documents that were removed by the tenant before submission
          const tenantUploadedScanedDocumentsRemoved: ScannedFileRecordJSON[] =
            JSON.parse(req.body.tenantUploadedScanedDocumentsRemoved);

          // Defined the JSON data file path
          const JSON_PATH = path.join(
            __dirname,
            "../../public/tenants/scanned-files/tenantScannedFilesData.json"
          );

          // Remove data that has already removed from the frontend
          if(fs.existsSync(JSON_PATH)) {
            // Define the file JSON file data
            const fileContent = await fs.promises.readFile(JSON_PATH, "utf8");
            // Converte to the data into JSON format
            const JSON_DATA: TenantScannedFilesDataJSON =
              JSON.parse(fileContent);

            // Extract data that under tenant
            const tenantJSONData = JSON_DATA[tenantUsername];

            if(Array.isArray(tenantJSONData)) {
              // Make new array that not include removed data
              const updatedTenantJSONData = tenantJSONData.filter(
                (data) =>
                  !tenantUploadedScanedDocumentsRemoved.some(
                    (item) => item.token === data.token
                  )
              );

              // Update JSON data
              JSON_DATA[tenantUsername] = updatedTenantJSONData;

              // Save back to JSON file
              await fs.promises.writeFile(
                JSON_PATH,
                JSON.stringify(JSON_DATA, null, 2)
              );
            } else {
              console.warn(`No JSON data found for tenant: ${tenantUsername}`);
            }
          } else {
            console.warn(
              `[WARN] No JSON data found for tenant '${tenantUsername}' at ${JSON_PATH}`
            );
          }

          // Get the list of mobile scanned documents uploaded via web interface (tenant-uploaded via mobile scan)
          const tenantUploadedScanedDocuments: ScannedFileRecordJSON[] =
            JSON.parse(req.body.tenantUploadedScanedDocuments);

          // Organize the tenant mobile scanned documents and move files to the lease folder
          tenantUploadedScanedDocuments.forEach((item) => {
            const files = item.files;
            item.folder = scannedDocumentPath;
            files.forEach((doc) => {
              const filename = doc.file.filename;
              const sourcePath = path.join(mobileScannedFolderPath, filename);
              if(fs.existsSync(sourcePath)) {
                const destinationPath = path.join(
                  scannedDocumentPath,
                  filename
                );
                doc.file.URL = `${baseUrl}/lease/${leaseID}/documents/${filename}`;
                doc.folder = scannedDocumentPath;
                fs.renameSync(sourcePath, destinationPath);
              }
            });
          });

          // Push already uploaded data into the insert array
          if(
            Array.isArray(tenantUploadedScanedDocuments) &&
            tenantUploadedScanedDocuments.length > 0
          ) {
            scannedDocuments.push(...tenantUploadedScanedDocuments);
          }

          // Generate custom token for the selected files
          const payload = {
            tenant: tenantUsername,
            issuedAt: Date.now(),
          };
          const token = await this.cryptoService.encrypt(payload);

          // Scanned documents that has selected from frontend
          const tenantScanedDocuments = files?.["tenantScanedDocuments"];

          const newScannedFileRecord: ScannedFileRecordJSON = {
            date: new Date().toISOString(),
            tenant: tenantUsername,
            token: token,
            files: [],
            folder: scannedDocumentPath,
          };

          if(Array.isArray(tenantScanedDocuments)) {
            tenantScanedDocuments?.forEach((doc) => {
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

          // Push scanned selected files into the insert array
          if(
            Array.isArray(newScannedFileRecord.files) &&
            newScannedFileRecord.files.length > 0
          ) {
            scannedDocuments.push(newScannedFileRecord);
          }

          if(
            !Array.isArray(scannedDocuments) ||
            scannedDocuments.length === 0
          ) {
            throw new Error(
              "No scanned identification document found. Please upload at least one document before submitting."
            );
          }

          // Runtime type guard for the FILE shape
          const isValidOldSignature = (obj: any): obj is FILE => {
            return obj &&
              typeof obj.fieldname === 'string' &&
              typeof obj.originalname === 'string' &&
              typeof obj.mimetype === 'string' &&
              typeof obj.size === 'number' &&
              typeof obj.filename === 'string' &&
              typeof obj.URL === 'string';
          };

          // ========== Tenant Signature ==========
          const tenantSignature = files?.["tenantSignature"]?.[0];

          let fallbackTenantSignature: FILE | undefined;

          if(!tenantSignature) {
            const rawTenantOld = req.body.tenantOldSignature;
            let parsedTenantOld: any;

            try {
              parsedTenantOld = JSON.parse(rawTenantOld);
            } catch(err) {
              throw new Error("Tenant old signature is not valid JSON.");
            }

            if(!isValidOldSignature(parsedTenantOld)) {
              throw new Error("Tenant signature is required!");
            }

            fallbackTenantSignature = parsedTenantOld;
          }

          const organizedTenantSignature: FILE = {
            fieldname: tenantSignature?.fieldname ?? fallbackTenantSignature?.fieldname ?? '',
            originalname: tenantSignature?.originalname ?? fallbackTenantSignature?.originalname ?? '',
            mimetype: tenantSignature?.mimetype ?? fallbackTenantSignature?.mimetype ?? '',
            size: tenantSignature?.size ?? fallbackTenantSignature?.size ?? 0,
            filename: tenantSignature?.filename ?? fallbackTenantSignature?.filename ?? '',
            URL: tenantSignature
              ? `${baseUrl}/lease/${leaseID}/signatures/tenant/${tenantSignature.filename}`
              : fallbackTenantSignature?.URL ?? '',
          };

          // ========== Landlord Signature ==========
          const landlordSignature = files?.["landlordSignature"]?.[0];

          let fallbackLandlordSignature: FILE | undefined;

          if(!landlordSignature) {
            const rawLandlordOld = req.body.landlordOldSignature;
            let parsedLandlordOld: any;

            try {
              parsedLandlordOld = JSON.parse(rawLandlordOld);
            } catch(err) {
              throw new Error("Landlord old signature is not valid JSON.");
            }

            if(!isValidOldSignature(parsedLandlordOld)) {
              throw new Error("Landlord signature is required!");
            }

            fallbackLandlordSignature = parsedLandlordOld;
          }

          const organizedLandlordSignature: FILE = {
            fieldname: landlordSignature?.fieldname ?? fallbackLandlordSignature?.fieldname ?? '',
            originalname: landlordSignature?.originalname ?? fallbackLandlordSignature?.originalname ?? '',
            mimetype: landlordSignature?.mimetype ?? fallbackLandlordSignature?.mimetype ?? '',
            size: landlordSignature?.size ?? fallbackLandlordSignature?.size ?? 0,
            filename: landlordSignature?.filename ?? fallbackLandlordSignature?.filename ?? '',
            URL: landlordSignature
              ? `${baseUrl}/lease/${leaseID}/signatures/landlord/${landlordSignature.filename}`
              : fallbackLandlordSignature?.URL ?? '',
          };
          // Assign value to schemas

          // Tenant information
          const UPDATE_DATA_TenantInformation: TenantInformation = {
            tenantUsername: tenantUsername,
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
            scannedDocuments: scannedDocuments,
          };

          // Co-Tenant information
          let UPDATE_DATA_coTenant: CoTenant | undefined = undefined;
          if(coTenantFullname) {
            UPDATE_DATA_coTenant = {
              fullName: coTenantFullname,
              email: coTenantEmail,
              phoneCode: coTenantPhoneCodeId,
              phoneNumber: coTenantPhoneNumber,
              gender: coTenantGender,
              nicOrPassport: coTenantNicOrPassport,
              age: coTenantAge,
              relationship: coTenantRelationship,
            };
          }

          // Lease agreement
          const UPDATE_DATA_leaseAgreement: LeaseAgreement = {
            startDate: startDate,
            endDate: endDate,
            durationMonths: durationMonths,
            monthlyRent: monthlyRent,
            currency: currency,
            paymentFrequency: paymentFrequency,
            paymentMethod: paymentMethod,
            securityDeposit: securityDeposit,
            rentDueDate: rentDueDate,
            latePaymentPenalties: selectedLatePaymentPenalties,
            utilityResponsibilities: selectedUtilityResponsibilities,
            noticePeriodDays: noticePeriodDays,
          };

          // Signature and important data
          const UPDATE_DATA_signatures: Signatures = {
            tenantSignature: organizedTenantSignature,
            landlordSignature: organizedLandlordSignature,
            signedAt: signedAt,
            ipAddress: ipAddress,
            userAgent: userAgent,
          };

          // Parent Lease document
          const UPDATE_DATA: LeasePayload = {
            leaseID: leaseID,
            tenantInformation: UPDATE_DATA_TenantInformation,
            coTenant: UPDATE_DATA_coTenant,
            propertyID: selectedProperty.id,
            leaseAgreement: UPDATE_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy: isReadTheCompanyPolicy,
            signatures: UPDATE_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          // Parent Lease document
          const UPDATE_DOCUMENT_DATA: LeasePayloadWithProperty = {
            leaseID: leaseID,
            tenantInformation: UPDATE_DATA_TenantInformation,
            coTenant: UPDATE_DATA_coTenant,
            property: selectedProperty,
            leaseAgreement: UPDATE_DATA_leaseAgreement,
            rulesAndRegulations: selectedRuleAndRegulations,
            isReadTheCompanyPolicy: isReadTheCompanyPolicy,
            signatures: UPDATE_DATA_signatures,
            systemMetadata: systemMetaData,
          };

          const today = new Date().toISOString()
            .replace(/[:.]/g, '-')    // Replace colon and dot with dashes
            .replace('T', '_')        // Replace 'T' with underscore
            .replace('Z', '');        // Remove 'Z' (optional)

          // Save in the localdirectory for creating a pdf
          const LEASE_AGREEMENT_JSON_DATA_FILE_PATH = path.join(
            __dirname,
            `../../public/lease/${leaseID}/agreement-data/${leaseID}.json`
          );

          const LEASE_AGREEMENT_JSON_DATA_FILE_OLD_PATH = path.join(
            __dirname,
            `../../public/lease/${leaseID}/agreement-data/old/${today}/${leaseID}.json`
          );

          if(fs.existsSync(LEASE_AGREEMENT_JSON_DATA_FILE_PATH)) {
            await fs.promises.mkdir(
              path.dirname(LEASE_AGREEMENT_JSON_DATA_FILE_OLD_PATH),
              {recursive: true}
            );

            await fs.promises.rename(
              LEASE_AGREEMENT_JSON_DATA_FILE_PATH,
              LEASE_AGREEMENT_JSON_DATA_FILE_OLD_PATH
            );
          }

          await fs.promises.mkdir(
            path.dirname(LEASE_AGREEMENT_JSON_DATA_FILE_PATH),
            {recursive: true}
          );
          await fs.promises.writeFile(
            LEASE_AGREEMENT_JSON_DATA_FILE_PATH,
            JSON.stringify(UPDATE_DOCUMENT_DATA, null, 2)
          );

          // Update lease agreement
          const leaseAgreement = await LeaseModel.updateOne({
            leaseID: leaseID,
          }, {
            $set: UPDATE_DATA,
          });


          if(leaseAgreement) {

            // Notify all admins about the new property added
            const notificationService = new NotificationService();

            // get the Socket.IO instance you attached in app.ts (this.app.set('io', this.io))
            const io = req.app.get('io') as import('socket.io').Server;


            await notificationService.createNotification(
              {
                title: 'Updated Lease Agreement',
                body: `Lease agreement has been updated successfully with ID: ${leaseID}. Please review and validate the agreement.`,
                type: 'lease',          // OK (your entity allows custom strings)
                severity: 'info',
                audience: {mode: 'user', usernames: [tenantUsername], roles: ['admin']}, // target the user
                channels: ['inapp', 'email'], // keep if you'll email later; harmless otherwise
                metadata: {leaseID: leaseID, tenant: tenantUsername, property: selectedProperty.id, agent: userAgent.username},
                // DO NOT send createdAt here; NotificationService sets it
              },
              // Real-time emit callback: send to each audience room
              (rooms, payload) => {
                rooms.forEach((room) => {
                  io.to(room).emit('notification.new', payload);
                });
              }
            );

            res.status(200).json({
              status: "success",
              message: "Agreement has been created successfully!",
              data: leaseAgreement,
            });
          } else {
            res.status(501).json({
              status: "error",
              message:
                "Agreement creation failed. Please try again later or contact support.",
            });
          }
        } catch(error) {
          console.log("Error in register lease agreement:", error);
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
    this.router.get("/lease-agreement-pdf/:leaseID/:type", async (req: Request, res: Response) => {
      try {
        const {leaseID, type} = req.params;
        if(!leaseID || !type) throw new Error("Missing parameters");

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
