// Path: src/services/lease/lease.service.ts
// =============================================================================
// LeaseService — Domain Service (DB + PDF composition helpers)
// -----------------------------------------------------------------------------
// PURPOSE
// - Encapsulate Lease CRUD, queries, and state transitions.
// - Provide helper methods to build "lease + property" DTOs for preview/PDF.
// - Keep controllers thin: controller validates HTTP and handles uploads.
// - exactOptionalPropertyTypes-safe:
//   - never set optional props to undefined
//   - use $unset to remove optional fields (or omit keys entirely)
// - 100% class-based (PropEase rule)
//
// IMPORTANT (FormData / multipart reality)
// - In PropEase, HTTP requests often arrive as multipart/form-data.
// - Controllers MUST parse JSON blocks + cast numeric fields BEFORE calling this service.
// - This service expects a proper LeasePayload (domain DTO), not raw req.body strings.
//
// IMPORTANT (Billing determinism)
// - rentAmount MUST be interpreted with rentBasis.
// - paymentFrequency defines invoice cadence.
// - rentDueDate defines due rule inside each billing cycle.
// - Without validating these, you can store a lease that cannot be charged correctly.
// =============================================================================

import ejs from "ejs";
import fs from "fs";
import os from "os";
import path from "path";
import * as puppeteer from "puppeteer";
import QRCode from "qrcode";
import { Types, type ClientSession, type FilterQuery } from "mongoose";

import { LeaseModel, type LeaseType } from "../../models/lease/lease.model";
import { PropertyModel, type IProperty } from "../../models/property.model";
import { USER_MODEL_PROJECTION, UserModel, type IUser } from "../../models/user.model";

import type { AuthUser, FileMetaPacket, PaginationMeta } from "../../types/common";

import type {
  LeasePayload,
  LeaseValidationStatus,
  ScannedFileRecordJSON,
  Signatures,
  TokenWiseData,

  // Canonical billing-contract types (from updated lease.types.ts)
  LeaseAgreement,
  RentBasis,
  PaymentFrequency,
} from "../../types/lease/lease.types";

import {
  VALIDATION_STATUSES,
  RENT_BASIS,
  PAYMENT_FREQUENCIES,
  RENT_DUE_RULES,
} from "../../types/lease/lease.types";

import { RecycleBinDomainDeleteService, type DomainDeletePlan } from "../recyclebin/recyclebin-domain-delete.service";
import type { RecycleRecordResult } from "../recyclebin/recyclebin-engine.service";

// NOTE: if you already have a "LeasePayloadWithProperty" in another place,
// move this type into contracts/types. For now it's service-local.
export type LeasePayloadWithProperty = LeasePayload & { property: IProperty };

// -----------------------------------------------------------------------------
// List contracts
// -----------------------------------------------------------------------------
export interface LeaseListQuery {
  page?: number;
  limit?: number;

  leaseID?: string;
  propertyID?: string;
  tenantUsername?: string;
  status?: LeaseValidationStatus;

  /**
   * Free-text search (conservative):
   * - leaseID
   * - propertyID
   * - tenantInformation.fullName
   * - tenantInformation.nicOrPassport
   */
  search?: string;
}

export interface LeaseListResult {
  items: LeasePayload[];
  pagination: PaginationMeta;
}

export interface LeaseListWithPropertyResult {
  items: LeasePayloadWithProperty[];
  pagination: PaginationMeta;
}

export interface PropertiesWithoutLeaseQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export interface PropertiesWithoutLeaseResult {
  items: IProperty[];
  pagination: PaginationMeta;
}

// -----------------------------------------------------------------------------
// PDF templates cache
// -----------------------------------------------------------------------------
interface PdfTemplatesCache {
  header: string;
  footer: string;
  main: string;
  logoBase64: string;
}

export class LeaseService {
  // ---------------------------------------------------------------------------
  // RecycleBin helper (domain delete)
  // ---------------------------------------------------------------------------
  private readonly deleteSvc = new RecycleBinDomainDeleteService();

  // ---------------------------------------------------------------------------
  // PDF engine (composition helper inside service — still no req/res)
  // ---------------------------------------------------------------------------
  private static puppeteerBrowser: puppeteer.Browser | null = null;

  private static cachedTemplates: PdfTemplatesCache = {
    header: "",
    footer: "",
    main: "",
    logoBase64: "",
  };

  private static templatesLoaded = false;

  public constructor() {}

