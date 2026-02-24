// Path: src/api/tenants.router.ts
// ============================================================================
// Tenants API (PropEase) — UPGRADED (FileUploader + correct RecycleBin leasing)
// ----------------------------------------------------------------------------
// Key upgrades
// ✅ Uses FileUploader helper for complaint uploads (max 20 files, 20MB each)
// ✅ Delete tenant records tenant + leases DB snapshot AND moves BOTH tenant + lease folders
// ✅ Lease files are NOT forced under tenant folder (restore-safe via restoreHints.leaseRootsById)
// ✅ Keeps everything class-based, no free helper functions
// ✅ Uses ApiResponseBuilder and avoids passing undefined in optionals
// ============================================================================

import express, { type Request, type Response, type Router, type RequestHandler } from "express";
import fs from "fs";
import path from "path";
import { type ClientSession, type FilterQuery } from "mongoose";

import {
  COMPLAINT_CATEGORIES,
  ComplaintModel,
  type IComplaint,
} from "../models/complaint.model";
import { LeaseModel, LeasePayload } from "../models/lease.model";
import { TenantModel, type ITenant } from "../models/tenant.model";
import { USER_MODEL_PROJECTION, UserModel, type User } from "../models/user.model";

import { ApiGuardExport } from "../guard/api-router.guard";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";

import type { AuthUser } from "../types/common";
import type { FileMetaPacket, PaginationMeta } from "../types/common";

import { FileMetaPacketBuilder } from "../utils/files/file-meta-packet.builder";
import FileUploader, { type UploadResultPacket } from "../utils/files/file-uploader.helper";

import { RecycleBinDomainDeleteService, type DomainDeletePlan } from "../services/recyclebin/recyclebin-domain-delete.service";

import { NotificationHubEngineService } from "../services/notifications/notification-hub-engine.service";
import type { NotificationActorDto } from "../types/notification/notification.types";

export default class Tenant {
  // ---------------------------------------------------------------------------
  // Engines
  // ---------------------------------------------------------------------------
  private readonly notificationHub: NotificationHubEngineService = new NotificationHubEngineService();
  private readonly deleteSvc: RecycleBinDomainDeleteService = new RecycleBinDomainDeleteService();

  // ---------------------------------------------------------------------------
  // Express
  // ---------------------------------------------------------------------------
  private readonly router: Router = express.Router();

  public get route(): Router {
    return this.router;
  }

  // ---------------------------------------------------------------------------
  // Public roots (Electron-safe)
  // ---------------------------------------------------------------------------
  private readonly PUBLIC_ROOT = path.resolve( __dirname, "../../public" );

  // NOTE:
  // - FileUploader stores under: /public/uploads/...
  // - RecycleBinEngine stores under: /public/recyclebin/...
  private readonly TENANT_UPLOAD_ROOT_REL = "uploads/tenants";
  private readonly LEASES_UPLOAD_ROOT_REL = "uploads/leases";

  // ---------------------------------------------------------------------------
  // Upload policy (requested)
  // ---------------------------------------------------------------------------
  private readonly MAX_FILE_MB = 20;
  private readonly MAX_FILES_TOTAL = 20; // for complaint attachments

  // ---------------------------------------------------------------------------
  // Allowed types
  // ---------------------------------------------------------------------------
  private readonly allowFileTypes: ReadonlySet<string> = new Set( [
    // images
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "image/webp",
    "image/svg+xml",
    "image/avif",
    "image/heic",
    // docs
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "text/plain",
  ] );

  public constructor () {
    this.insertTenant();
    this.getAllTenants();
    this.getAllTenantsCount();
    this.getAllTenantsWithPagination();
    this.getAllNoneTenantWithPagination();
    this.getAllNoneTenantCount();

    this.deleteTenant();

    this.createComplaint();
    this.getComplaintById();
    this.getAllComplaintsByTenantUsername();
    this.getAllComplaintsCountByTenantUsername();
    this.getAllComplaints();
    this.getAllComplaintsByStatus();
    this.getAllComplaintsCountByStatus();
    this.getAllComplaintsCount();
    this.getAllComplaintsBySection();
  }

  // ===========================================================================
  // Small helpers (class-only)
  // ===========================================================================

  private isStr( v: unknown ): v is string {
    return typeof v === "string";
  }

  private s( v: unknown ): string {
    return this.isStr( v ) ? v.trim() : "";
  }

  private safeInt( v: unknown, fallback: number, min: number, max: number ): number {
    const n = Number( String( v ?? "" ).trim() );
    if ( !Number.isFinite( n ) ) return fallback;
    const x = Math.floor( n );
    if ( x < min ) return min;
    if ( x > max ) return max;
    return x;
  }

