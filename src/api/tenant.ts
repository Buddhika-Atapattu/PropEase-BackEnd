// src/api/tenants.ts
// ============================================================================
// Tenants API (PropEase)
// - Insert new tenant
// - Get all tenants
// - Delete tenant  (safe recyclebin move with DB export)
// - Create complaint (multipart: JSON + attachments[0..9])
// - Get complaint by ID
// - Get all complaints for a tenant
// ----------------------------------------------------------------------------
// Design notes:
// • We never delete files outright during destructive ops; we move to /public/recyclebin
// • We export DB rows to JSON in recyclebin for audit/recovery
// • For uploads we use Multer memoryStorage, validate, then persist to final disk paths
// • All routes return JSON and follow the res.status(...).json(...); return; pattern
// • All helpers are class methods; no free functions
// ============================================================================

import express, {Request, Response, Router, NextFunction} from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import * as fse from 'fs-extra';
import path from 'path';
import multer from 'multer';
import {randomUUID} from 'crypto';

import {ITenant, TenantModel} from '../models/tenant.model';
import {LeaseModel} from '../models/lease.model';
import NotificationService from '../services/notification.service';
import {UserModel} from '../models/user.model';
import {ComplaintModel, COMPLAINT_CATEGORIES} from '../models/complaint.model';
import {create} from 'domain';

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
  private readonly PUBLIC_ROOT = path.resolve(__dirname, '../../public');
  private readonly UPLOADS_ROOT = path.join(this.PUBLIC_ROOT, 'uploads');
  private readonly RECYCLEBIN_ROOT = path.join(this.PUBLIC_ROOT, 'recyclebin');

  // Common buckets
  private readonly TENANT_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, 'tenants');
  private readonly TENANT_RECYCLE_ROOT = path.join(this.RECYCLEBIN_ROOT, 'tenants');

  // Recycled leases live under: /public/recyclebin/tenants/leases/<username>/<stamp>-<leaseID>/
  private readonly TENANT_RECYCLE_LEASES_ROOT = path.join(this.TENANT_RECYCLE_ROOT, 'leases');

  // Lease uploads live under: /public/uploads/leases/<leaseID>/
  private readonly LEASE_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, 'leases');

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
    this.insertTenant();     // POST   /insertTenant
    this.getAllTenants();    // GET    /get-all-tenants
    this.deleteTenant();     // DELETE /delete-tenant/:username/:deletor
    this.createComplaint();  // POST   /create-complaint
    this.getComplaintById(); // GET    /complaint/:complaintID
    this.getAllComplaintsByTenantUsername(); // GET /complaints/tenant/:username
    this.getAllComplaints() // GET /complaints/all
  }

  /** Expose router for mounting. */
  public get route(): Router {
    return this.router;
  }

  // ===========================================================================
  // Helpers (paths, fs, validation, naming)
  // ===========================================================================

  /** Safe join under a known root; prevents path traversal. */
  private safeJoin(root: string, ...segments: string[]): string {
    const target = path.resolve(root, ...segments);
    const normalizedRoot = path.resolve(root);
    if(!target.startsWith(normalizedRoot)) {
      throw new Error('Unsafe path resolution detected');
    }
    return target;
  }

  /** mkdir -p */
  private async ensureDir(dir: string): Promise<void> {
    await fs.promises.mkdir(dir, {recursive: true});
  }

  /** Move path with rename(); fallback to copy+remove when cross-device. */
  private async movePath(src: string, dest: string): Promise<void> {
    try {
      await this.ensureDir(path.dirname(dest));
      await fs.promises.rename(src, dest);
    } catch {
      await this.ensureDir(path.dirname(dest));
      await this.copyRecursive(src, dest);
      await this.rmRecursive(src);
    }
  }

  /** Recursive copy (dir or file). */
  private async copyRecursive(src: string, dest: string): Promise<void> {
    const stat = await fs.promises.stat(src);
    if(stat.isDirectory()) {
      await this.ensureDir(dest);
      const entries = await fs.promises.readdir(src);
      for(const entry of entries) {
        await this.copyRecursive(path.join(src, entry), path.join(dest, entry));
      }
    } else {
      await this.ensureDir(path.dirname(dest));
      await fs.promises.copyFile(src, dest);
    }
  }

  /** Recursive remove. */
  private async rmRecursive(target: string): Promise<void> {
    await fs.promises.rm(target, {recursive: true, force: true});
  }

  /** YYYYMMDD-HHMMSS stamp (used in recyclebin folder names). */
  private makeStamp(date = new Date()): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  /** Attachment type validator (images or docs). */
  private isAllowedAttachmentType(mime: string): boolean {
    return this.allowedImageTypes.includes(mime) || this.allowedDocTypes.includes(mime);
  }

  /** Validate complaint category against shared enum list. */
  private isValidCategory(cat: string): boolean {
    return (COMPLAINT_CATEGORIES as readonly string[]).includes(cat);
  }

  /** Validate complaint priority. */
  private isValidPriority(p: string): boolean {
    return ['low', 'medium', 'high', 'urgent'].includes(p);
  }

  /** Server-side complaint code generator. */
  private generateCode(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rnd = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `PROPEASE-CPL-${ts}-${rnd}`;
  }

  /** mime → extension fallback (used when originalname has no ext). */
  private mimeToExt(mime: string): string {
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
    return map[mime] || '';
  }

  // ===========================================================================
  // Multer builder: specifically for complaint creation
  // - memoryStorage, files <=10MB, max 10, field name "attachments"
  // - JSON-ify Multer errors into 400 responses
  // ===========================================================================
  private buildComplaintUploader(): (req: Request, res: Response, next: NextFunction) => void {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB/file
        files: 10,                   // max 10 files
        fields: 20,                  // defensive
      },
      fileFilter: (_req, file, cb) => {
        if(this.isAllowedAttachmentType(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `Unsupported mimetype: ${file.mimetype}`));
        }
      },
    }).fields([{name: 'attachments', maxCount: 10}]);

    return (req, res, next) => {
      upload(req, res, (err: any) => {
        if(!err) return next();
        if(err instanceof multer.MulterError) {
          let message = 'Upload error';
          if(err.code === 'LIMIT_FILE_SIZE') message = 'One or more files exceed the 10MB size limit.';
          else if(err.code === 'LIMIT_FILE_COUNT') message = 'Too many files. Maximum 10 attachments allowed.';
          else if(err.code === 'LIMIT_UNEXPECTED_FILE') message = 'Unexpected or unsupported file received.';
          res.status(400).json({success: false, message, errors: {code: err.code, field: (err as any).field}});
          return;
        }
        res.status(400).json({success: false, message: err?.message || 'Upload failed'});
        return;
      });
    };
  }

  // ===========================================================================
  // POST /insertTenant
  // ===========================================================================
  private insertTenant(): void {
    // Parse only text fields (no file uploads for this route)
    const noFiles = multer().none();

    this.router.post('/insertTenant', noFiles, async (req: Request, res: Response) => {
      try {
        // Extract required fields
        const username = (req.body.username || '').trim();
        const name = (req.body.name || '').trim();
        const image = (req.body.image || '').trim();
        const phoneNumber = (req.body.phoneNumber || '').trim();
        const email = (req.body.email || '').trim();
        const gender = (req.body.gender || '').trim();
        const addedBy = (req.body.addedBy || '').trim();

        // Validate
        if(!username) {res.status(400).json({status: 'error', message: 'Username required!'}); return;}
        if(!name) {res.status(400).json({status: 'error', message: 'Name required!'}); return;}
        if(!image) {res.status(400).json({status: 'error', message: 'Image required!'}); return;}
        if(!phoneNumber) {res.status(400).json({status: 'error', message: 'Phone number required!'}); return;}
        if(!email) {res.status(400).json({status: 'error', message: 'Email required!'}); return;}
        if(!gender) {res.status(400).json({status: 'error', message: 'Gender required!'}); return;}
        if(!addedBy) {res.status(400).json({status: 'error', message: 'Added by required!'}); return;}

        // Clear any previous recyclebin bucket for this user (fresh start)
        const recycleBinForTenant = this.safeJoin(this.TENANT_RECYCLE_ROOT, username);
        if(fs.existsSync(recycleBinForTenant)) {
          await this.rmRecursive(recycleBinForTenant);
        }

        // Persist DB row
        const tenantDoc: ITenant = new TenantModel({
          username,
          image,
          name,
          contactNumber: phoneNumber,
          email,
          gender,
          addedBy,
        });
        await (tenantDoc as any).save?.();

        // Broadcast notification
        try {
          const notificationService = new NotificationService();
          const io = req.app.get('io') as import('socket.io').Server;
          await notificationService.createNotification(
            {
              title: 'New Tenant',
              body: `A new tenant named ${tenantDoc.name} has been added.`,
              type: 'create',
              severity: 'info',
              audience: {mode: 'role', roles: ['admin', 'agent', 'manager', 'operator'], usernames: [tenantDoc.username]},
              channels: ['inapp', 'email'],
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
            (rooms, payload) => rooms.forEach(room => io?.to(room).emit('notification.new', payload)),
          );
        } catch { /* non-fatal */}

        res.status(200).json({status: 'success', message: 'Tenant added successfully', data: tenantDoc});
        return;
      } catch(error) {
        console.error('insertTenant error:', error);
        res.status(500).json({status: 'error', message: `Error: ${error instanceof Error ? error.message : error}`});
        return;
      }
    });
  }

  // ===========================================================================
  // GET /get-all-tenants
  // ===========================================================================
  private getAllTenants(): void {
    this.router.get('/get-all-tenants', async (_req: Request, res: Response) => {
      try {
        const tenants = await TenantModel.find().lean();
        if(!tenants || tenants.length === 0) {
          res.status(404).json({status: 'error', message: 'No tenants found'});
          return;
        }
        res.status(200).json({status: 'success', message: 'Tenants fetched successfully', data: tenants});
        return;
      } catch(error) {
        console.error('get-all-tenants error:', error);
        res.status(500).json({status: 'error', message: `Error: ${error instanceof Error ? error.message : error}`});
        return;
      }
    });
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
      async (req: Request<{username: string; deletor: string}>, res: Response) => {
        try {
          // Params
          const username = (req.params.username || '').trim();
          const deletor = (req.params.deletor || '').trim();
          if(!username) {res.status(400).json({status: 'error', message: 'Username required!'}); return;}
          if(!deletor) {res.status(400).json({status: 'error', message: 'Deletor required!'}); return;}

          // Validate tenant + deletor
          const tenantDoc = await TenantModel.findOne({username});
          if(!tenantDoc) {res.status(404).json({status: 'error', message: 'Tenant not found!'}); return;}
          const deletorDoc = await UserModel.findOne({username: deletor});
          if(!deletorDoc) {res.status(404).json({status: 'error', message: 'Deletor not found!'}); return;}

          // Load leases
          const leases = await LeaseModel.find({'tenantInformation.tenantUsername': username}).lean();
          const snapshot = {tenant: tenantDoc, leases};

          // Prepare recyclebin
          const tenantRecycleRoot = this.safeJoin(this.TENANT_RECYCLE_ROOT, username);
          await this.ensureDir(tenantRecycleRoot);

          // Append tenant export json
          const tenantDataJson = this.safeJoin(tenantRecycleRoot, 'data.json');
          const todayISO = new Date().toISOString();
          const tenantExport = {date: todayISO, tenant: tenantDoc};

          if(fs.existsSync(tenantDataJson)) {
            const existing = JSON.parse(await fs.promises.readFile(tenantDataJson, 'utf-8'));
            const arr = Array.isArray(existing) ? existing : [existing];
            arr.push(tenantExport);
            await fs.promises.writeFile(tenantDataJson, JSON.stringify(arr, null, 2));
          } else {
            await fs.promises.writeFile(tenantDataJson, JSON.stringify([tenantExport], null, 2));
          }

          // Export leases JSON and move lease folders to recyclebin
          if(leases.length > 0) {
            const tenantLeasesRecycleRoot = this.safeJoin(this.TENANT_RECYCLE_LEASES_ROOT, username);
            await this.ensureDir(tenantLeasesRecycleRoot);

            const leasesDBPath = this.safeJoin(tenantLeasesRecycleRoot, 'leasesDB.json');
            if(fs.existsSync(leasesDBPath)) {
              const existing = JSON.parse(await fs.promises.readFile(leasesDBPath, 'utf-8'));
              const merged = Array.isArray(existing) ? existing.concat(leases) : leases;
              await fs.promises.writeFile(leasesDBPath, JSON.stringify(merged, null, 2));
            } else {
              await fs.promises.writeFile(leasesDBPath, JSON.stringify(leases, null, 2));
            }

            // Move each lease folder
            const stamp = this.makeStamp();
            for(const lease of leases) {
              const leaseID = (lease as any).leaseID;
              const srcLeaseRoot = this.safeJoin(this.LEASE_UPLOAD_ROOT, leaseID);
              const destLeaseRoot = this.safeJoin(this.TENANT_RECYCLE_LEASES_ROOT, username, `${stamp}-${leaseID}`);

              if(fs.existsSync(srcLeaseRoot)) {
                try {
                  await this.movePath(srcLeaseRoot, destLeaseRoot);
                } catch(e) {
                  console.warn(`Failed to move lease folder ${leaseID}`, e);
                }
              } else {
                console.warn(`Lease files source not found (skipped): ${srcLeaseRoot}`);
              }
            }

            // Remove lease rows after exporting
            await LeaseModel.deleteMany({'tenantInformation.tenantUsername': username});
          }

          // Notify deletion summary
          try {
            const organisedMetadata: any = {
              deletor: deletorDoc,
              deletedAt: todayISO,
              tenantRecycleRoot,
              leasesRecycleRoot: this.safeJoin(this.TENANT_RECYCLE_LEASES_ROOT, username),
            };
            const notificationService = new NotificationService();
            const io = req.app.get('io') as import('socket.io').Server;
            await notificationService.createNotification(
              {
                title: 'Delete Tenant',
                body: `Tenant ${username} has been deleted.`,
                type: 'delete',
                severity: 'warning',
                audience: {mode: 'role', roles: ['admin', 'agent', 'manager', 'operator']},
                channels: ['inapp', 'email'],
                metadata: {refId: username, data: {snapshot, image: (tenantDoc as any).image, tenant: tenantDoc, data: organisedMetadata}},
              },
              (rooms, payload) => rooms.forEach(room => io?.to(room).emit('notification.new', payload)),
            );
          } catch { /* non-fatal */}

          // Finally delete the tenant row
          await TenantModel.findOneAndDelete({username});

          res.status(200).json({
            status: 'success',
            message: 'Tenant and related lease records moved to recyclebin and removed from DB.',
          });
          return;
        } catch(error) {
          console.error('delete-tenant error:', error);
          const message = error instanceof Error ? error.message : 'Unexpected error occurred during tenant deletion.';
          res.status(500).json({status: 'error', message});
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

    this.router.post('/create-complaint', attachmentsUploader, async (req: Request, res: Response) => {
      try {
        // 1) Parse and validate body
        const raw = (req.body?.data ?? '').toString().trim();
        if(!raw) {res.status(400).json({success: false, message: 'Missing data payload'}); return;}

        let payload: any;
        try {
          payload = JSON.parse(raw);
        } catch {
          res.status(400).json({success: false, message: 'Invalid JSON in data payload'});
          return;
        }

        const attachmentCountStr = (req.body?.attachmentCount ?? '').toString().trim();
        if(!attachmentCountStr || isNaN(Number(attachmentCountStr))) {
          res.status(400).json({success: false, message: 'attachmentCount must be a valid number'});
          return;
        }
        const expectedCount = Number(attachmentCountStr);

        // 2) Extract & validate required fields
        const tenantId = (payload.tenantId ?? '').toString().trim();
        const propertyId = (payload.propertyId ?? '').toString().trim();
        const title = (payload.title ?? '').toString().trim();
        const description = (payload.description ?? '').toString().trim();
        const category = (payload.category ?? '').toString().trim();
        const priority = (payload.priority ?? 'medium').toString().trim().toLowerCase();
        const status = (payload.status ?? 'new').toString().trim().toLowerCase();
        const assigneeId = (payload.assigneeId ?? '').toString().trim();
        const dueAtISO = (payload.dueAt ?? '').toString().trim();
        const leaseId = (payload.leaseId ?? '').toString().trim();

        const tenantName = (payload.tenantName ?? '').toString().trim() || undefined;
        const propertyName = (payload.propertyName ?? '').toString().trim() || undefined;
        const assigneeName = (payload.assigneeName ?? '').toString().trim() || undefined;

        if(!tenantId) {res.status(400).json({success: false, message: 'tenantId is required'}); return;}
        if(!propertyId) {res.status(400).json({success: false, message: 'propertyId is required'}); return;}
        if(!title) {res.status(400).json({success: false, message: 'title is required'}); return;}
        if(!leaseId) {res.status(400).json({success: false, message: 'leaseId is required'}); return;}
        if(!description) {res.status(400).json({success: false, message: 'description is required'}); return;}
        if(!this.isValidCategory(category)) {res.status(400).json({success: false, message: 'Invalid category'}); return;}
        if(!this.isValidPriority(priority)) {res.status(400).json({success: false, message: 'Invalid priority'}); return;}

        // 3) Create complaint doc (authoritative code)
        const code = (payload.code ?? '').toString().trim() || this.generateCode();

        const doc = await ComplaintModel.create({
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
          dueAt: dueAtISO ? new Date(dueAtISO) : null,
          attachments: [],
          comments: [],
          timeline: [{
            at: new Date(),
            fromStatus: 'new',
            toStatus: 'new',
            byUserId: assigneeId || tenantId,
            note: 'Complaint created',
          }],
        });

        // 4) Handle attachments
        const filesMap = (req.files as Record<string, Express.Multer.File[]>) || {};
        const files = filesMap['attachments'] || [];

        if(files.length !== expectedCount) {
          res.status(400).json({
            success: false,
            message: `attachmentCount mismatch: expected ${expectedCount}, received ${files.length}`,
          });
          return;
        }

        if(files.length > 0) {
          const baseURL = `${req.protocol}://${req.get('host')}`;
          const baseDir = this.safeJoin(this.UPLOADS_ROOT, 'tenants', doc.tenantId, 'complaints', doc.code, 'attachments');
          await fse.ensureDir(baseDir);

          for(const f of files) {
            // Defense-in-depth (fileFilter already validated)
            if(!this.isAllowedAttachmentType(f.mimetype)) {
              res.status(400).json({success: false, message: `Unsupported file type: ${f.mimetype}`});
              return;
            }

            const rawName = (f.originalname || 'file').toString();
            const cleanBase = (rawName.replace(/[^\w.\- ]+/g, '_').trim() || 'file').replace(/\.[^.]+$/, '');
            const extFromName = path.extname(rawName).toLowerCase();
            const extFromMime = this.mimeToExt(f.mimetype);
            const ext = extFromName || extFromMime || '';
            const storedName = ext ? `${randomUUID()}-${cleanBase}${ext}` : `${randomUUID()}-${cleanBase}`;

            await fse.writeFile(path.join(baseDir, storedName), f.buffer);

            (doc as any).attachments.push({
              name: cleanBase + (ext || ''),
              mimetype: f.mimetype,
              size: f.size,
              url: `${baseURL}/uploads/tenants/${encodeURIComponent(doc.tenantId)}/complaints/${encodeURIComponent(doc.code)}/attachments/${encodeURIComponent(storedName)}`,
            });
          }

          await (doc as any).save?.();
        }

        // 5) Prepare response with optional display names
        const response = (doc as any).toClient
          ? (doc as any).toClient({tenantName, propertyName, assigneeName})
          : doc;

        // 6) Broadcast notification (non-fatal if missing socket)
        try {
          const notificationService = new NotificationService();
          const io = req.app.get('io') as import('socket.io').Server;
          await notificationService.createNotification(
            {
              title: 'New Complaint',
              body: `New complaint ${doc.code} has been created by tenant ${tenantId}.`,
              type: 'create',
              severity: 'info',
              audience: {mode: 'role', roles: ['admin', 'agent', 'manager', 'operator', 'developer'], usernames: [tenantId]},
              channels: ['inapp', 'email'],
              metadata: {refId: doc.code, data: {snapshot: doc}},
            },
            (rooms, payload) => rooms.forEach(room => io?.to(room).emit('notification.new', payload)),
          );
        } catch { /* ignore */}

        res.status(201).json({success: true, message: 'Complaint created', data: response, meta: leaseId ? {leaseId} : undefined});
        return;
      } catch(error: any) {
        console.error('create-complaint error:', error);
        res.status(500).json({
          success: false,
          message: 'Internal server error while creating complaint',
          errors: {reason: error?.message || 'Unknown error'},
        });
        return;
      }
    });
  }

  // ===========================================================================
  // GET /complaint/:complaintID
  // ===========================================================================
  private getComplaintById(): void {
    this.router.get('/complaint/:complaintID', async (req: Request<{complaintID: string}>, res: Response) => {
      try {
        const complaintID = (req.params.complaintID || '').toString().trim();
        if(!complaintID) {res.status(400).json({success: false, message: 'complaintID is required'}); return;}

        const complaintDoc = await ComplaintModel.findOne({code: complaintID}).lean();
        if(!complaintDoc) {res.status(404).json({success: false, message: 'Complaint not found'}); return;}

        res.status(200).json({success: true, message: 'Complaint fetched successfully', data: complaintDoc});
        return;
      } catch(error) {
        console.error('get-complaint-by-id error:', error);
        res.status(500).json({success: false, message: 'Internal server error while fetching complaint', errors: {reason: error || 'Unknown error'}});
        return;
      }
    });
  }

  // ===========================================================================
  // GET /complaints/tenant/:username
  // ===========================================================================
  private getAllComplaintsByTenantUsername(): void {
    this.router.get('/complaints/tenant/:username', async (req: Request<{username: string}>, res: Response) => {
      try {
        const username = (req.params.username || '').toString().trim();
        if(!username) {res.status(400).json({success: false, message: 'username is required'}); return;}

        const complaints = await ComplaintModel.find({tenantId: username}).lean();
        res.status(200).json({status: 'success', message: 'Complaints fetched successfully', data: complaints});
        return;
      } catch(error) {
        console.error('get-all-complaints-by-tenant-username error:', error);
        res.status(500).json({status: 'error', message: 'Internal server error while fetching complaints', errors: {reason: error || 'Unknown error'}});
        return;
      }
    });
  }

  // ===========================================================================
  // GET /complaints/all
  // ===========================================================================
  private getAllComplaints(): void {

    this.router.get('/complaints/all', async (req: Request, res: Response) => {
      try {

        // Fetch sorted (newest first)
        const [items, total] = await Promise.all([
          ComplaintModel
            .find({})
            .sort({createdAt: -1})
            .lean()
            .exec(),
          ComplaintModel.countDocuments({})
        ]);

        res.status(200).json({
          success: true,
          status: 'success',
          message: 'Complaints fetched successfully',
          data: {
            items,
            total
          }
        });
        return;
      } catch(error) {
        console.error('get-all-complaints:', error);
        res.status(500).json({
          success: false,
          status: 'error',
          message: 'Internal server error while fetching complaints',
          errors: {reason: (error as Error)?.message ?? 'Unknown error'}
        });
        return;
      }
    });
  }
}