  // -----------------------------------------------------------------------------
  // 01) CREATE / GET / UPDATE / DELETE
  // -----------------------------------------------------------------------------

  /**
   * Create a new Lease.
   *
   * Important:
   * - Validates the payload INCLUDING leaseAgreement (billing contract).
   * - Prevents ambiguous rent charging later.
   *
   * @param payload
   * - Expected: Fully-formed LeasePayload (NOT raw multipart/form-data strings).
   * - Controller MUST parse JSON blocks + cast numbers before calling this.
   */
  public async create(payload: LeasePayload): Promise<LeasePayload> {
    this.assertCreatePayload(payload);
    this.assertStatus(payload.systemMetadata.status);

    const created = await LeaseModel.create(payload);
    return this.toPayload(created);
  }

  /**
   * Get lease by business leaseID (not mongo _id).
   *
   * @param leaseID
   * - Expected: business lease identifier string
   */
  public async getByLeaseId(leaseID: string): Promise<LeasePayload | null> {
    const safeLeaseId = this.safeStr(leaseID);
    if (!safeLeaseId) return null;

    const doc = await LeaseModel.findOne({ leaseID: safeLeaseId }).exec();
    if (!doc) return null;

    return this.toPayload(doc);
  }

  /**
   * Get lease by Mongo ObjectId string.
   *
   * @param mongoId
   * - Expected: Mongo ObjectId string
   */
  public async getByMongoId(mongoId: string): Promise<LeasePayload | null> {
    const id = this.safeObjectId(mongoId);
    if (!id) return null;

    const doc = await LeaseModel.findById(id).exec();
    if (!doc) return null;

    return this.toPayload(doc);
  }

  /**
   * Full replace update by leaseID.
   *
   * Important:
   * - This is a full overwrite using $set: payload
   * - Validates entire payload including leaseAgreement.
   *
   * @param leaseID
   * - Expected: business lease identifier string
   *
   * @param payload
   * - Expected: Fully-formed LeasePayload (NOT raw multipart/form-data strings).
   */
  public async updateFullByLeaseId(leaseID: string, payload: LeasePayload): Promise<LeasePayload | null> {
    const safeLeaseId = this.safeStr(leaseID);
    if (!safeLeaseId) return null;

    this.assertCreatePayload(payload);
    this.assertStatus(payload.systemMetadata.status);

    const updated = await LeaseModel.findOneAndUpdate(
      { leaseID: safeLeaseId },
      { $set: payload },
      { new: true }
    ).exec();

    if (!updated) return null;
    return this.toPayload(updated);
  }

  /**
   * Patch update by leaseID.
   *
   * exactOptionalPropertyTypes-safe:
   * - We only $set keys that exist (never assign undefined).
   * - We $unset keys only when caller explicitly requests clearing via null.
   *
   * NOTE:
   * - We allow `coTenant: null` as an explicit "remove" signal from UI.
   *
   * @param leaseID
   * - Expected: business lease identifier string
   *
   * @param patch
   * - Expected: partial LeasePayload keys (domain-level patch), not raw FormData.
   */
  public async patchByLeaseId(
    leaseID: string,
    patch: Partial<LeasePayload> & { coTenant?: LeasePayload["coTenant"] | null }
  ): Promise<LeasePayload | null> {
    const safeLeaseId = this.safeStr(leaseID);
    if (!safeLeaseId) return null;

    const status = patch.systemMetadata?.status;
    if (status) this.assertStatus(status);

    // If leaseAgreement is included in patch, validate the contract block.
    if (patch.leaseAgreement) {
      this.assertLeaseAgreement(patch.leaseAgreement);
    }

    const updateDoc = this.buildUpdateDoc(patch);

    const updated = await LeaseModel.findOneAndUpdate(
      { leaseID: safeLeaseId },
      updateDoc,
      { new: true }
    ).exec();

    if (!updated) return null;
    return this.toPayload(updated);
  }

  /**
   * Hard delete (DB only).
   * WARNING:
   * - Prefer deleteLeaseByLeaseId() which integrates RecycleBin + snapshot + file move.
   *
   * @param leaseID
   * - Expected: business lease identifier string
   */
  public async deleteByLeaseId(leaseID: string): Promise<boolean> {
    const safeLeaseId = this.safeStr(leaseID);
    if (!safeLeaseId) return false;

    const res = await LeaseModel.deleteOne({ leaseID: safeLeaseId }).exec();
    return (res.deletedCount ?? 0) > 0;
  }