  private ensureStartsWithPublic( rel: string ): string {
    const r = String( rel ?? "" ).replace( /\\/g, "/" ).replace( /^\/+/, "" );
    return r.startsWith( "public/" ) ? r : `public/${ r }`;
  }

  private async safeRmAbs( absPath: string ): Promise<void> {
    // Safe delete only inside /public
    const root = path.resolve( this.PUBLIC_ROOT );
    const target = path.resolve( absPath );

    if ( !target.startsWith( root ) ) {
      // do NOT delete outside public
      return;
    }

    await fs.promises.rm( target, { recursive: true, force: true } );
  }

  private isValidCategory( cat: string ): boolean {
    return ( COMPLAINT_CATEGORIES as readonly string[] ).includes( cat );
  }

  private isValidPriority( p: string ): boolean {
    return [ "low", "medium", "high", "urgent" ].includes( p );
  }

  private generateCode(): string {
    const ts = Date.now().toString( 36 ).toUpperCase();
    const rnd = Math.random().toString( 36 ).substring( 2, 8 ).toUpperCase();
    return `PROPEASE-CPL-${ ts }-${ rnd }`;
  }

  private buildNotificationActor( author: AuthUser ): NotificationActorDto {
    const base: NotificationActorDto = {
      userId: String( author.userId ),
      username: String( author.username ),
      role: author.role,
      branchId: author.branchId ?? "",
      teamCodes: author.teamCodes ?? [],
    };
    return base;
  }

