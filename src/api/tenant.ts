// src/api/tenants.ts
// ============================================================================
// Tenants API (PropEase)
// - Insert new tenant
// - Get all tenants
// - Delete tenant  (safe recyclebin move with DB export)
// - Create complaint (multipart: JSON + attachments[0..9])
// - Get complaint by ID
// - Get all complaints for a tenant
// - Get all complaints (admin view)
// - Post comment on complaint (multipart: JSON + attachments[0..9])
// ----------------------------------------------------------------------------
// Design notes:
// • We never delete files outright during destructive ops; we move to /public/recyclebin
// • We export DB rows to JSON in recyclebin for audit/recovery
// • For uploads we use Multer memoryStorage, validate, then persist to final disk paths
// • All routes return JSON and follow the res.status(...).json(...); return; pattern
// • All helpers are class methods; no free functions
// • Electron-friendly: file responses may include relPath under "public/..."
// ============================================================================

import express, {
  Request, Response, Router, NextFunction, RequestHandler
} from 'express';
import { FilterQuery } from "mongoose";
import dotenv from 'dotenv';
import fs from 'fs';
import * as fse from 'fs-extra';
import path from 'path';
import multer from 'multer';
import type { FileFilterCallback } from 'multer';
import { randomUUID } from 'crypto';

import { ITenant, TenantModel } from '../models/tenant.model';
import { LeaseModel } from '../models/lease.model';
import NotificationService from '../services/notification.service';
import { UserModel, type IUser } from '../models/user.model';
import {
  ComplaintModel,
  COMPLAINT_CATEGORIES,
  type ComplaintAudience,
  DEFINED_AUDIENCES,
  IComplaint,
} from '../models/complaint.model';

dotenv.config();


/**
 * Tenant API class — mount with:  app.use('/api/tenants', new Tenant().route);
 */
export default class Tenant {
  // ---------------------------------------------------------------------------
  // Express router exposed via .route
  // ---------------------------------------------------------------------------
  private readonly router: Router = express.Router();

  // ---------------------------------------------------------------------------
  // Base directories (served statically by main app)
  //   <project>/public
  //   <project>/public/uploads
  //   <project>/public/recyclebin
  // ---------------------------------------------------------------------------
  private readonly PUBLIC_ROOT = path.resolve( __dirname, '../../public' );
  private readonly UPLOADS_ROOT = path.join( this.PUBLIC_ROOT, 'uploads' );
  private readonly RECYCLEBIN_ROOT = path.join( this.PUBLIC_ROOT, 'recyclebin' );

  // Common buckets
  private readonly TENANT_UPLOAD_ROOT = path.join( this.UPLOADS_ROOT, 'tenants' );
  private readonly TENANT_RECYCLE_ROOT = path.join( this.RECYCLEBIN_ROOT, 'tenants' );

  // Recycled leases live under: /public/recyclebin/tenants/leases/<username>/<stamp>-<leaseID>/
  private readonly TENANT_RECYCLE_LEASES_ROOT = path.join( this.TENANT_RECYCLE_ROOT, 'leases' );

  // Lease uploads live under: /public/uploads/leases/<leaseID>/
  private readonly LEASE_UPLOAD_ROOT = path.join( this.UPLOADS_ROOT, 'leases' );

  // ---------------------------------------------------------------------------
  // Attachment type allowlists
  // ---------------------------------------------------------------------------
  private readonly allowedImageTypes: string[] = [
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
    'image/bmp', 'image/tiff', 'image/webp', 'image/svg+xml',
    'image/avif', 'image/heic',
  ];