  // -----------------------------------------------------------------------------
  // 02) LIST + COUNT (generic)
  // -----------------------------------------------------------------------------

  /**
   * List leases with pagination.
   *
   * Usage keys:
   * - page/limit => pagination
   * - leaseID/propertyID => exact match filters
   * - tenantUsername => matches tenantInformation.tenantUsername
   * - status => matches systemMetadata.status
   * - search => regex OR filter across several fields (conservative)
   */
  public async list(query: LeaseListQuery): Promise<LeaseListResult> {
    const page = this.safePage(query.page);
    const limit = this.safeLimit(query.limit);

    const filter = this.buildFilter(query);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      LeaseModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<(LeasePayload & { _id: Types.ObjectId })[]>()
        .exec(),
      LeaseModel.countDocuments(filter).exec(),
    ]);

    return {
      items: items.map((x) => this.toPayloadLean(x)),
      pagination: { total, page, limit },
    };
  }

  /**
   * List leases belonging to a tenant by username.
   * - Safe wrapper around list().
   */
  public async listByTenantUsername(username: string, page?: number, limit?: number): Promise<LeaseListResult> {
    const safeUsername = this.safeStr(username);

    if (!safeUsername) {
      return {
        items: [],
        pagination: {
          total: 0,
          page: 1,
          limit: this.safeLimit(limit),
        },
      };
    }

    const query: LeaseListQuery = {
      tenantUsername: safeUsername,
      ...(typeof page === "number" ? { page } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    };

    return this.list(query);
  }

  /**
   * Count leases matching filters.
   */
  public async count(query: LeaseListQuery): Promise<number> {
    const filter = this.buildFilter(query);
    return LeaseModel.countDocuments(filter).exec();
  }

  /**
   * Count all leases.
   */
  public async countAll(): Promise<number> {
    return LeaseModel.countDocuments({}).exec();
  }

  // -----------------------------------------------------------------------------
  // 03) STATUS TRANSITION
  // -----------------------------------------------------------------------------

  /**
   * Set workflow status.
   *
   * Key usage:
   * - status: new lifecycle state (must be within VALIDATION_STATUSES)
   * - statusNote: optional explanation; if empty => removed via $unset
   * - actorUsername: optional; used for audit trail
   */
  public async setStatus(
    leaseID: string,
    status: LeaseValidationStatus,
    statusNote?: string,
    actorUsername?: string
  ): Promise<LeasePayload | null> {
    const safeLeaseId = this.safeStr(leaseID);
    if (!safeLeaseId) return null;

    this.assertStatus(status);

    const nowIso = new Date().toISOString();

    const $set: Record<string, unknown> = {
      "systemMetadata.status": status,
      "systemMetadata.lastUpdated": nowIso,
    };

    if (actorUsername) {
      $set["systemMetadata.lastUpdatedByUsername"] = actorUsername;
    }

    const update: Record<string, unknown> = { $set };

    // statusNote: if provided and non-empty => set, else => unset
    if (typeof statusNote === "string" && statusNote.trim().length > 0) {
      $set["systemMetadata.statusNote"] = statusNote.trim();
    } else {
      update.$unset = { "systemMetadata.statusNote": 1 };
    }

    const updated = await LeaseModel.findOneAndUpdate(
      { leaseID: safeLeaseId },
      update,
      { new: true }
    ).exec();

    if (!updated) return null;
    return this.toPayload(updated);
  }

  // -----------------------------------------------------------------------------
  // 04) SIGNATURES PATCH (tenant/landlord signatures are optional)
  // -----------------------------------------------------------------------------

  /**
   * Patch signatures.
   *
   * Key usage:
   * - patch.tenantSignature => set if provided
   * - patch.landlordSignature => set if provided
   * - actorUsername => updates lastUpdatedByUsername
   *
   * NOTE:
   * - This method DOES NOT remove signatures (no null support here).
   *   If you want removal support, add explicit null + $unset policy.
   */
  public async setSignatures(
    leaseID: string,
    patch: Partial<Signatures>,
    actorUsername?: string
  ): Promise<LeasePayload | null> {
    const safeLeaseId = this.safeStr(leaseID);
    if (!safeLeaseId) return null;

    const nowIso = new Date().toISOString();

    const $set: Record<string, unknown> = {
      "systemMetadata.lastUpdated": nowIso,
    };

    if (actorUsername) {
      $set["systemMetadata.lastUpdatedByUsername"] = actorUsername;
    }

    // Only set provided packets (omit undefined => exactOptionalPropertyTypes-safe)
    if (patch.tenantSignature) {
      $set["signatures.tenantSignature"] = patch.tenantSignature;
    }
    if (patch.landlordSignature) {
      $set["signatures.landlordSignature"] = patch.landlordSignature;
    }

    const updated = await LeaseModel.findOneAndUpdate(
      { leaseID: safeLeaseId },
      { $set },
      { new: true }
    ).exec();

    if (!updated) return null;
    return this.toPayload(updated);
  }

  // -----------------------------------------------------------------------------
  // 05) DELETE LEASE DOCUMENT BY LEASE ID (RecycleBin-backed)
  // -----------------------------------------------------------------------------

  /**
   * Delete lease by leaseID with RecycleBin snapshot + file handling.
   *
   * Key usage:
   * - actor: authenticated user snapshot stored in recycle record
   * - filePackets: original file packets that should be moved to recyclebin mirror tree
   */
  public async deleteLeaseByLeaseId(
    leaseId: string,
    actor: AuthUser,
    filePackets: FileMetaPacket[]
  ): Promise<RecycleRecordResult | null> {
    try {
      const safeLeaseId = typeof leaseId === "string" ? leaseId.trim() : "";
      if (!safeLeaseId) throw new Error("Invalid lease id");
      if (!actor) throw new Error("Invalid auth user!");
      if (!Array.isArray(filePackets)) throw new Error("Lease documents are invalid!");

      const leaseDoc = await LeaseModel
        .findOne({ leaseID: safeLeaseId })
        .lean<LeasePayload>()
        .exec();

      if (!leaseDoc) throw new Error("Cannot find the lease document under lease Id that provided!");

      const snapshotData: Record<string, unknown> = {
        lease: leaseDoc,
        restoreHints: { leaseId: leaseDoc.leaseID },
      };

      const plan: DomainDeletePlan<LeasePayload> = {
        sourceKey: "lease",
        refId: leaseDoc.leaseID,
        label: `Lease: ${leaseDoc.leaseID}`,
        description: "Deleted from Lease Management",
        snapshotData,
        files: filePackets,

        // These fields exist in your DomainDeletePlan (as shown earlier in your snippet)
        module: "Lease Management",
        entity: "Lease",
        tags: ["lease", "delete"],

        deleteDbRecord: async (session: ClientSession): Promise<void> => {
          await LeaseModel.deleteOne({ leaseID: leaseDoc.leaseID }, { session }).exec();
        },
      };

      const result = await this.deleteSvc.deleteWithRecycleBin(actor, plan);
      return result.entry;
    } catch (error) {
      console.error("[Error:] [Lease Service] failed to delete lease by lease ID!\n", error, "\n");
      return null;
    }
  }

  // -----------------------------------------------------------------------------
  // 06) APPEND SCANNED DOCUMENTS (tenantInformation.scannedDocuments)
  // -----------------------------------------------------------------------------

  /**
   * Append scanned documents to tenantInformation.scannedDocuments.
   *
   * Key usage:
   * - files: FileMetaPacket[] evidence
   * - token: grouping key (scan session token); if not provided => generated token
   * - actorUsername: updates systemMetadata.lastUpdatedByUsername
   */
  public async appendScannedDocuments(
    leaseID: string,
    tenantUsername: string,
    files: FileMetaPacket[],
    token?: string,
    actorUsername?: string
  ): Promise<LeasePayload | null> {
    const safeLeaseId = this.safeStr(leaseID);
    const safeTenant = this.safeStr(tenantUsername);
    if (!safeLeaseId || !safeTenant) return null;

    const safeFiles = Array.isArray(files) ? files.filter(Boolean) : [];
    if (safeFiles.length === 0) return this.getByLeaseId(safeLeaseId);

    const nowIso = new Date().toISOString();
    const genToken = this.safeStr(token) || `manual-upload-${Date.now()}`;

    const tokenWise: TokenWiseData[] = safeFiles.map((pkt) => ({
      ageInMinutes: 0,
      file: pkt,
    }));

    const record: ScannedFileRecordJSON = {
      date: nowIso,
      tenant: safeTenant,
      token: genToken,
      files: tokenWise,
    };

    const $set: Record<string, unknown> = {
      "systemMetadata.lastUpdated": nowIso,
    };

    if (actorUsername) {
      $set["systemMetadata.lastUpdatedByUsername"] = actorUsername;
    }

    const updated = await LeaseModel.findOneAndUpdate(
      { leaseID: safeLeaseId },
      {
        $set,
        $push: { "tenantInformation.scannedDocuments": record },
      },
      { new: true }
    ).exec();

    if (!updated) return null;
    return this.toPayload(updated);
  }

  // -----------------------------------------------------------------------------
  // 07) TENANT LOOKUP (router ref: GET /get-tenant-by-username/:username)
  // -----------------------------------------------------------------------------

  /**
   * Lookup a tenant user record by username.
   */
  public async getTenantByUsername(username: string): Promise<IUser | null> {
    const safeUsername = this.safeStr(username);
    if (!safeUsername) return null;

    const doc = await UserModel.findOne({ username: safeUsername }, USER_MODEL_PROJECTION).lean<IUser>().exec();
    return doc ?? null;
  }

  // -----------------------------------------------------------------------------
  // 08) PROPERTIES WITHOUT LEASE
  // -----------------------------------------------------------------------------

  /**
   * List properties that do not have leases yet.
   */
  public async getPropertiesWithoutLease(query: PropertiesWithoutLeaseQuery): Promise<PropertiesWithoutLeaseResult> {
    const page = this.safePage(query.page);
    const limit = this.safeLimit(query.limit);
    const skip = (page - 1) * limit;

    const leasedPropertyIds = await LeaseModel.distinct("propertyID").exec();

    const safeSearch = this.safeStr(query.search);
    const propertyFilter: FilterQuery<IProperty> = {
      id: { $nin: leasedPropertyIds },
    };

    if (safeSearch) {
      propertyFilter.$or = [
        { id: { $regex: safeSearch, $options: "i" } },
        { title: { $regex: safeSearch, $options: "i" } },
        { city: { $regex: safeSearch, $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      PropertyModel.find(propertyFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<IProperty[]>()
        .exec(),
      PropertyModel.countDocuments(propertyFilter).exec(),
    ]);

    return {
      items,
      pagination: { total, page, limit },
    };
  }

  public async countPropertiesWithoutLease(): Promise<number> {
    const leasedPropertyIds = await LeaseModel.distinct("propertyID").exec();
    return PropertyModel.countDocuments({ id: { $nin: leasedPropertyIds } }).exec();
  }

  // -----------------------------------------------------------------------------
  // 09) LEASE WITH PROPERTY (preview + pdf)
  // -----------------------------------------------------------------------------

  /**
   * Build a combined DTO (lease + property) for UI preview / PDF composition.
   */
  public async getLeaseWithProperty(leaseID: string): Promise<LeasePayloadWithProperty | null> {
    const safeLeaseId = this.safeStr(leaseID);
    if (!safeLeaseId) return null;

    const lease = await LeaseModel.findOne({ leaseID: safeLeaseId }).lean<LeasePayload>().exec();
    if (!lease) return null;

    const property = await PropertyModel.findOne({ id: lease.propertyID }).lean<IProperty>().exec();
    if (!property) return null;

    return { ...lease, property };
  }

  // -----------------------------------------------------------------------------
  // 10) PDF GENERATION (puppeteer + EJS + header/footer + QR)
  // -----------------------------------------------------------------------------

  /**
   * Generate lease agreement PDF bytes (Buffer).
   */
  public async generateLeasePdfBuffer(options: {
    leaseID: string;
    templateRootAbs?: string;
    logoAbsPath?: string;
  }): Promise<Buffer> {
    const safeLeaseId = this.safeStr(options.leaseID);
    if (!safeLeaseId) throw new Error("leaseID is required");

    const leaseWithProperty = await this.getLeaseWithProperty(safeLeaseId);
    if (!leaseWithProperty) throw new Error("Lease or property not found");

    await this.ensurePdfTemplatesLoaded(options.templateRootAbs, options.logoAbsPath);

    if (!LeaseService.cachedTemplates.main || !LeaseService.cachedTemplates.header || !LeaseService.cachedTemplates.footer) {
      throw new Error("PDF templates not loaded. Check template paths.");
    }

    const html = await ejs.render(LeaseService.cachedTemplates.main, { data: leaseWithProperty });

    const header = await ejs.render(LeaseService.cachedTemplates.header, {
      logoSrc: `data:image/png;base64,${LeaseService.cachedTemplates.logoBase64}`,
      companyName: "PropEase Real Estate",
    });

    const footer = await ejs.render(LeaseService.cachedTemplates.footer, {
      qrCodeSrc: await this.generateQrDataUrl(safeLeaseId),
    });

    const browser = await this.getBrowser();
    const page = await browser.newPage();

    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("screen");

    const pdfBytes = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: header,
      footerTemplate: footer,
      margin: { top: "150px", bottom: "150px" },
      preferCSSPageSize: true,
    });

    await page.close();

    return Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);
  }

  // =============================================================================
  // INTERNAL HELPERS (Validation + Mapping)
  // =============================================================================

  private assertCreatePayload(payload: LeasePayload): void {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid lease payload");
    }

    if (!this.safeStr(payload.leaseID)) {
      throw new Error("leaseID is required");
    }

    if (!this.safeStr(payload.propertyID)) {
      throw new Error("propertyID is required");
    }

    if (!payload.tenantInformation || typeof payload.tenantInformation !== "object") {
      throw new Error("tenantInformation is required");
    }

    if (!this.safeStr(payload.tenantInformation.tenantUsername)) {
      throw new Error("tenantInformation.tenantUsername is required");
    }

    if (!payload.leaseAgreement || typeof payload.leaseAgreement !== "object") {
      throw new Error("leaseAgreement is required");
    }
    this.assertLeaseAgreement(payload.leaseAgreement);

    if (!payload.systemMetadata || typeof payload.systemMetadata !== "object") {
      throw new Error("systemMetadata is required");
    }

    if (!this.safeStr(payload.systemMetadata.createdByUsername)) {
      throw new Error("systemMetadata.createdByUsername is required");
    }

    if (!this.safeStr(payload.systemMetadata.createdAt)) {
      throw new Error("systemMetadata.createdAt is required");
    }

    if (!this.safeStr(payload.systemMetadata.lastUpdatedByUsername)) {
      throw new Error("systemMetadata.lastUpdatedByUsername is required");
    }

    if (!this.safeStr(payload.systemMetadata.lastUpdated)) {
      throw new Error("systemMetadata.lastUpdated is required");
    }
  }

  /**
   * LeaseAgreement validator (billing determinism).
   *
   * IMPORTANT:
   * - paymentMethod REMOVED from canonical LeaseAgreement.
   * - Payment method details belong to Payment module, not Lease.
   */
  private assertLeaseAgreement(agreement: LeaseAgreement): void {
    if (!agreement || typeof agreement !== "object") {
      throw new Error("leaseAgreement is required");
    }

    if (typeof agreement.rentAmount !== "number" || !Number.isFinite(agreement.rentAmount)) {
      throw new Error("leaseAgreement.rentAmount must be a finite number");
    }
    if (agreement.rentAmount <= 0) {
      throw new Error("leaseAgreement.rentAmount must be > 0");
    }

    if (!agreement.currencyFormat || typeof agreement.currencyFormat !== "object") {
      throw new Error("leaseAgreement.currencyFormat is required");
    }
    if (!this.safeStr(agreement.currencyFormat.currency)) {
      throw new Error("leaseAgreement.currencyFormat.currency is required");
    }
    if (!this.safeStr(agreement.currencyFormat.symbol)) {
      throw new Error("leaseAgreement.currencyFormat.symbol is required");
    }

    this.assertRentBasis(agreement.rentBasis);
    this.assertPaymentFrequency(agreement.paymentFrequency);
    this.assertRentDueDate(agreement.rentDueDate);

    const start = this.parseIsoDateOrThrow(agreement.leaseStartDate, "leaseAgreement.leaseStartDate");
    const end = this.parseIsoDateOrThrow(agreement.leaseEndDate, "leaseAgreement.leaseEndDate");
    if (end.getTime() <= start.getTime()) {
      throw new Error("leaseAgreement.leaseEndDate must be after leaseStartDate");
    }

    if (!agreement.noticePeriod || typeof agreement.noticePeriod !== "object") {
      throw new Error("leaseAgreement.noticePeriod is required");
    }

    if (!agreement.securityDeposit || typeof agreement.securityDeposit !== "object") {
      throw new Error("leaseAgreement.securityDeposit is required");
    }
    if (typeof agreement.securityDeposit.amount !== "number" || agreement.securityDeposit.amount < 0) {
      throw new Error("leaseAgreement.securityDeposit.amount must be >= 0");
    }

    if (!agreement.latePaymentPenalty || typeof agreement.latePaymentPenalty !== "object") {
      throw new Error("leaseAgreement.latePaymentPenalty is required");
    }
    if (typeof agreement.latePaymentPenalty.penaltyValue !== "number" || agreement.latePaymentPenalty.penaltyValue < 0) {
      throw new Error("leaseAgreement.latePaymentPenalty.penaltyValue must be >= 0");
    }

    if (!agreement.utilitiesResponsibility || typeof agreement.utilitiesResponsibility !== "object") {
      throw new Error("leaseAgreement.utilitiesResponsibility is required");
    }
    if (!Array.isArray(agreement.utilitiesResponsibility.utilities)) {
      throw new Error("leaseAgreement.utilitiesResponsibility.utilities must be an array");
    }
  }

  private assertStatus(status: string): void {
    const safe = this.safeStr(status);
    if (!safe) throw new Error("Lease status is required");

    const ok = (VALIDATION_STATUSES as readonly string[]).includes(safe);
    if (!ok) {
      throw new Error(`Invalid lease validation status: ${safe}`);
    }
  }

  private assertRentBasis(rentBasis: RentBasis): void {
    const safe = this.safeStr(String(rentBasis));
    if (!safe) throw new Error("leaseAgreement.rentBasis is required");

    const ok = (RENT_BASIS as readonly string[]).includes(safe);
    if (!ok) {
      throw new Error(`Invalid leaseAgreement.rentBasis: ${safe}`);
    }
  }

  private assertPaymentFrequency(paymentFrequency: PaymentFrequency): void {
    const safe = this.safeStr(String(paymentFrequency));
    if (!safe) throw new Error("leaseAgreement.paymentFrequency is required");

    const ok = (PAYMENT_FREQUENCIES as readonly string[]).includes(safe);
    if (!ok) {
      throw new Error(`Invalid leaseAgreement.paymentFrequency: ${safe}`);
    }
  }

  private assertRentDueDate(rentDueDate: LeaseAgreement["rentDueDate"]): void {
    if (!rentDueDate || typeof rentDueDate !== "object") {
      throw new Error("leaseAgreement.rentDueDate is required");
    }

    const rule = this.safeStr(String(rentDueDate.rule));
    if (!rule) throw new Error("leaseAgreement.rentDueDate.rule is required");

    const ok = (RENT_DUE_RULES as readonly string[]).includes(rule);
    if (!ok) {
      throw new Error(`Invalid leaseAgreement.rentDueDate.rule: ${rule}`);
    }

    if (rule === "day_of_cycle") {
      const d = rentDueDate.dueDayOfCycle;
      if (typeof d !== "number" || !Number.isFinite(d) || d < 1 || d > 31) {
        throw new Error("leaseAgreement.rentDueDate.dueDayOfCycle must be an integer between 1 and 31 (required for day_of_cycle)");
      }
    }
  }

  private buildFilter(query: LeaseListQuery): FilterQuery<LeaseType> {
    const filter: FilterQuery<LeaseType> = {};

    const leaseID = this.safeStr(query.leaseID);
    if (leaseID) filter.leaseID = leaseID;

    const propertyID = this.safeStr(query.propertyID);
    if (propertyID) filter.propertyID = propertyID;

    const tenantUsername = this.safeStr(query.tenantUsername);
    if (tenantUsername) filter["tenantInformation.tenantUsername"] = tenantUsername;

    const status = this.safeStr(query.status);
    if (status) filter["systemMetadata.status"] = status;

    const search = this.safeStr(query.search);
    if (search) {
      filter.$or = [
        { leaseID: { $regex: search, $options: "i" } },
        { propertyID: { $regex: search, $options: "i" } },
        { "tenantInformation.fullName": { $regex: search, $options: "i" } },
        { "tenantInformation.nicOrPassport": { $regex: search, $options: "i" } },
      ];
    }

    return filter;
  }

  private buildUpdateDoc(
    patch: Partial<LeasePayload> & { coTenant?: LeasePayload["coTenant"] | null }
  ): Record<string, unknown> {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, unknown> = {};

    if (patch.propertyID) $set.propertyID = patch.propertyID;
    if (typeof patch.isReadTheCompanyPolicy === "boolean") $set.isReadTheCompanyPolicy = patch.isReadTheCompanyPolicy;
    if (Array.isArray(patch.rulesAndRegulations)) $set.rulesAndRegulations = patch.rulesAndRegulations;

    if (patch.tenantInformation) {
      $set.tenantInformation = patch.tenantInformation;
    }

    if (patch.coTenant) {
      $set.coTenant = patch.coTenant;
    } else if (patch.coTenant === null) {
      $unset.coTenant = 1;
    }

    if (patch.leaseAgreement) {
      $set.leaseAgreement = patch.leaseAgreement;
    }

    if (patch.signatures) {
      $set.signatures = patch.signatures;
    }

    if (patch.systemMetadata) {
      $set.systemMetadata = patch.systemMetadata;
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;

    if (!update.$set && !update.$unset) {
      update.$set = { "systemMetadata.lastUpdated": new Date().toISOString() };
    }

    return update;
  }

  private toPayload(doc: LeaseType): LeasePayload {
    const obj = doc.toObject() as LeasePayload & { _id?: unknown; __v?: unknown };
    const { _id: _ignoredId, __v: _ignoredV, ...rest } = obj;
    return rest;
  }

  private toPayloadLean(doc: LeasePayload & { _id: Types.ObjectId }): LeasePayload {
    const { _id: _ignored, ...payload } = doc;
    return payload;
  }

  // =============================================================================
  // Primitive helpers
  // =============================================================================

  private safeStr(v: unknown): string {
    if (typeof v !== "string") return "";
    return v.trim();
  }

  private parseIsoDateOrThrow(v: unknown, field: string): Date {
    const s = this.safeStr(v);
    if (!s) throw new Error(`${field} is required`);

    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) {
      throw new Error(`${field} must be a valid ISO date string`);
    }
    return d;
  }

  private safeObjectId(v: unknown): Types.ObjectId | null {
    const s = this.safeStr(v);
    if (!s) return null;
    if (!Types.ObjectId.isValid(s)) return null;
    return new Types.ObjectId(s);
  }

  private safePage(v: unknown): number {
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.floor(n);
  }

  private safeLimit(v: unknown): number {
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    if (!Number.isFinite(n) || n <= 0) return 10;
    return Math.min(100, Math.floor(n));
  }

  // =============================================================================
  // PDF internal helpers
  // =============================================================================

  private async ensurePdfTemplatesLoaded(templateRootAbs?: string, logoAbsPath?: string): Promise<void> {
    if (LeaseService.templatesLoaded) return;

    try {
      const baseDir = templateRootAbs ?? path.join(__dirname, "../../../public/view/leaseDocumentTemplates/");
      const logoPath = logoAbsPath ?? path.join(__dirname, "../../../public/companyData/images/PropEase.png");

      LeaseService.cachedTemplates = {
        header: fs.readFileSync(path.join(baseDir, "header.ejs"), "utf8"),
        footer: fs.readFileSync(path.join(baseDir, "footer.ejs"), "utf8"),
        main: fs.readFileSync(path.join(baseDir, "lease-agreement-pdf.ejs"), "utf8"),
        logoBase64: fs.readFileSync(logoPath).toString("base64"),
      };

      LeaseService.templatesLoaded = true;
    } catch (err: unknown) {
      console.error("[Error:] [LeaseService] PDF template preload failed.\n", err, "\n");
      LeaseService.cachedTemplates = { header: "", footer: "", main: "", logoBase64: "" };
      LeaseService.templatesLoaded = false;
      throw new Error("Failed to load lease PDF templates. Check template paths.");
    }
  }

  private async getBrowser(): Promise<puppeteer.Browser> {
    if (LeaseService.puppeteerBrowser && LeaseService.puppeteerBrowser.isConnected()) {
      return LeaseService.puppeteerBrowser;
    }

    const launchOptions: puppeteer.LaunchOptions = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    };

    const chromePath = this.tryResolveChromePath();
    if (chromePath) launchOptions.executablePath = chromePath;

    LeaseService.puppeteerBrowser = await puppeteer.launch(launchOptions);
    return LeaseService.puppeteerBrowser;
  }

  private tryResolveChromePath(): string | undefined {
    const platform = os.platform();

    if (platform === "win32") {
      const paths = [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ];
      return paths.find((p) => fs.existsSync(p));
    }

    if (platform === "darwin") {
      const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      return fs.existsSync(mac) ? mac : undefined;
    }

    if (platform === "linux") {
      const linux = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
      return linux.find((p) => fs.existsSync(p));
    }

    return undefined;
  }

  private async generateQrDataUrl(text: string): Promise<string> {
    return QRCode.toDataURL(text, { errorCorrectionLevel: "M" });
  }
}