  // ===========================================================================
  // POST /insertTenant
  // (kept mostly as-is, no file uploads here)
  // ===========================================================================
  private insertTenant(): void {
    this.router.post( "/insertTenant", express.urlencoded( { extended: true } ), async ( req: Request, res: Response ) => {
      try {
        const author: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
        if ( !author ) {
          ApiResponseBuilder.conflict( res, "Invalid author!" );
          return;
        }

        const username = this.s( req.body?.username );
        const name = this.s( req.body?.name );
        const image = this.s( req.body?.image );
        const phoneNumber = this.s( req.body?.phoneNumber );
        const email = this.s( req.body?.email );
        const gender = this.s( req.body?.gender );
        const addedBy = this.s( req.body?.addedBy );

        if ( !username ) { ApiResponseBuilder.validationError( res, "Username is required!" ); return; }
        if ( !name ) { ApiResponseBuilder.validationError( res, "Name required!" ); return; }
        if ( !image ) { ApiResponseBuilder.validationError( res, "Image required!" ); return; }
        if ( !phoneNumber ) { ApiResponseBuilder.validationError( res, "Phone number required!" ); return; }
        if ( !email ) { ApiResponseBuilder.validationError( res, "Email required!" ); return; }
        if ( !gender ) { ApiResponseBuilder.validationError( res, "Gender required!" ); return; }
        if ( !addedBy ) { ApiResponseBuilder.validationError( res, "Added by required!" ); return; }

        const tenantDoc: ITenant = new TenantModel( {
          username,
          image,
          name,
          contactNumber: phoneNumber,
          email,
          gender,
          addedBy,
        } );

        await ( tenantDoc as any ).save?.();

        // notify (best-effort)
        try {
          const actor = this.buildNotificationActor( author );

          this.notificationHub.emit( {
            eventKey: "tenant.create",
            actor,
            audiences: [
              { mode: "User", username: tenantDoc.username },
              { mode: "Role", roleKey: "admin" },
              { mode: "Role", roleKey: "manager" },
              { mode: "Role", roleKey: "operator" },
            ],
            tags: [ "tenant", "create" ],
            target: {
              category: "Tenant",
              module: "Tenant",
              refId: tenantDoc.username ?? ( tenantDoc as any )._id,
              actionKey: 'tenant:account.created',
              params: { tenantID: tenantDoc.username }
            },
            category: "Tenant",
          } );
        } catch ( e: unknown ) {
          console.warn( "[Warning:] [TenantsRouter] tenant.create notification failed.\n", e );
        }

        ApiResponseBuilder.ok( res, "tenant", tenantDoc, "Tenant added successfully" );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] insertTenant error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ===========================================================================
  // GET basics (left intact/minimal)
  // ===========================================================================
  private getAllTenants(): void {
    this.router.get( "/get-all-tenants", async ( _req: Request, res: Response ) => {
      try {
        const tenants = ( await TenantModel.find<ITenant>().lean().exec() ) as unknown as ITenant[];
        if ( !tenants || tenants.length === 0 ) {
          ApiResponseBuilder.notFound( res, "No tenants found" );
          return;
        }
        ApiResponseBuilder.ok( res, "tenants", tenants, "Tenants fetched successfully" );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-all-tenants error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllTenantsCount(): void {
    this.router.get( "/get-all-tenants-count", async ( _req: Request, res: Response ) => {
      try {
        const total = await TenantModel.countDocuments();
        ApiResponseBuilder.ok( res, "other", {}, "All tenant users count retrieved successfully!", { pagination: { total } } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-all-tenants-count error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllTenantsWithPagination(): void {
    this.router.get( "/get-all-tenants-with-pagination", async ( req: Request, res: Response ) => {
      try {
        const limit = this.safeInt( req.query.limit, 20, 1, 100 );
        const start = typeof req.query.start !== "undefined" ? this.safeInt( req.query.start, 0, 0, Number.MAX_SAFE_INTEGER ) : 0;
        const rawSearch = this.s( req.query.search );

        const filter: FilterQuery<ITenant> = {};
        if ( rawSearch ) {
          const rx = new RegExp( rawSearch, "i" );
          filter.$or = [ { username: { $regex: rx } }, { name: { $regex: rx } }, { addedBy: { $regex: rx } } ];
        }

        const [ tenants, total ] = await Promise.all( [
          TenantModel.find( filter ).sort( { createdAt: -1 } ).skip( start ).limit( limit ).lean<ITenant>().exec() as unknown as ITenant[],
          TenantModel.countDocuments( filter ),
        ] );

        const totalPages = total > 0 ? Math.ceil( total / limit ) : 0;
        const index = total > 0 ? Math.floor( start / limit ) : 0;
        const end = total > 0 ? Math.min( start + tenants.length - 1, total - 1 ) : 0;

        const pagination: PaginationMeta = {
          index,
          limit,
          total,
          start: total > 0 ? start : 0,
          end: total > 0 ? end : 0,
          hasNext: index + 1 < totalPages,
          hasPrevious: index > 0 && totalPages > 0,
        };

        if ( rawSearch ) pagination.search = rawSearch;

        ApiResponseBuilder.ok( res, "tenants", tenants, "All tenant users retrieved successfully!", { pagination } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-all-tenants-with-pagination error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllNoneTenantWithPagination(): void {
    this.router.get( "/get-all-none-tenants-with-pagination", async ( req: Request, res: Response ) => {
      try {
        const limit = this.safeInt( req.query.limit, 20, 1, 100 );
        const start = typeof req.query.start !== "undefined" ? this.safeInt( req.query.start, 0, 0, Number.MAX_SAFE_INTEGER ) : 0;
        const rawSearch = this.s( req.query.search );

        const tenantDocs = await TenantModel.find( {}, { username: 1, _id: 0 } ).lean().exec();
        const tenantUsernames: string[] = tenantDocs
          .map( ( d: any ) => ( typeof d?.username === "string" ? d.username.trim() : "" ) )
          .filter( ( u: string ) => u.length > 0 );

        const filter: FilterQuery<User> = {};
        if ( tenantUsernames.length > 0 ) {
          filter.username = { $nin: tenantUsernames };
        }

        if ( rawSearch ) {
          const rx = new RegExp( rawSearch, "i" );
          filter.$or = [ { username: { $regex: rx } }, { name: { $regex: rx } }, { addedBy: { $regex: rx } } ];
        }

        const [ users, total ] = await Promise.all( [
          UserModel.find( filter, USER_MODEL_PROJECTION ).sort( { createdAt: -1 } ).skip( start ).limit( limit ).lean<User>().exec() as unknown as User[],
          UserModel.countDocuments( filter ),
        ] );

        const totalPages = total > 0 ? Math.ceil( total / limit ) : 0;
        const index = total > 0 ? Math.floor( start / limit ) : 0;
        const end = total > 0 ? Math.min( start + users.length - 1, total - 1 ) : 0;

        const pagination: PaginationMeta = {
          index,
          limit,
          total,
          start: total > 0 ? start : 0,
          end: total > 0 ? end : 0,
          hasNext: index + 1 < totalPages,
          hasPrevious: index > 0 && totalPages > 0,
        };

        if ( rawSearch ) pagination.search = rawSearch;

        ApiResponseBuilder.ok( res, "users", users, "All non-tenant users retrieved successfully!", { pagination } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-all-none-tenants-with-pagination error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllNoneTenantCount(): void {
    this.router.get( "/get-all-none-tenants-count", async ( _req: Request, res: Response ) => {
      try {
        const tenantDocs = await TenantModel.find( {}, { username: 1, _id: 0 } ).lean().exec();
        const tenantUsernames: string[] = tenantDocs
          .map( ( d: any ) => ( typeof d?.username === "string" ? d.username.trim() : "" ) )
          .filter( ( u: string ) => u.length > 0 );

        const filter: FilterQuery<User> = {};
        if ( tenantUsernames.length > 0 ) filter.username = { $nin: tenantUsernames };

        const total = await UserModel.countDocuments( filter );

        ApiResponseBuilder.ok( res, "other", {}, "All non-tenant users count retrieved successfully!", { pagination: { total } } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-all-none-tenants-count error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ===========================================================================
  // DELETE /delete-tenant/:username/:deletor
  // - Records tenant + ALL leases snapshot
  // - Scans & moves BOTH:
  //    public/uploads/tenants/<username>/*
  //    public/uploads/leases/<leaseId>/*
  // - Stores restore hints that preserve original lease roots (restore-safe)
  // ===========================================================================
  // inside your router class

  private deleteTenant(): void {
    // ✅ strongly recommend: import Request as ExpressRequest to avoid DOM Request conflicts
    // import type { Request as ExpressRequest, Response } from "express";

    this.router.delete(
      "/delete-tenant/:username/:deletor",
      async (
        req: Request<{ username: string; deletor: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          // 0) auth
          const author: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
          if ( !author ) {
            ApiResponseBuilder.conflict( res, "Invalid author!" );
            return;
          }

          // 1) params
          const username = this.s( req.params.username );
          const deletor =
            this.s( req.params.deletor ) || String( author.username ?? "" ).trim();

          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Username is required" );
            return;
          }
          if ( !deletor ) {
            ApiResponseBuilder.validationError( res, "Deletor is required" );
            return;
          }

          // 2) validate tenant + deletor
          const tenantDoc = await TenantModel.findOne( { username } ).lean().exec();
          if ( !tenantDoc ) {
            ApiResponseBuilder.notFound( res, "Tenant not found" );
            return;
          }

          const deletorDoc = await UserModel.findOne(
            { username: deletor },
            USER_MODEL_PROJECTION
          )
            .lean()
            .exec();

          if ( !deletorDoc ) {
            ApiResponseBuilder.notFound( res, "Deletor user not found" );
            return;
          }

          // 3) load leases BEFORE deletion
          type LeaseWithId = LeasePayload & { leaseID?: string; };
          const leases = await LeaseModel.find( {
            "tenantInformation.tenantUsername": username,
          } )
            .lean<LeaseWithId[]>() // ✅ row type, NOT array type
            .exec();

          const leaseIds: string[] = leases
            .map( ( l: LeaseWithId ) => this.s( l.leaseID ) )
            .filter( ( x: string ): x is string => x.length > 0 );

          // 4) scan files (tenant root + each lease root)
          const allFilePackets: FileMetaPacket[] = [];
          const leaseRootsById: Record<string, string> = {};

          // ✅ With the new guard: you may pass "uploads/..." or "public/uploads/..."
          // Prefer canonical "uploads/..." (no public prefix)
          const tenantRootPathLike = `${ this.TENANT_UPLOAD_ROOT_REL }/${ username }`;
          const tenantPackets = await FileMetaPacketBuilder.scanTree( {
            rootPathLike: tenantRootPathLike,
            bucket: `tenant:${ username }`,
            req,
          } );
          allFilePackets.push( ...tenantPackets );

          for ( const leaseId of leaseIds ) {
            const leaseRootPathLike = `${ this.LEASES_UPLOAD_ROOT_REL }/${ leaseId }`;
            leaseRootsById[ leaseId ] = leaseRootPathLike;

            const leasePackets = await FileMetaPacketBuilder.scanTree( {
              rootPathLike: leaseRootPathLike,
              bucket: `lease:${ leaseId }`,
              req,
            } );

            allFilePackets.push( ...leasePackets );
          }

          // 5) snapshot (JSON-safe)
          // DomainDeletePlan expects Record<string, unknown>.
          // We keep this JSON-safe to avoid non-serializable data.
          const snapshotData: Record<string, unknown> = {
            tenant: this.toJsonSafe( tenantDoc ),
            leases: this.toJsonSafe( leases ),
            deletedBy: {
              username: this.s( ( deletorDoc as { username?: unknown; } | null )?.username ) || deletor,
              role: this.s( ( deletorDoc as { role?: unknown; } | null )?.role ) || "unknown",
            },
            restoreHints: {
              tenantUsername: username,
              tenantUploadsRoot: tenantRootPathLike,
              leasesUploadsRoot: this.LEASES_UPLOAD_ROOT_REL,
              leaseIds,
              leaseRootsById,
            },
          };

          // 6) recyclebin delete plan (DB delete inside session)
          const plan: DomainDeletePlan<unknown> = {
            sourceKey: "tenant",
            refId: username,
            label: `Tenant: ${ this.s( ( tenantDoc as { name?: unknown; } | null )?.name ) || username }`,
            description: "Tenant deleted (cascade leases)",
            snapshotData,
            files: allFilePackets,
            module: "Tenant Management",
            entity: "Tenant",
            tags: [ "tenant", "lease", "cascade" ],

            deleteDbRecord: async ( session: ClientSession ): Promise<void> => {
              await LeaseModel.deleteMany(
                { "tenantInformation.tenantUsername": username },
                { session }
              ).exec();

              await TenantModel.deleteOne( { username }, { session } ).exec();
            },
          };

          await this.deleteSvc.deleteWithRecycleBin( author, plan );

          // 7) notify (best-effort)
          try {
            const actor = this.buildNotificationActor( author );

            this.notificationHub.emit( {
              eventKey: "tenant.delete",
              actor,
              audiences: [
                { mode: "Role", roleKey: "admin" },
                { mode: "Role", roleKey: "manager" },
                { mode: "Role", roleKey: "operator" },
              ],
              tags: [ "tenant", "delete", "cascade" ],
              target: {
                category: "Tenant",
                module: "Tenant",
                refId: username,
                actionKey: "tenant:account.deleted",
              },
              category: "Tenant",
            } );
          } catch ( e: unknown ) {
            console.warn( "[Warning:] [TenantsRouter] tenant.delete notification failed.\n", e );
          }

          ApiResponseBuilder.noContent(
            res,
            "Tenant + related leases recorded to recyclebin and deleted from DB."
          );
          return;
        } catch ( error: unknown ) {
          console.error( "[Error:] delete-tenant error:\n", error );
          const message =
            error instanceof Error
              ? error.message
              : "Unexpected error occurred during tenant deletion.";
          ApiResponseBuilder.internalError( res, message );
          return;
        }
      }
    );
  }

  /**
   * Convert unknown values to JSON-safe structures (Record/Array/primitives).
   * This keeps DomainDeletePlan.snapshotData truly JSON-safe.
   */
  private toJsonSafe( value: unknown ): unknown {
    try {
      return JSON.parse( JSON.stringify( value ) ) as unknown;
    } catch {
      // If something is not serializable, return a minimal safe fallback
      return { _snapshotError: "Non-serializable snapshot value" };
    }
  }
  // ===========================================================================
  // POST /create-complaint
  // Uploads via FileUploader (diskStorage):
  // - attachments: up to 20 files, max 20MB each
  // Stores at:
  //   /public/uploads/tenants/<tenantId>/complaints/<code>/attachments/*
  // ===========================================================================
  private createComplaint(): void {
    this.router.post( "/create-complaint", async ( req: Request, res: Response ) => {
      // If upload succeeds but validation fails later, we clean up the created upload folder.
      let uploadedBaseRelativeDir: string | null = null;

      try {
        const author: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
        if ( !author ) {
          ApiResponseBuilder.conflict( res, "Invalid author!" );
          return;
        }

        // 1) Parse JSON payload
        const raw = this.s( req.body?.data );
        if ( !raw ) {
          ApiResponseBuilder.validationError( res, "Missing data payload!" );
          return;
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse( raw ) as Record<string, unknown>;
        } catch {
          ApiResponseBuilder.conflict( res, "Invalid JSON in data payload" );
          return;
        }

        // 2) attachmentCount validation (still supported)
        const expectedCount = this.safeInt( req.body?.attachmentCount, 0, 0, this.MAX_FILES_TOTAL );

        // 3) Extract required fields
        const tenantId = this.s( payload[ "tenantId" ] );
        const propertyId = this.s( payload[ "propertyId" ] );
        const title = this.s( payload[ "title" ] );
        const description = this.s( payload[ "description" ] );
        const category = this.s( payload[ "category" ] );
        const priority = this.s( payload[ "priority" ] ?? "medium" ).toLowerCase();
        const status = this.s( payload[ "status" ] ?? "new" ).toLowerCase();
        const assigneeId = this.s( payload[ "assigneeId" ] );
        const dueAtISO = this.s( payload[ "dueAt" ] );
        const leaseId = this.s( payload[ "leaseId" ] );

        if ( !tenantId ) { ApiResponseBuilder.validationError( res, "tenantId is required" ); return; }
        if ( !propertyId ) { ApiResponseBuilder.validationError( res, "propertyId is required" ); return; }
        if ( !title ) { ApiResponseBuilder.validationError( res, "title is required" ); return; }
        if ( !leaseId ) { ApiResponseBuilder.validationError( res, "leaseId is required" ); return; }
        if ( !description ) { ApiResponseBuilder.validationError( res, "description is required" ); return; }
        if ( !this.isValidCategory( category ) ) { ApiResponseBuilder.validationError( res, "Invalid category" ); return; }
        if ( !this.isValidPriority( priority ) ) { ApiResponseBuilder.validationError( res, "Invalid priority" ); return; }

        // tenant must exist in user list
        const userTenantDoc = await UserModel.findOne( { username: tenantId } ).lean<User>().exec();
        if ( !userTenantDoc ) {
          ApiResponseBuilder.notFound( res, "Tenant not found in user list" );
          return;
        }

        // 4) Code
        const code = this.s( payload[ "code" ] ) || this.generateCode();

        // 5) Upload (FileUploader runs multer internally if middleware wasn't run)
        //    NOTE: subPath is inside "uploads/" automatically by FileUploader.
        const uploadSubPath = `tenants/${ tenantId }/complaints/${ code }`;

        const uploadResult: UploadResultPacket = await FileUploader.handleMultiFieldUpload(
          uploadSubPath,
          [ { name: "attachments", maxCount: this.MAX_FILES_TOTAL } ],
          req,
          {
            allowedMimeTypesByField: { attachments: this.allowFileTypes },
            maxFileSizeMb: this.MAX_FILE_MB,
            maxFiles: this.MAX_FILES_TOTAL,
          },
        );

        uploadedBaseRelativeDir = uploadResult.baseRelativeDir; // "uploads/<subPath>"

        const uploadedAttachments: FileMetaPacket[] = uploadResult.byField[ "attachments" ] ?? [];

        // If FE sends attachmentCount, enforce strict match
        if ( expectedCount !== uploadedAttachments.length && uploadedBaseRelativeDir ) {
          // Cleanup uploaded folder to avoid orphan files
          const abs = path.resolve( this.PUBLIC_ROOT, uploadedBaseRelativeDir );
          await this.safeRmAbs( abs );

          ApiResponseBuilder.validationError(
            res,
            `attachmentCount mismatch: expected ${ expectedCount }, received ${ uploadedAttachments.length }`,
          );
          return;
        }

        // 6) Create complaint doc (then attach packets)
        const dueAt = dueAtISO ? new Date( dueAtISO ) : null;

        const doc = await ComplaintModel.create( {
          code,
          tenantId,
          propertyId,
          leaseId,
          title,
          description,
          category,
          priority,
          status,
          assigneeId: assigneeId ? assigneeId : null,
          dueAt: dueAt ? dueAt : null,
          // attachments will be pushed below (schema-dependent)
        } );

        // 7) Persist attachments in DB (store relativePath for restore + publicUrl for UI)
        if ( uploadedAttachments.length > 0 ) {
          for ( const p of uploadedAttachments ) {
            ( doc as any ).attachments.push( {
              originalName: p.originalName,
              storedName: p.storedName,
              mimeType: p.mimeType,
              sizeBytes: p.sizeBytes,
              relativePath: p.relativePath,
              url: p.publicUrl,
              uploadedAtIso: p.uploadedAtIso,
            } );
          }
          await ( doc as any ).save?.();
        }

        // 8) notify (best-effort)  ✅ correct event + tags
        try {
          const actor = this.buildNotificationActor( author );

          this.notificationHub.emit( {
            eventKey: "complaint.create",
            actor,
            audiences: [
              { mode: "User", username: String( ( userTenantDoc as any )?._id ?? userTenantDoc.username ?? tenantId ) },
              { mode: "Role", roleKey: "admin" },
              { mode: "Role", roleKey: "manager" },
              { mode: "Role", roleKey: "operator" },
            ],
            tags: [ "complaint", "create" ],
            target: {
              category: "Complaint",
              module: "Complaints",
              refId: doc.code,
              actionKey: 'tenant:complaint.created'
            },
            category: "Complaint",
          } );
        } catch ( e: unknown ) {
          console.warn( "[Warning:] [TenantsRouter] complaint.create notification failed.\n", e );
        }

        ApiResponseBuilder.ok( res, "complaint", doc, "Complaint created!" );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] create-complaint error:\n", error );

        // If we already uploaded files and then failed (e.g., DB error), cleanup to avoid orphan uploads
        if ( uploadedBaseRelativeDir ) {
          const abs = path.resolve( this.PUBLIC_ROOT, uploadedBaseRelativeDir );
          await this.safeRmAbs( abs );
        }

        const msg = error instanceof Error ? error.message : "Unexpected error occurred during complaint creation.";
        ApiResponseBuilder.internalError( res, msg );
        return;
      }
    } );
  }

  // ===========================================================================
  // GET /complaint/:complaintID
  // ===========================================================================
  private getComplaintById(): void {
    this.router.get( "/complaint/:complaintID", async ( req: Request<{ complaintID: string; }>, res: Response ) => {
      try {
        const complaintID = this.s( req.params.complaintID );
        if ( !complaintID ) { ApiResponseBuilder.validationError( res, "Complaint ID is required!" ); return; }

        const complaintDoc = await ComplaintModel.findOne( { code: complaintID } ).lean<IComplaint>().exec();
        if ( !complaintDoc ) { ApiResponseBuilder.notFound( res, "Complaint does not found!" ); return; }

        ApiResponseBuilder.ok( res, "complaint", complaintDoc, "Complaint fetched successfully!" );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-complaint-by-id error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  // ===========================================================================
  // GET /complaints/tenant/:username
  // ===========================================================================
  private getAllComplaintsByTenantUsername(): void {
    this.router.get( "/complaints/tenant/:username", async ( req: Request<{ username: string; }>, res: Response ) => {
      try {
        const username = this.s( req.params.username );
        if ( !username ) { ApiResponseBuilder.validationError( res, "Username is required" ); return; }

        const start = this.safeInt( req.query.start, 0, 0, Number.MAX_SAFE_INTEGER );
        const limit = this.safeInt( req.query.limit, 50, 1, 200 );
        const search = this.s( req.query.search ).toLowerCase();

        const filter: FilterQuery<IComplaint> = {};
        if ( search ) {
          const rx = new RegExp( search, "i" );
          filter.$or = [
            { code: { $regex: rx } },
            { title: { $regex: rx } },
            { description: { $regex: rx } },
            { category: { $regex: rx } },
            { status: { $regex: rx } },
          ];
        }

        const [ complaints, total ] = await Promise.all( [
          ComplaintModel.find( { ...filter, tenantId: username } )
            .sort( { createdAt: -1 } )
            .skip( start )
            .limit( limit )
            .lean<IComplaint>()
            .exec() as unknown as IComplaint[],
          ComplaintModel.countDocuments( { ...filter, tenantId: username } ),
        ] );

        const totalPages = total > 0 ? Math.ceil( total / limit ) : 0;
        const index = total > 0 ? Math.floor( start / limit ) : 0;
        const end = total > 0 ? Math.min( start + complaints.length - 1, total - 1 ) : 0;

        const pagination: PaginationMeta = {
          index,
          limit,
          total,
          start: total > 0 ? start : 0,
          end: total > 0 ? end : 0,
          hasNext: index + 1 < totalPages,
          hasPrevious: index > 0 && totalPages > 0,
        };
        if ( search ) pagination.search = search;

        ApiResponseBuilder.ok( res, "complaints", complaints, "Complaints retrieved successfully!", { pagination } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-all-complaints-by-tenant-username error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllComplaintsCountByTenantUsername(): void {
    this.router.get( "/complaints-count/tenant/:username", async ( req: Request<{ username: string; }>, res: Response ) => {
      try {
        const username = this.s( req.params.username );
        if ( !username ) { ApiResponseBuilder.validationError( res, "Username is required" ); return; }

        const total = await ComplaintModel.countDocuments( { tenantId: username } );
        ApiResponseBuilder.ok( res, "other", {}, "Complaints total fetched successfully", { pagination: { total } } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] complaints-count-by-tenant error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllComplaints(): void {
    this.router.get( "/complaints/all", async ( req: Request, res: Response ) => {
      try {
        const start = this.safeInt( req.query.start, 0, 0, Number.MAX_SAFE_INTEGER );
        const limit = this.safeInt( req.query.limit, 100, 1, 300 );
        const search = this.s( req.query.search ).toLowerCase();

        const filter: FilterQuery<IComplaint> = {};
        if ( search ) {
          const rx = new RegExp( search, "i" );
          filter.$or = [
            { code: { $regex: rx } },
            { title: { $regex: rx } },
            { description: { $regex: rx } },
            { category: { $regex: rx } },
            { status: { $regex: rx } },
          ];
        }

        const [ items, total ] = await Promise.all( [
          ComplaintModel.find( { ...filter } ).sort( { createdAt: -1 } ).skip( start ).limit( limit ).lean<IComplaint>().exec() as unknown as IComplaint[],
          ComplaintModel.countDocuments( { ...filter } ),
        ] );

        const totalPages = total > 0 ? Math.ceil( total / limit ) : 0;
        const index = total > 0 ? Math.floor( start / limit ) : 0;
        const end = total > 0 ? Math.min( start + items.length - 1, total - 1 ) : 0;

        const pagination: PaginationMeta = {
          index,
          limit,
          total,
          start: total > 0 ? start : 0,
          end: total > 0 ? end : 0,
          hasNext: index + 1 < totalPages,
          hasPrevious: index > 0 && totalPages > 0,
        };
        if ( search ) pagination.search = search;

        ApiResponseBuilder.ok( res, "complaints", items, "Complaints fetched successful", { pagination } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-all-complaints error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllComplaintsByStatus(): void {
    this.router.get( "/complaints/all/status/:status", async ( req: Request<{ status: string; }>, res: Response ) => {
      try {
        const status = this.s( req.params.status ).toLowerCase();
        if ( !status ) { ApiResponseBuilder.validationError( res, "Status is required" ); return; }

        const start = this.safeInt( req.query.start, 0, 0, Number.MAX_SAFE_INTEGER );
        const limit = this.safeInt( req.query.limit, 100, 1, 300 );
        const search = this.s( req.query.search ).toLowerCase();

        const filter: FilterQuery<IComplaint> = { status };
        if ( search ) {
          const rx = new RegExp( search, "i" );
          filter.$or = [
            { code: { $regex: rx } },
            { title: { $regex: rx } },
            { description: { $regex: rx } },
            { category: { $regex: rx } },
            { status: { $regex: rx } },
          ];
        }

        const [ items, total ] = await Promise.all( [
          ComplaintModel.find( { ...filter } ).sort( { createdAt: -1 } ).skip( start ).limit( limit ).lean<IComplaint>().exec() as unknown as IComplaint[],
          ComplaintModel.countDocuments( { ...filter } ),
        ] );

        const totalPages = total > 0 ? Math.ceil( total / limit ) : 0;
        const index = total > 0 ? Math.floor( start / limit ) : 0;
        const end = total > 0 ? Math.min( start + items.length - 1, total - 1 ) : 0;

        const pagination: PaginationMeta = {
          index,
          limit,
          total,
          start: total > 0 ? start : 0,
          end: total > 0 ? end : 0,
          hasNext: index + 1 < totalPages,
          hasPrevious: index > 0 && totalPages > 0,
        };
        if ( search ) pagination.search = search;

        ApiResponseBuilder.ok( res, "complaints", items, "Complaints fetched successful", { pagination } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-all-complaints-by-status error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllComplaintsCountByStatus(): void {
    this.router.get( "/complaints/all/count/status/:status", async ( req: Request<{ status: string; }>, res: Response ) => {
      try {
        const status = this.s( req.params.status ).toLowerCase();
        if ( !status ) { ApiResponseBuilder.validationError( res, "Status is invalid!" ); return; }

        const total = await ComplaintModel.countDocuments( { status } );
        ApiResponseBuilder.ok( res, "other", {}, "Complaints count fetched successfully", { pagination: { total } } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] get-all-complaints-count-by-status error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllComplaintsCount(): void {
    this.router.get( "/complaints-count/all", async ( _req: Request, res: Response ) => {
      try {
        const total = await ComplaintModel.countDocuments( {} );
        ApiResponseBuilder.ok( res, "other", {}, "Complaints total fetched successfully", { pagination: { total } } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] complaints-count-all error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }

  private getAllComplaintsBySection(): void {
    this.router.get( "/complaints-by-section/all/:section", async ( req: Request<{ section: string; }>, res: Response ) => {
      try {
        const section = this.s( req.params.section ).toLowerCase();
        if ( !section ) { ApiResponseBuilder.validationError( res, "Section is invalid!" ); return; }

        const projection: Record<string, 1 | 0> = { [ section ]: 1, _id: 0 };

        const [ complaints, total ] = await Promise.all( [
          ComplaintModel.find( {}, projection ).lean<IComplaint>().exec() as unknown as IComplaint[],
          ComplaintModel.countDocuments(),
        ] );

        ApiResponseBuilder.ok( res, "complaints", complaints, "Complaints fetched successfully by section", { pagination: { total } } );
        return;
      } catch ( error: unknown ) {
        console.error( "[Error:] complaints-by-section error:\n", error );
        ApiResponseBuilder.internalError( res, error );
        return;
      }
    } );
  }
}