  private readonly allowedDocTypes: string[] = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
  ];

  // ---------------------------------------------------------------------------
  // Constructor binds routes
  // ---------------------------------------------------------------------------
  public constructor () {
    this.insertTenant();                                                              // POST   /insertTenant
    this.getAllTenants();                                                             // GET    /get-all-tenants
    this.getAllTenantsCount();                                                        // GET    /get-all-tenants-count
    this.getAllTenantsWithPagination();                                               // GET    /get-all-tenants-with-pagination
    this.getAllNoneTenantWithPagination();                                            // GET    /get-all-none-tenants-with-pagination
    this.getAllNoneTenantCount();                                                     // GET    /get-all-none-tenant-count
    this.deleteTenant();                                                              // DELETE /delete-tenant/:username/:deletor
    this.createComplaint();                                                           // POST   /create-complaint
    this.getComplaintById();                                                          // GET    /complaint/:complaintID
    this.getAllComplaintsByTenantUsername();                                          // GET    /complaints/tenant/:username?start=&limit=&search=
    this.getAllComplaintsCountByTenantUsername();                                     // GET    /complaints-count/tenant/:username
    this.getAllComplaints();                                                          // GET    /complaints/all
    this.getAllComplaintsCount();                                                     // GET    /complaints-count/all
    this.getAllComplaintsBySection();                                            // GET    /complaints-by-section/all/:section
    this.postComment();                                                               // POST   /complaints/post-comments
    this.getCommentsBasedOnComplaintCode();                                           // GET    /complaints/:complaint.code/cgetAllComplaintsCountByTenantUsernameomments?params
  }


  /** Expose router for mounting. */
  public get route(): Router {
    return this.router;
  }

  // ===========================================================================
  // Helpers (paths, fs, validation, naming)
  // ===========================================================================

  /** Safe join under a known root; prevents path traversal. */
  private safeJoin( root: string, ...segments: string[] ): string {
    const target = path.resolve( root, ...segments );
    const normalizedRoot = path.resolve( root );
    if ( !target.startsWith( normalizedRoot ) ) {
      throw new Error( 'Unsafe path resolution detected' );
    }
    return target;
  }


  /** mkdir -p */
  private async ensureDir( dir: string ): Promise<void> {
    await fs.promises.mkdir( dir, { recursive: true } );
  }

  /** Move path with rename(); fallback to copy+remove when cross-device. */
  private async movePath( src: string, dest: string ): Promise<void> {
    try {
      await this.ensureDir( path.dirname( dest ) );
      await fs.promises.rename( src, dest );
    } catch {
      await this.ensureDir( path.dirname( dest ) );
      await this.copyRecursive( src, dest );
      await this.rmRecursive( src );
    }
  }

  /** Recursive copy (dir or file). */
  private async copyRecursive( src: string, dest: string ): Promise<void> {
    const stat = await fs.promises.stat( src );
    if ( stat.isDirectory() ) {
      await this.ensureDir( dest );
      const entries = await fs.promises.readdir( src );
      for ( const entry of entries ) {
        await this.copyRecursive( path.join( src, entry ), path.join( dest, entry ) );
      }
    } else {
      await this.ensureDir( path.dirname( dest ) );
      await fs.promises.copyFile( src, dest );
    }
  }

  /** Recursive remove. */
  private async rmRecursive( target: string ): Promise<void> {
    await fs.promises.rm( target, { recursive: true, force: true } );
  }

  /** YYYYMMDD-HHMMSS stamp (used in recyclebin folder names). */
  private makeStamp( date = new Date() ): string {
    const pad = ( n: number ) => n.toString().padStart( 2, '0' );
    return `${ date.getFullYear() }${ pad( date.getMonth() + 1 ) }${ pad( date.getDate() ) }-${ pad( date.getHours() ) }${ pad( date.getMinutes() ) }${ pad( date.getSeconds() ) }`;
  }

  /** Attachment type validator (images or docs). */
  private isAllowedAttachmentType( mime: string ): boolean {
    return this.allowedImageTypes.includes( mime ) || this.allowedDocTypes.includes( mime );
  }

  /** Validate complaint category against shared enum list. */
  private isValidCategory( cat: string ): boolean {
    return ( COMPLAINT_CATEGORIES as readonly string[] ).includes( cat );
  }

  /** Validate complaint priority. */
  private isValidPriority( p: string ): boolean {
    return [ 'low', 'medium', 'high', 'urgent' ].includes( p );
  }

  /** Server-side complaint code generator. */
  private generateCode(): string {
    const ts = Date.now().toString( 36 ).toUpperCase();
    const rnd = Math.random().toString( 36 ).substring( 2, 8 ).toUpperCase();
    return `PROPEASE-CPL-${ ts }-${ rnd }`;
  }

  /** mime → extension fallback (used when originalname has no ext). */
  private mimeToExt( mime: string ): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/bmp': '.bmp',
      'image/tiff': '.tiff',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'image/avif': '.avif',
      'image/heic': '.heic',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'text/csv': '.csv',
      'text/plain': '.txt',
    };
    return map[ mime ] || '';
  }

  // Build absolute URL for served files (frontend web) and a relPath (for Electron)
  private buildFileRefs( req: Request, tenantId: string, code: string, storedName: string ) {
    const baseURL = `${ req.protocol }://${ req.get( 'host' ) }`;
    const url = `${ baseURL }/uploads/tenants/${ encodeURIComponent( tenantId ) }/complaints/${ encodeURIComponent( code ) }/comments/${ encodeURIComponent( storedName ) }`;
    // relPath is project-relative, no leading "/" (Electron packaging rule)
    const relPath = path
      .join( 'public', 'uploads', 'tenants', tenantId, 'complaints', code, 'comments', storedName )
      .replace( /\\/g, '/' );

    return { url, relPath };
  }

  // Parse JSON defensively and type-safely
  private parseJson<T>( raw: unknown, label: string, res: Response ): T | null {
    try {
      const s = ( raw ?? '' ).toString().trim();
      if ( !s ) {
        res.status( 400 ).json( { success: false, message: `${ label } is missing or empty` } );
        return null;
      }
      return JSON.parse( s ) as T;
    } catch ( e ) {
      res.status( 400 ).json( { success: false, message: `${ label } is not valid JSON` } );
      return null;
    }
  }

  // ===========================================================================
  // Multer builder: shared for /create-complaint and /complaints/post-comments
  // - memoryStorage, files <=10MB, max 10, field name "attachments"
  // - JSON-ify Multer errors into 400 responses
  // ===========================================================================
  private buildComplaintUploader(): RequestHandler {
    const upload = multer( {
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB/file
        files: 10,                   // max 10 files
        fields: 20,                  // defensive
      },
      fileFilter: ( _req, file, cb: FileFilterCallback ) => {
        if ( this.isAllowedAttachmentType( file.mimetype ) ) {
          cb( null, true );
        } else {
          // Use MulterError so TypeScript is happy and the code is consistent
          cb( new multer.MulterError( 'LIMIT_UNEXPECTED_FILE', `Unsupported mimetype: ${ file.mimetype }` ) );
        }
      },
    } ).fields( [ { name: 'attachments', maxCount: 10 } ] );

    return ( req: Request, res: Response, next: NextFunction ) => {
      upload( req, res, ( err: any ) => {
        if ( !err ) { next(); return; }

        if ( err instanceof multer.MulterError ) {
          let message = 'Upload error';
          if ( err.code === 'LIMIT_FILE_SIZE' ) message = 'One or more files exceed the 10MB size limit.';
          else if ( err.code === 'LIMIT_FILE_COUNT' ) message = 'Too many files. Maximum 10 attachments allowed.';
          else if ( err.code === 'LIMIT_UNEXPECTED_FILE' ) message = 'Unexpected or unsupported file received.';
          res.status( 400 ).json( { success: false, message, errors: { code: err.code, field: ( err as any ).field } } );
          return;
        }

        res.status( 400 ).json( { success: false, message: err?.message || 'Upload failed' } );
        return;
      } );
    };
  }

  // ===========================================================================
  // POST /insertTenant
  // ===========================================================================
  private insertTenant(): void {
    // Parse only text fields (no file uploads for this route)
    const noFiles = multer().none();

    this.router.post( '/insertTenant', noFiles, async ( req: Request, res: Response ) => {
      try {
        // Extract required fields
        const username = ( req.body.username || '' ).trim();
        const name = ( req.body.name || '' ).trim();
        const image = ( req.body.image || '' ).trim();
        const phoneNumber = ( req.body.phoneNumber || '' ).trim();
        const email = ( req.body.email || '' ).trim();
        const gender = ( req.body.gender || '' ).trim();
        const addedBy = ( req.body.addedBy || '' ).trim();

        // Validate
        if ( !username ) { res.status( 400 ).json( { status: 'error', message: 'Username required!' } ); return; }
        if ( !name ) { res.status( 400 ).json( { status: 'error', message: 'Name required!' } ); return; }
        if ( !image ) { res.status( 400 ).json( { status: 'error', message: 'Image required!' } ); return; }
        if ( !phoneNumber ) { res.status( 400 ).json( { status: 'error', message: 'Phone number required!' } ); return; }
        if ( !email ) { res.status( 400 ).json( { status: 'error', message: 'Email required!' } ); return; }
        if ( !gender ) { res.status( 400 ).json( { status: 'error', message: 'Gender required!' } ); return; }
        if ( !addedBy ) { res.status( 400 ).json( { status: 'error', message: 'Added by required!' } ); return; }

        // Clear any previous recyclebin bucket for this user (fresh start)
        const recycleBinForTenant = this.safeJoin( this.TENANT_RECYCLE_ROOT, username );
        if ( fs.existsSync( recycleBinForTenant ) ) {
          await this.rmRecursive( recycleBinForTenant );
        }

        // Persist DB row
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

        // Broadcast notification (non-fatal if socket missing)
        try {
          const notificationService = new NotificationService();
          const io = req.app.get( 'io' ) as import( 'socket.io' ).Server;
          await notificationService.createNotification(
            {
              title: 'New Tenant',
              body: `A new tenant named ${ tenantDoc.name } has been added.`,
              type: 'create',
              severity: 'info',
              audience: { mode: 'role', roles: [ 'admin', 'agent', 'manager', 'operator' ], usernames: [ tenantDoc.username ] },
              channels: [ 'inapp', 'email' ],
              metadata: {
                refId: tenantDoc.username,
                data: {
                  tenant: {
                    username,
                    image,
                    name,
                    contactNumber: phoneNumber,
                    email,
                    gender,
                    addedBy,
                  },
                  addedDate: new Date().toISOString(),
                  addedBy: tenantDoc.addedBy,
                },
              },
            },
            ( rooms, payload ) => rooms.forEach( room => io?.to( room ).emit( 'notification.new', payload ) ),
          );
        } catch { /* non-fatal */ }

        res.status( 200 ).json( { status: 'success', message: 'Tenant added successfully', data: tenantDoc } );
        return;
      } catch ( error ) {
        console.error( 'insertTenant error:', error );
        res.status( 500 ).json( { status: 'error', message: `Error: ${ error instanceof Error ? error.message : error }` } );
        return;
      }
    } );
  }


  // ===========================================================================
  // GET /get-all-tenants
  // ===========================================================================
  private getAllTenants(): void {
    this.router.get( '/get-all-tenants', async ( _req: Request, res: Response ) => {
      try {
        const tenants = await TenantModel.find().lean();
        if ( !tenants || tenants.length === 0 ) {
          res.status( 404 ).json( { status: 'error', message: 'No tenants found' } );
          return;
        }
        res.status( 200 ).json( { status: 'success', message: 'Tenants fetched successfully', data: tenants } );
        return;
      } catch ( error ) {
        console.error( 'get-all-tenants error:', error );
        res.status( 500 ).json( { status: 'error', message: `Error: ${ error instanceof Error ? error.message : error }` } );
        return;
      }
    } );
  }

  // ===========================================================================
  // GET /get-all-tenants-count
  // ===========================================================================
  private getAllTenantsCount(): void {
    this.router.get( '/get-all-tenants-count', async ( _req: Request, res: Response ) => {
      try {
        const count = await TenantModel.countDocuments();
        res.status( 200 ).json( { status: 'success', message: 'All tenant users count retrieved successfully!', data: count } );
        return;
      } catch ( error ) {
        console.error( 'get-all-tenants error:', error );
        res.status( 500 ).json( { status: 'error', message: `Error: ${ error instanceof Error ? error.message : error }` } );
        return;
      }
    } );
  }

  // ===========================================================================
  // GET /get-all-tenants-with-pagination
  // ===========================================================================
  private getAllTenantsWithPagination(): void {
    this.router.get( '/get-all-tenants-with-pagination', async ( req: Request, res: Response ) => {
      try {
        // ──────────────────────────────────────────────
        // 1) Pagination parameters
        // ──────────────────────────────────────────────
        let limit: number = parseInt( ( req.query.limit as string ) || "20", 10 );
        if ( isNaN( limit ) || limit < 1 ) limit = 20;
        if ( limit > 100 ) limit = 100;

        let page: number;
        let skip: number;

        if ( typeof req.query.start !== "undefined" ) {
          // Frontend sends start = skip (0-based offset)
          const startRaw: number = parseInt( req.query.start as string, 10 );
          const start: number = isNaN( startRaw ) ? 0 : Math.max( startRaw, 0 );

          skip = start;
          page = Math.floor( skip / limit ) + 1; // derive human page (1-based)
        } else {
          // Fallback: page-based API
          const pageRaw: number = parseInt(
            ( req.query.page as string ) || "1",
            10
          );
          page = isNaN( pageRaw ) ? 1 : Math.max( pageRaw, 1 );
          skip = ( page - 1 ) * limit;
        }

        // ──────────────────────────────────────────────
        // 2) Search filter
        // ──────────────────────────────────────────────
        const rawSearch: string = this.s( req.query.search );
        const filter: FilterQuery<ITenant> = {};

        if ( rawSearch && rawSearch.trim() !== "" ) {
          const rx = new RegExp( rawSearch.trim(), "i" );

          filter.$or = [
            { username: { $regex: rx } },
            { name: { $regex: rx } },
            { addedBy: { $regex: rx } },
          ];
        }

        // ──────────────────────────────────────────────
        // 3) Sorting
        // ──────────────────────────────────────────────
        const sortBy: string = ( req.query.sortBy as string ) || "createdAt";
        const sortOrder: string = ( req.query.sortOrder as string ) || "desc";

        const sort: Record<string, 1 | -1> = {
          [ sortBy ]: sortOrder === "asc" ? 1 : -1,
        };

        // ──────────────────────────────────────────────
        // 4) DB query
        // ──────────────────────────────────────────────
        const [ tenants, total ] = await Promise.all( [
          TenantModel.find( filter ).sort( sort ).skip( skip ).limit( limit ).lean().exec(),
          TenantModel.countDocuments( filter ),
        ] );
        const data = {
          page,
          tenants,
          limit,
          total,
          totalPages: Math.ceil( total / limit ),
        };
        // ──────────────────────────────────────────────
        // 5) Response
        // ──────────────────────────────────────────────
        res.status( 200 ).json( {
          success: true,
          status: "success",
          message: "All tenant users retrieved successfully!",
          data
        } );
        return;
      } catch ( error ) {
        console.error( error );
        res.status( 500 ).json( {
          success: false,
          status: "error",
          error: "An unknown error occurred: " + error,
        } );
      }
    } );
  }

  // ===========================================================================
  // GET /get-all-none-tenants-with-pagination
  // ===========================================================================
  private getAllNoneTenantWithPagination(): void {

    this.router.get(
      '/get-all-none-tenants-with-pagination',
      async ( req: Request, res: Response ): Promise<void> => {

        try {

          // ──────────────────────────────────────────────
          // 1) Pagination parameters
          //    - limit: per-page size (1..100)
          //    - skip:  zero-based offset
          //    - page:  human-readable 1-based page index
          // ──────────────────────────────────────────────
          let limit: number = parseInt( ( req.query.limit as string ) || '20', 10 );

          if ( Number.isNaN( limit ) || limit < 1 ) {
            limit = 20;
          }

          if ( limit > 100 ) {
            limit = 100;
          }

          let page: number;
          let skip: number;

          if ( typeof req.query.start !== 'undefined' ) {

            // Frontend sends "start" as 0-based offset
            const startRaw: number = parseInt( req.query.start as string, 10 );
            const start: number = Number.isNaN( startRaw )
              ? 0
              : Math.max( startRaw, 0 );

            skip = start;
            page = Math.floor( skip / limit ) + 1; // derive human 1-based page index

          } else {

            // Fallback: classic page-based API
            const pageRaw: number = parseInt(
              ( req.query.page as string ) || '1',
              10,
            );

            page = Number.isNaN( pageRaw )
              ? 1
              : Math.max( pageRaw, 1 );

            skip = ( page - 1 ) * limit;

          }


          // ──────────────────────────────────────────────
          // 2) Build NON-TENANT base filter
          //    - We first collect all tenant usernames
          //    - Then filter UserModel by { username: { $nin: tenantUsernames } }
          // ──────────────────────────────────────────────

          // Get all tenant usernames only (no need for whole doc)
          const tenantDocs = await TenantModel
            .find( {}, { username: 1, _id: 0 } )
            .lean()
            .exec();

          const tenantUsernames: string[] = tenantDocs
            .map( ( doc: any ) => doc.username )
            .filter(
              ( u: unknown ): u is string =>
                typeof u === 'string' && u.trim().length > 0,
            );

          const filter: FilterQuery<IUser> = {};

          // Exclude all users that are already tenants
          if ( tenantUsernames.length > 0 ) {
            filter.username = { $nin: tenantUsernames };
          }


          // ──────────────────────────────────────────────
          // 3) Search filter (optional)
          //    - Search is ANDed with non-tenant filter
          // ──────────────────────────────────────────────

          const rawSearch: string = this.s( req.query.search ); // assuming this.s safely stringifies

          if ( rawSearch && rawSearch.trim() !== '' ) {

            const rx = new RegExp( rawSearch.trim(), 'i' );

            // Combine with base filter: username/$nin AND (username|name|addedBy matches search)
            filter.$or = [
              { username: { $regex: rx } },
              { name: { $regex: rx } },
              { addedBy: { $regex: rx } },
            ];

          }


          // ──────────────────────────────────────────────
          // 4) Sorting
          // ──────────────────────────────────────────────

          const sortBy: string = ( req.query.sortBy as string ) || 'createdAt';
          const sortOrder: string = ( req.query.sortOrder as string ) || 'desc';

          const sort: Record<string, 1 | -1> = {
            [ sortBy ]: sortOrder === 'asc'
              ? 1
              : -1,
          };


          // ──────────────────────────────────────────────
          // 5) DB query
          //    IMPORTANT: this should query UserModel (non-tenants),
          //    not TenantModel.
          // ──────────────────────────────────────────────

          const [ users, total ] = await Promise.all( [
            UserModel
              .find( filter )
              .sort( sort )
              .skip( skip )
              .limit( limit )
              .lean()
              .exec(),
            UserModel.countDocuments( filter ),
          ] );

          const data = {
            page,
            users,           // ⬅ non-tenant users for this page
            limit,
            total,           // total non-tenant users matching filter
            totalPages: Math.ceil( total / limit ),
          };


          // ──────────────────────────────────────────────
          // 6) Response
          // ──────────────────────────────────────────────
          res.status( 200 ).json( {
            success: true,
            status: 'success',
            message: 'All non-tenant users retrieved successfully!',
            data,
          } );
          return;

        } catch ( error ) {

          console.error( error );

          res.status( 500 ).json( {
            success: false,
            status: 'error',
            error: 'An unknown error occurred: ' + error,
          } );

        }

      },
    );

  }

  // ===========================================================================
  // GET /get-all-none-tenants-count
  // ===========================================================================
  private getAllNoneTenantCount() {

    this.router.get(
      '/get-all-none-tenants-count',
      async ( req: Request, res: Response ): Promise<void> => {

        try {
          // ──────────────────────────────────────────────
          // 1) Build NON-TENANT base filter
          //    - We first collect all tenant usernames
          //    - Then filter UserModel by { username: { $nin: tenantUsernames } }
          // ──────────────────────────────────────────────

          // Get all tenant usernames only (no need for whole doc)
          const tenantDocs = await TenantModel
            .find( {}, { username: 1, _id: 0 } )
            .lean()
            .exec();

          const tenantUsernames: string[] = tenantDocs
            .map( ( doc: any ) => doc.username )
            .filter(
              ( u: unknown ): u is string =>
                typeof u === 'string' && u.trim().length > 0,
            );

          const filter: FilterQuery<IUser> = {};

          // Exclude all users that are already tenants
          if ( tenantUsernames.length > 0 ) {
            filter.username = { $nin: tenantUsernames };
          }


          // ──────────────────────────────────────────────
          // 2) DB query
          //    IMPORTANT: this should query UserModel (non-tenants),
          //    not TenantModel.
          // ──────────────────────────────────────────────

          const [ total ] = await Promise.all( [
            UserModel.countDocuments( filter ),
          ] );


          // ──────────────────────────────────────────────
          // 3) Response
          // ──────────────────────────────────────────────
          res.status( 200 ).json( {
            success: true,
            status: 'success',
            message: 'All non-tenant users count retrieved successfully!',
            data: total,
          } );
          return;

        } catch ( error ) {

          console.error( error );

          res.status( 500 ).json( {
            success: false,
            status: 'error',
            error: 'An unknown error occurred: ' + error,
          } );

        }

      },
    );

  }


  // ===========================================================================
  // DELETE /delete-tenant/:username/:deletor
  // - Export tenant+leases JSON to recyclebin
  // - Move lease asset folders to recyclebin
  // - Delete DB rows (leases, then tenant)
  // ===========================================================================
  private deleteTenant(): void {
    this.router.delete(
      '/delete-tenant/:username/:deletor',
      async ( req: Request<{ username: string; deletor: string; }>, res: Response ) => {
        try {
          // Params
          const username = ( req.params.username || '' ).trim();
          const deletor = ( req.params.deletor || '' ).trim();
          if ( !username ) { res.status( 400 ).json( { status: 'error', message: 'Username required!' } ); return; }
          if ( !deletor ) { res.status( 400 ).json( { status: 'error', message: 'Deletor required!' } ); return; }

          // Validate tenant + deletor
          const tenantDoc = await TenantModel.findOne( { username } );
          if ( !tenantDoc ) { res.status( 404 ).json( { status: 'error', message: 'Tenant not found!' } ); return; }
          const deletorDoc = await UserModel.findOne( { username: deletor } );
          if ( !deletorDoc ) { res.status( 404 ).json( { status: 'error', message: 'Deletor not found!' } ); return; }

          // Load leases
          const leases = await LeaseModel.find( { 'tenantInformation.tenantUsername': username } ).lean();
          const snapshot = { tenant: tenantDoc, leases };

          // Prepare recyclebin
          const tenantRecycleRoot = this.safeJoin( this.TENANT_RECYCLE_ROOT, username );
          await this.ensureDir( tenantRecycleRoot );

          // Append tenant export json
          const tenantDataJson = this.safeJoin( tenantRecycleRoot, 'data.json' );
          const todayISO = new Date().toISOString();
          const tenantExport = { date: todayISO, tenant: tenantDoc };

          if ( fs.existsSync( tenantDataJson ) ) {
            const existing = JSON.parse( await fs.promises.readFile( tenantDataJson, 'utf-8' ) );
            const arr = Array.isArray( existing ) ? existing : [ existing ];
            arr.push( tenantExport );
            await fs.promises.writeFile( tenantDataJson, JSON.stringify( arr, null, 2 ) );
          } else {
            await fs.promises.writeFile( tenantDataJson, JSON.stringify( [ tenantExport ], null, 2 ) );
          }

          // Export leases JSON and move lease folders to recyclebin
          if ( leases.length > 0 ) {
            const tenantLeasesRecycleRoot = this.safeJoin( this.TENANT_RECYCLE_LEASES_ROOT, username );
            await this.ensureDir( tenantLeasesRecycleRoot );

            const leasesDBPath = this.safeJoin( tenantLeasesRecycleRoot, 'leasesDB.json' );
            if ( fs.existsSync( leasesDBPath ) ) {
              const existing = JSON.parse( await fs.promises.readFile( leasesDBPath, 'utf-8' ) );
              const merged = Array.isArray( existing ) ? existing.concat( leases ) : leases;
              await fs.promises.writeFile( leasesDBPath, JSON.stringify( merged, null, 2 ) );
            } else {
              await fs.promises.writeFile( leasesDBPath, JSON.stringify( leases, null, 2 ) );
            }

            // Move each lease folder
            const stamp = this.makeStamp();
            for ( const lease of leases ) {
              const leaseID = ( lease as any ).leaseID;
              const srcLeaseRoot = this.safeJoin( this.LEASE_UPLOAD_ROOT, leaseID );
              const destLeaseRoot = this.safeJoin( this.TENANT_RECYCLE_LEASES_ROOT, username, `${ stamp }-${ leaseID }` );

              if ( fs.existsSync( srcLeaseRoot ) ) {
                try {
                  await this.movePath( srcLeaseRoot, destLeaseRoot );
                } catch ( e ) {
                  console.warn( `Failed to move lease folder ${ leaseID }`, e );
                }
              } else {
                console.warn( `Lease files source not found (skipped): ${ srcLeaseRoot }` );
              }
            }

            // Remove lease rows after exporting
            await LeaseModel.deleteMany( { 'tenantInformation.tenantUsername': username } );
          }

          // Notify deletion summary
          try {
            const organisedMetadata: any = {
              deletor: deletorDoc,
              deletedAt: todayISO,
              tenantRecycleRoot,
              leasesRecycleRoot: this.safeJoin( this.TENANT_RECYCLE_LEASES_ROOT, username ),
            };
            const notificationService = new NotificationService();
            const io = req.app.get( 'io' ) as import( 'socket.io' ).Server;
            await notificationService.createNotification(
              {
                title: 'Delete Tenant',
                body: `Tenant ${ username } has been deleted.`,
                type: 'delete',
                severity: 'warning',
                audience: { mode: 'role', roles: [ 'admin', 'agent', 'manager', 'operator' ] },
                channels: [ 'inapp', 'email' ],
                metadata: { refId: username, data: { snapshot, image: ( tenantDoc as any ).image, tenant: tenantDoc, data: organisedMetadata } },
              },
              ( rooms, payload ) => rooms.forEach( room => io?.to( room ).emit( 'notification.new', payload ) ),
            );
          } catch { /* non-fatal */ }

          // Finally delete the tenant row
          await TenantModel.findOneAndDelete( { username } );

          res.status( 200 ).json( {
            status: 'success',
            message: 'Tenant and related lease records moved to recyclebin and removed from DB.',
          } );
          return;
        } catch ( error ) {
          console.error( 'delete-tenant error:', error );
          const message = error instanceof Error ? error.message : 'Unexpected error occurred during tenant deletion.';
          res.status( 500 ).json( { status: 'error', message } );
          return;
        }
      },
    );
  }

  // ===========================================================================
  // POST /create-complaint
  // FE sends:
  //   data            : JSON string
  //   attachmentCount : stringified number
  //   attachments     : up to 10 files (<=10MB each), images/docs allowed
  // Files stored at:
  //   /public/uploads/tenants/<tenantId>/complaints/<code>/attachments
  // ===========================================================================
  private createComplaint(): void {
    const attachmentsUploader = this.buildComplaintUploader();

    this.router.post( '/create-complaint', attachmentsUploader, async ( req: Request, res: Response ) => {
      try {
        // 1) Parse and validate body
        const raw = ( req.body?.data ?? '' ).toString().trim();
        if ( !raw ) { res.status( 400 ).json( { success: false, message: 'Missing data payload' } ); return; }

        let payload: any;
        try {
          payload = JSON.parse( raw );
        } catch {
          res.status( 400 ).json( { success: false, message: 'Invalid JSON in data payload' } );
          return;
        }

        const attachmentCountStr = ( req.body?.attachmentCount ?? '' ).toString().trim();
        if ( !attachmentCountStr || isNaN( Number( attachmentCountStr ) ) ) {
          res.status( 400 ).json( { success: false, message: 'attachmentCount must be a valid number' } );
          return;
        }
        const expectedCount = Number( attachmentCountStr );

        // 2) Extract & validate required fields
        const tenantId = ( payload.tenantId ?? '' ).toString().trim();
        const propertyId = ( payload.propertyId ?? '' ).toString().trim();
        const title = ( payload.title ?? '' ).toString().trim();
        const description = ( payload.description ?? '' ).toString().trim();
        const category = ( payload.category ?? '' ).toString().trim();
        const priority = ( payload.priority ?? 'medium' ).toString().trim().toLowerCase();
        const status = ( payload.status ?? 'new' ).toString().trim().toLowerCase();
        const assigneeId = ( payload.assigneeId ?? '' ).toString().trim();
        const dueAtISO = ( payload.dueAt ?? '' ).toString().trim();
        const leaseId = ( payload.leaseId ?? '' ).toString().trim();

        const tenantName = ( payload.tenantName ?? '' ).toString().trim() || undefined;
        const propertyName = ( payload.propertyName ?? '' ).toString().trim() || undefined;
        const assigneeName = ( payload.assigneeName ?? '' ).toString().trim() || undefined;

        if ( !tenantId ) { res.status( 400 ).json( { success: false, message: 'tenantId is required' } ); return; }
        if ( !propertyId ) { res.status( 400 ).json( { success: false, message: 'propertyId is required' } ); return; }
        if ( !title ) { res.status( 400 ).json( { success: false, message: 'title is required' } ); return; }
        if ( !leaseId ) { res.status( 400 ).json( { success: false, message: 'leaseId is required' } ); return; }
        if ( !description ) { res.status( 400 ).json( { success: false, message: 'description is required' } ); return; }
        if ( !this.isValidCategory( category ) ) { res.status( 400 ).json( { success: false, message: 'Invalid category' } ); return; }
        if ( !this.isValidPriority( priority ) ) { res.status( 400 ).json( { success: false, message: 'Invalid priority' } ); return; }

        // 3) Create complaint doc (authoritative code)
        const code = ( payload.code ?? '' ).toString().trim() || this.generateCode();

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
          assigneeId: assigneeId || null,
          dueAt: dueAtISO ? new Date( dueAtISO ) : null,
          attachments: [],
          comments: [],
          timeline: [ {
            at: new Date(),
            fromStatus: 'new',
            toStatus: 'new',
            byUserId: assigneeId || tenantId,
            note: 'Complaint created',
          } ],
        } );

        // 4) Handle attachments
        const filesMap = ( req.files as Record<string, Express.Multer.File[]> ) || {};
        const files = filesMap[ 'attachments' ] || [];

        if ( files.length !== expectedCount ) {
          res.status( 400 ).json( {
            success: false,
            message: `attachmentCount mismatch: expected ${ expectedCount }, received ${ files.length }`,
          } );
          return;
        }

        if ( files.length > 0 ) {
          const baseURL = `${ req.protocol }://${ req.get( 'host' ) }`;
          const baseDir = this.safeJoin( this.UPLOADS_ROOT, 'tenants', doc.tenantId, 'complaints', doc.code, 'attachments' );
          await fse.ensureDir( baseDir );

          for ( const f of files ) {
            // Defense-in-depth (fileFilter already validated)
            if ( !this.isAllowedAttachmentType( f.mimetype ) ) {
              res.status( 400 ).json( { success: false, message: `Unsupported file type: ${ f.mimetype }` } );
              return;
            }

            const rawName = ( f.originalname || 'file' ).toString();
            const cleanBase = ( rawName.replace( /[^\w.\- ]+/g, '_' ).trim() || 'file' ).replace( /\.[^.]+$/, '' );
            const extFromName = path.extname( rawName ).toLowerCase();
            const extFromMime = this.mimeToExt( f.mimetype );
            const ext = extFromName || extFromMime || '';
            const storedName = ext ? `${ randomUUID() }-${ cleanBase }${ ext }` : `${ randomUUID() }-${ cleanBase }`;

            await fse.writeFile( path.join( baseDir, storedName ), f.buffer );

            ( doc as any ).attachments.push( {
              name: cleanBase + ( ext || '' ),
              mimetype: f.mimetype,
              size: f.size,
              url: `${ baseURL }/uploads/tenants/${ encodeURIComponent( doc.tenantId ) }/complaints/${ encodeURIComponent( doc.code ) }/attachments/${ encodeURIComponent( storedName ) }`,
            } );
          }

          await ( doc as any ).save?.();
        }

        // 5) Prepare response with optional display names
        const response = ( doc as any ).toClient
          ? ( doc as any ).toClient( { tenantName, propertyName, assigneeName } )
          : doc;

        // 6) Broadcast notification (non-fatal if missing socket)
        try {
          const notificationService = new NotificationService();
          const io = req.app.get( 'io' ) as import( 'socket.io' ).Server;
          await notificationService.createNotification(
            {
              title: 'New Complaint',
              body: `New complaint ${ doc.code } has been created by tenant ${ tenantId }.`,
              type: 'create',
              severity: 'info',
              audience: { mode: 'role', roles: [ 'admin', 'agent', 'manager', 'operator', 'developer' ], usernames: [ tenantId ] },
              channels: [ 'inapp', 'email' ],
              metadata: { refId: doc.code, data: { snapshot: doc } },
            },
            ( rooms, payload ) => rooms.forEach( room => io?.to( room ).emit( 'notification.new', payload ) ),
          );
        } catch { /* ignore */ }

        res.status( 201 ).json( { success: true, message: 'Complaint created', data: response, meta: leaseId ? { leaseId } : undefined } );
        return;
      } catch ( error: any ) {
        console.error( 'create-complaint error:', error );
        res.status( 500 ).json( {
          success: false,
          message: 'Internal server error while creating complaint',
          errors: { reason: error?.message || 'Unknown error' },
        } );
        return;
      }
    } );
  }


  // ===========================================================================
  // GET /complaint/:complaintID
  // ===========================================================================
  private getComplaintById(): void {
    this.router.get( '/complaint/:complaintID', async ( req: Request<{ complaintID: string; }>, res: Response ) => {
      try {
        const complaintID = ( req.params.complaintID || '' ).toString().trim();
        if ( !complaintID ) { res.status( 400 ).json( { success: false, message: 'complaintID is required' } ); return; }

        const complaintDoc = await ComplaintModel.findOne( { code: complaintID } ).lean();
        if ( !complaintDoc ) { res.status( 404 ).json( { success: false, message: 'Complaint not found' } ); return; }

        res.status( 200 ).json( { success: true, message: 'Complaint fetched successfully', data: complaintDoc } );
        return;
      } catch ( error ) {
        console.error( 'get-complaint-by-id error:', error );
        res.status( 500 ).json( { success: false, message: 'Internal server error while fetching complaint', errors: { reason: error || 'Unknown error' } } );
        return;
      }
    } );
  }


  // ===========================================================================
  // GET /complaints/tenant/:username
  // ===========================================================================
  private getAllComplaintsByTenantUsername(): void {
    this.router.get( '/complaints/tenant/:username', async ( req: Request<{ username: string; }>, res: Response ) => {
      try {
        const username = ( req.params.username || '' ).toString().trim();
        if ( !username ) { res.status( 400 ).json( { success: false, message: 'username is required' } ); return; }

        const start = req.query.start ? parseInt( req.query.start as string, 10 ) : 0;

        const limit = req.query.limit ? parseInt( req.query.limit as string, 10 ) : 50;

        const search = req.query.search ? ( req.query.search as string ).toString().trim().toLowerCase() : '';

        const filter: FilterQuery<IComplaint> = {};

        if ( search ) {
          const rx = new RegExp( search, 'i' );
          filter.$or = [
            { code: { $regex: rx } },
            { title: { $regex: rx } },
            { description: { $regex: rx } },
            { category: { $regex: rx } },
            { status: { $regex: rx } },
          ];
        }

        // const complaints = await ComplaintModel.find({tenantId: username}).lean();

        const [ complaints, total ] = await Promise.all( [
          ComplaintModel.find( { ...filter, tenantId: username } ).sort( { createdAt: -1 } ).skip( start ).limit( limit ).lean().exec(),
          ComplaintModel.countDocuments( { ...filter, tenantId: username } ),
        ] );

        res.status( 200 ).json( { status: 'success', message: 'Complaints fetched successfully', data: { complaints, total } } );
        return;
      } catch ( error ) {
        console.error( 'get-all-complaints-by-tenant-username error:', error );
        res.status( 500 ).json( { status: 'error', message: 'Internal server error while fetching complaints', errors: { reason: error || 'Unknown error' } } );
        return;
      }
    } );
  }

  // ===========================================================================
  // GET /complaints-count/tenant/:username
  // ===========================================================================
  private getAllComplaintsCountByTenantUsername(): void {
    this.router.get( '/complaints/tenant/:username', async ( req: Request<{ username: string; }>, res: Response ) => {
      try {
        const username = ( req.params.username || '' ).toString().trim();
        if ( !username ) { res.status( 400 ).json( { success: false, message: 'username is required' } ); return; }

        const total = await ComplaintModel.countDocuments( { tenantId: username } );

        res.status( 200 ).json( { status: 'success', message: 'Complaints count fetched successfully', data: { total } } );
        return;
      } catch ( error ) {
        console.error( 'get-all-complaints-by-tenant-username error:', error );
        res.status( 500 ).json( { status: 'error', message: 'Internal server error while fetching complaints count', errors: { reason: error || 'Unknown error' } } );
        return;
      }
    } );
  }

  // ===========================================================================
  // GET /complaints/all
  // ===========================================================================
  private getAllComplaints(): void {
    this.router.get( '/complaints/all', async ( _req: Request, res: Response ) => {
      try {
        const start = _req.query.start ? parseInt( _req.query.start as string, 10 ) : 0;

        const limit = _req.query.limit ? parseInt( _req.query.limit as string, 10 ) : 100;

        const search = _req.query.search ? ( _req.query.search as string ).toString().trim().toLowerCase() : '';

        const filter: FilterQuery<IComplaint> = {};

        if ( search ) {
          const rx = new RegExp( search, 'i' );
          filter.$or = [
            { code: { $regex: rx } },
            { title: { $regex: rx } },
            { description: { $regex: rx } },
            { category: { $regex: rx } },
            { status: { $regex: rx } },
          ];
        }

        // Fetch sorted (newest first)
        const [ items, total ] = await Promise.all( [
          ComplaintModel
            .find( { ...filter } )
            .sort( { createdAt: -1 } )
            .skip( start )
            .limit( limit )
            .lean()
            .exec(),
          ComplaintModel.countDocuments( { ...filter } )
        ] );

        res.status( 200 ).json( {
          success: true,
          status: 'success',
          message: 'Complaints fetched successfully',
          data: { items, total }
        } );
        return;
      } catch ( error ) {
        console.error( 'get-all-complaints:', error );
        res.status( 500 ).json( {
          success: false,
          status: 'error',
          message: 'Internal server error while fetching complaints',
          errors: { reason: ( error as Error )?.message ?? 'Unknown error' }
        } );
        return;
      }
    } );
  }

  // ===========================================================================
  // GET /complaints-count/all
  // ===========================================================================
  private getAllComplaintsCount(): void {
    this.router.get( '/complaints-count/all', async ( _req: Request, res: Response ) => {
      try {
        // Fetch sorted (newest first)
        const total = await ComplaintModel.countDocuments( {} );

        res.status( 200 ).json( {
          success: true,
          status: 'success',
          message: 'Complaints count fetched successfully',
          data: { total }
        } );
        return;
      } catch ( error ) {
        console.error( 'get-all-complaints:', error );
        res.status( 500 ).json( {
          success: false,
          status: 'error',
          message: 'Internal server error while fetching complaints',
          errors: { reason: ( error as Error )?.message ?? 'Unknown error' }
        } );
        return;
      }
    } );
  }

  // ===========================================================================
  // GET /complaints-by-section/all/:section
  // ===========================================================================
  private getAllComplaintsBySection(): void {
    this.router.get(
      '/complaints-by-section/all/:section',
      async (
        req: Request<{ section: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          // -----------------------------
          // 1) Sanitize section
          // -----------------------------
          const section = req.params.section?.trim().toLowerCase();

          if ( !section ) {
            res.status( 400 ).json( {
              success: false,
              status: 'error',
              message: 'Section is invalid!',
            } );
            return;
          }

          // -----------------------------
          // 2) Build PROJECTION correctly
          // -----------------------------
          const projection: Record<string, 1 | 0> = {
            [ section ]: 1,
            _id: 0,
          };

          // -----------------------------
          // 3) Fetch correct data
          // -----------------------------
          const [ complaints, total ] = await Promise.all( [
            ComplaintModel.find( {}, projection ).lean(),
            ComplaintModel.countDocuments(),
          ] );

          // -----------------------------
          // 4) Return success
          // -----------------------------
          res.status( 200 ).json( {
            success: true,
            status: 'success',
            message: 'Complaints fetched successfully by section',
            data: { total, complaints },
          } );
        } catch ( error ) {
          console.error( 'get-all-complaints:', error );

          res.status( 500 ).json( {
            success: false,
            status: 'error',
            message: 'Internal server error while fetching complaints',
            errors: {
              reason: ( error as Error )?.message ?? 'Unknown error',
            },
          } );

          return;
        }
      }
    );
  }


  // ===========================================================================
  // POST /complaints/post-comments
  // Body (multipart/form-data):
  //   - complaint         : JSON string with { tenantID, code, byUserId, byName, audience? }
  //   - comment           : string (message)
  //   - attachmentCount   : stringified number (must match uploaded files)
  //   - attachments[]     : optional files (<=10MB each, max 10; allowed images/docs)
  // Behavior:
  //   • Validates inputs
  //   • Writes files to: /public/uploads/tenants/<tenantID>/complaints/<code>/comments
  //   • Pushes a new comment object into complaint.comments[]
  //   • Rolls back written files if DB update fails
  // ===========================================================================
  private postComment(): void {
    const attachmentsUploader = this.buildComplaintUploader();

    this.router.post( '/complaints/post-comments', attachmentsUploader, async ( req: Request, res: Response ) => {
      try {
        // 1) Parse complaint reference JSON
        type IncomingComplaintRef = {
          tenantID?: string;
          code?: string;
          byUserId?: string;
          byName?: string;
          image?: string;
          audience?: ComplaintAudience;
        };

        const complaintRef = this.parseJson<IncomingComplaintRef>( req.body?.complaint, 'Complaint', res );
        if ( !complaintRef ) return;

        const tenantID = ( complaintRef.tenantID ?? '' ).toString().trim();
        const code = ( complaintRef.code ?? '' ).toString().trim();
        const byUserId = ( complaintRef.byUserId ?? '' ).toString().trim();
        const byName = ( complaintRef.byName ?? '' ).toString().trim();
        const image = ( complaintRef.image ?? '' ).toString().trim();
        const audience = ( ( complaintRef.audience ?? 'all' ) as ComplaintAudience );

        if ( !tenantID ) { res.status( 400 ).json( { success: false, message: 'Tenant ID is missing' } ); return; }
        if ( !code ) { res.status( 400 ).json( { success: false, message: 'Complaint ID is missing' } ); return; }
        if ( !byUserId || !byName ) { res.status( 400 ).json( { success: false, message: 'byUserId and byName are required' } ); return; }
        if ( !DEFINED_AUDIENCES.includes( audience ) ) {
          res.status( 400 ).json( { success: false, message: 'audience must be internal | tenant | all' } ); return;
        }

        // 2) Validate text content
        const rawComment = ( req.body?.comment ?? '' ).toString().trim();
        if ( !rawComment ) { res.status( 400 ).json( { success: false, message: 'Comment cannot be empty' } ); return; }
        if ( rawComment.length > 5000 ) {
          res.status( 400 ).json( { success: false, message: 'Comment is too long (max 5000 chars)' } ); return;
        }

        // 3) Validate attachment count vs actual uploads
        const attachmentCountStr = ( req.body?.attachmentCount ?? '' ).toString().trim();
        if ( !attachmentCountStr || isNaN( Number( attachmentCountStr ) ) ) {
          res.status( 400 ).json( { success: false, message: 'attachmentCount must be a valid number' } );
          return;
        }
        const expectedCount = Number( attachmentCountStr );

        const filesMap = ( req.files as Record<string, Express.Multer.File[]> ) || {};
        const files = filesMap[ 'attachments' ] || [];

        if ( files.length !== expectedCount ) {
          res.status( 400 ).json( {
            success: false,
            message: `attachmentCount mismatch: expected ${ expectedCount }, received ${ files.length }`,
          } );
          return;
        }

        // 4) Confirm complaint existence early (cheap query)
        const exists = await ComplaintModel.exists( { code } );
        if ( !exists ) { res.status( 404 ).json( { success: false, message: `Complaint not found for code: ${ code }` } ); return; }

        // 5) Write files (if any) to comments folder
        const baseDir = this.safeJoin( this.UPLOADS_ROOT, 'tenants', tenantID, 'complaints', code, 'comments' );
        await fse.ensureDir( baseDir );

        const written: string[] = []; // track written absolute paths for rollback
        const attachments: Array<{
          name: string;
          mimetype: string;
          size: number;
          url: string;
          relPath: string;
        }> = [];

        for ( const f of files ) {
          // Defense-in-depth (fileFilter already validated)
          if ( !this.isAllowedAttachmentType( f.mimetype ) ) {
            res.status( 400 ).json( { success: false, message: `Unsupported file type: ${ f.mimetype }` } );
            return;
          }

          const rawName = ( f.originalname || 'file' ).toString();
          const cleanBase = ( rawName.replace( /[^\w.\- ]+/g, '_' ).trim() || 'file' ).replace( /\.[^.]+$/, '' );
          const extFromName = path.extname( rawName ).toLowerCase();
          const extFromMime = this.mimeToExt( f.mimetype );
          const ext = extFromName || extFromMime || '';
          const storedName = ext ? `${ randomUUID() }-${ cleanBase }${ ext }` : `${ randomUUID() }-${ cleanBase }`;

          const fullPath = path.join( baseDir, storedName );
          await fse.writeFile( fullPath, f.buffer );
          written.push( fullPath );

          const refs = this.buildFileRefs( req, tenantID, code, storedName );
          attachments.push( {
            name: cleanBase + ( ext || '' ),
            mimetype: f.mimetype,
            size: f.size,
            url: refs.url,
            relPath: refs.relPath,
          } );
        }

        // 6) Construct the comment object
        const newComment = {
          byUserId,
          byName,
          audience,
          image,
          message: rawComment,
          createdAt: new Date().toISOString(),
          attachments: attachments.length ? attachments : undefined,
        };

        // 7) Push the comment atomically and bump updatedAt
        const updated = await ComplaintModel.findOneAndUpdate(
          { code },
          {
            $push: { comments: newComment },
            $set: { updatedAt: new Date().toISOString() },
          },
          { new: true, projection: { comments: { $slice: -1 } } } // only last comment back
        ).lean();

        if ( !updated ) {
          // Rollback files if DB write failed (race/removed complaint)
          for ( const p of written ) { await fse.remove( p ).catch( () => void 0 ); }
          res.status( 404 ).json( { success: false, message: `Complaint not found for code: ${ code }` } );
          return;
        }

        const created = ( updated as any )?.comments?.[ 0 ] ?? newComment;

        const notificationService = new NotificationService();
        const io = req.app.get( 'io' ) as import( 'socket.io' ).Server;
        await notificationService.createNotification(
          {
            title: 'New Comment',
            body: `New comment ${ code } has been created by ${ newComment.byName }.`,
            type: 'create',
            severity: 'info',
            audience: { mode: 'role', roles: [ 'admin', 'agent', 'manager', 'operator', 'developer' ], usernames: [ tenantID ] },
            channels: [ 'inapp', 'email' ],
            metadata: { refId: code, data: { snapshot: created } },
          },
          ( rooms, payload ) => rooms.forEach( room => io?.to( room ).emit( 'notification.new', payload ) ),
        );

        res.status( 200 ).json( {
          success: true,
          status: 'success',
          message: 'Comment posted successfully',
          data: {
            code,
            comment: created,
          },
        } );
        return;
      } catch ( error ) {
        console.error( 'post-comments:', error );
        res.status( 500 ).json( {
          success: false,
          status: 'error',
          message: 'Internal server error while posting comment',
          errors: { reason: ( error as Error )?.message ?? 'Unknown error' }
        } );
        return;
      }
    } );
  }

  // Clamp & parse "limit" safely (defaults to 10, max 50)
  private parseLimit( raw: unknown, def = 10, min = 1, max = 50 ): number {
    const n = Number( raw );
    if ( Number.isFinite( n ) ) return Math.min( Math.max( Math.trunc( n ), min ), max );
    return def;
  }

  // Encode the paging cursor (opaque base64)
  private encodeCursor( createdAt: Date, id: import( 'mongoose' ).Types.ObjectId ): string {
    const payload = { t: createdAt.toISOString(), id: id.toString() };
    return Buffer.from( JSON.stringify( payload ), 'utf8' ).toString( 'base64' );
  }

  // Decode the paging cursor; returns null if invalid
  // Keep the same return type: { t: Date; id?: import('mongoose').Types.ObjectId } | null
  private decodeCursor(
    raw?: string | null
  ): { t: Date; id?: import( 'mongoose' ).Types.ObjectId; } | null {
    if ( !raw ) return null;

    try {
      const txt = Buffer.from( String( raw ), 'base64' ).toString( 'utf8' );
      const obj = JSON.parse( txt ) as { t?: string; id?: string; };
      if ( !obj?.t ) return null;

      const t = new Date( obj.t );
      if ( Number.isNaN( t.getTime() ) ) return null;

      const mongoose = require( 'mongoose' ) as typeof import( 'mongoose' );

      // Build the payload without 'id' first
      const base: { t: Date; id?: import( 'mongoose' ).Types.ObjectId; } = { t };

      if ( obj.id && mongoose.isValidObjectId( obj.id ) ) {
        // Only add 'id' property when we actually have one (do not set undefined)
        base.id = new mongoose.Types.ObjectId( obj.id );
      }

      return base;
    } catch {
      // Legacy fallback: accept ISO date or ObjectId in plain form
      const mongoose = require( 'mongoose' ) as typeof import( 'mongoose' );

      if ( mongoose.isValidObjectId( raw ) ) {
        return {
          t: new Date( '9999-12-31T23:59:59.999Z' ),
          id: new mongoose.Types.ObjectId( raw ), // included only when present
        };
      }

      const t = new Date( raw as string );
      if ( !Number.isNaN( t.getTime() ) ) {
        return { t }; // no 'id' property at all
      }
      return null;
    }
  }



  // ===========================================================================
  // GET /complaints/:code/comments
  // Query: ?limit=10&cursor=<opaque-base64>
  // Returns newest -> older.
  // Pagination rule: if cursor present, return comments with
  //   (createdAt < cursor.t) OR (createdAt == cursor.t AND _id < cursor.id)
  // ===========================================================================
  private getCommentsBasedOnComplaintCode(): void {
    this.router.get( '/complaints/:code/comments', async (
      req: Request<{ code: string; }>,
      res: Response
    ) => {
      try {
        const code = ( req.params.code || '' ).toString().trim();
        if ( !code ) { res.status( 400 ).json( { success: false, message: 'Invalid complaint code' } ); return; }

        const limit = this.parseLimit( req.query.limit, 10, 1, 50 );
        const cursor = this.decodeCursor( ( req.query.cursor as string ) || null );

        // Build a pipeline that pages over embedded comments
        const matchBase: any = { code };
        const cursorMatch: any = {};

        if ( cursor?.t ) {
          // createdAt must be Date in DB; if it's stored as string, $toDate in $addFields then match
          cursorMatch.$or = [
            { 'comments.createdAt': { $lt: cursor.t } },
            ...( cursor.id
              ? [ {
                $and: [
                  { 'comments.createdAt': cursor.t },
                  { 'comments._id': { $lt: cursor.id } }
                ]
              } ]
              : [] )
          ];
        }

        const pipeline: any[] = [
          { $match: matchBase },
          { $unwind: '$comments' },

          // If your schema stores createdAt as String, convert it once for sorting/matching:
          // { $addFields: { 'comments._createdAt': { $toDate: '$comments.createdAt' } } },

          // Apply cursor window if present
          ...( cursorMatch.$or ? [ { $match: cursorMatch } ] : [] ),

          // Sort newest → older (tie-break on _id for stable order)
          { $sort: { 'comments.createdAt': -1, 'comments._id': -1 } },

          // Page size
          { $limit: limit },

          // Only send the comment subdocument
          { $replaceWith: '$comments' },
        ];

        // Run aggregation
        const items = await ComplaintModel.aggregate( pipeline ).exec();

        // Compute nextCursor + hasMore
        let nextCursor: string | undefined;
        let hasMore = false;

        if ( items.length > 0 ) {
          const last = items[ items.length - 1 ];
          const createdAt: Date = new Date( last.createdAt );
          const id = ( last as any )._id;
          nextCursor = this.encodeCursor( createdAt, id );

          // Lightweight “has more” check:
          // Ask for 1 more document beyond the last boundary
          const tailMatch: any = {
            code,
          };
          const tailWindow: any = {
            $or: [
              { 'comments.createdAt': { $lt: createdAt } },
              {
                $and: [
                  { 'comments.createdAt': createdAt },
                  { 'comments._id': { $lt: id } }
                ]
              }
            ]
          };

          const morePipeline = [
            { $match: tailMatch },
            { $unwind: '$comments' },
            { $match: tailWindow },
            { $limit: 1 },
            { $project: { _id: 1 } }
          ];

          const more = await ComplaintModel.aggregate( morePipeline ).exec();
          hasMore = more.length > 0;
        }

        res.status( 200 ).json( {
          success: true,
          items,
          nextCursor,
          hasMore,
        } );
        return;
      } catch ( error ) {
        console.error( 'get-comments:', error );
        res.status( 500 ).json( {
          success: false,
          message: 'Internal server error while fetching comments',
          errors: { reason: ( error as Error )?.message ?? 'Unknown error' }
        } );
        return;
      }
    } );
  }

  //___________________________________________________________________________________
  // HELPER METHOS
  //___________________________________________________________________________________

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

}
