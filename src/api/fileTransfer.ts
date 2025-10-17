// src/api/fileTransfer.ts

// ============ IMPORTS (Only what we actually use) ============
import express, {Request, Response, Router} from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import multer from "multer";
import axios from "axios";
import * as libre from "libreoffice-convert";
import {CryptoService} from "../services/crypto.service";
import {FILE, TokenViceData, ScannedFileRecordJSON} from "../models/lease.model";

dotenv.config();

/**
 * FileTransfer
 * - Pure local-disk file management (no DB).
 * - Manages tenant mobile uploads (temp token folder -> final tenant folder).
 * - Keeps a flat /uploads/tenants/<username>/data.json ledger.
 * - Lists recent files for a tenant (last 24h) by scanning the filesystem.
 * - Cleans old token folders automatically.
 * - Converts remote docs to PDF via LibreOffice and streams the result.
 */
export default class FileTransfer {
  // -------------------- Public/static roots --------------------
  // NOTE: Your main server must serve: app.use(express.static(PUBLIC_ROOT))
  private readonly PUBLIC_ROOT = path.resolve(__dirname, "../../public");
  private readonly UPLOADS_ROOT = path.join(this.PUBLIC_ROOT, "uploads");
  private readonly RECYCLEBIN_ROOT = path.join(this.PUBLIC_ROOT, "recyclebin");

  // Tenants
  private readonly TENANT_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, "tenants");
  private readonly TENANT_UPLOAD_DIR_URL = "uploads/tenants"; // used to build public URLs
  private readonly TENANT_RECYCLE_ROOT = path.join(this.RECYCLEBIN_ROOT, "tenants");
  private readonly TENANT_RECYCLE_DIR_URL = "recyclebin/tenants";

  // Leases (kept for parity with your structure — not used for DB)
  private readonly LEASE_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, "leases");
  private readonly LEASE_UPLOAD_DIR_URL = "uploads/leases";
  private readonly LEASE_RECYCLE_ROOT = path.join(this.RECYCLEBIN_ROOT, "leases");
  private readonly LEASE_RECYCLE_DIR_URL = "recyclebin/leases";

  // Users (not used below but you wanted the roots defined)
  private readonly USER_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, "users");
  private readonly USER_UPLOAD_DIR_URL = "uploads/users";
  private readonly USER_RECYCLE_ROOT = path.join(this.RECYCLEBIN_ROOT, "users");
  private readonly USER_RECYCLE_DIR_URL = "recyclebin/users";

  // Properties (not used below but roots are here if needed)
  private readonly PROPERTY_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, "properties");
  private readonly PROPERTY_UPLOAD_DIR_URL = "uploads/properties";
  private readonly PROPERTY_RECYCLE_ROOT = path.join(this.RECYCLEBIN_ROOT, "properties");
  private readonly PROPERTY_RECYCLE_DIR_URL = "recyclebin/properties";

  // -------------------- Express + Services --------------------
  private readonly router: Router;
  private readonly cryptoService: CryptoService = new CryptoService();

  constructor () {
    this.router = express.Router();

    // Register endpoints
    this.registerTenantMobileFileUpload();           // POST /get-tenant-mobile-file-upload/:token
    this.registerRecentUploadsByTenantUsername();    // GET  /get-reason-file-uploads-by-tenant-username/:tenant
    this.registerConvertToPDF();                     // POST /convert-to-pdf

    // Start background cleanup (runs every 5 minutes)
    this.scheduleTokenFolderCleanup();
  }

  // Expose a getter so you can mount it outside: app.use('/files', new FileTransfer().route)
  public get route(): Router {
    return this.router;
  }

  // ======================== SMALL HELPERS ========================

  /** Build "http(s)://host" from request, used for public URLs */
  private getBaseUrl(req: Request): string {
    const host = req.get("host");
    const protocol = req.protocol;
    return `${protocol}://${host}`;
  }

  /** Build an absolute disk path inside /uploads/tenants/<username>/... ; ensure=mkdir -p */
  private buildTenantPath(username: string, ensure = false, ...segments: string[]): string {
    const p = path.join(this.TENANT_UPLOAD_ROOT, username, ...segments);
    if(ensure) fs.mkdirSync(p, {recursive: true});
    return p;
  }

  /** Build a public URL path (relative to /public static) for tenant files */
  private buildTenantUrl(username: string, ...segments: string[]): string {
    return [this.TENANT_UPLOAD_DIR_URL, username, ...segments].join("/");
  }

  /** Return the flat ledger path for a tenant */
  private getTenantDataJsonPath(username: string, ensureDir = true): string {
    const dir = this.buildTenantPath(username, ensureDir);
    return path.join(dir, "data.json");
  }

  /** Sanitize filename and add a unique suffix to avoid collisions */
  private sanitizeFilename(original: string): string {
    const base = original.replace(/\s+/g, "_").replace(/[^\w.\-]/g, "");
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    return `${uniqueSuffix}-${base}`;
  }

  /** Safe read JSON (returns {} if missing or invalid) */
  private async safeReadJSON<T = any>(filePath: string): Promise<T | {}> {
    try {
      if(!fs.existsSync(filePath)) return {};
      const content = await fs.promises.readFile(filePath, "utf8");
      return JSON.parse(content) as T;
    } catch {
      return {};
    }
  }

  /** Append/merge to tenant's flat data.json ledger */
  private async appendToTenantLedger(
    username: string,
    docBatches: ScannedFileRecordJSON[] = [],
    imageUrls: string[] = []
  ): Promise<void> {
    const ledgerPath = this.getTenantDataJsonPath(username, true);
    const existing: any = await this.safeReadJSON<any>(ledgerPath);

    const merged = {
      ...existing,
      username,
      lastUpdated: new Date().toISOString(),
      documents: (existing?.documents ?? []).concat(docBatches),
      images: (existing?.images ?? []).concat(imageUrls),
    };
    await fs.promises.writeFile(ledgerPath, JSON.stringify(merged, null, 2));
  }

  // ================== 1) MOBILE SCAN UPLOAD (TOKEN) ==================
  /**
   * POST /get-tenant-mobile-file-upload/:token
   * Field: image (single)
   * Flow:
   *   1) Client sends encrypted token in URL (contains { tenant, issuedAt })
   *   2) We save to temp: /uploads/tenants/tokens/<token>/scanned/mobile/
   *   3) Move the whole temp folder to /uploads/tenants/<tenant>/scanned/mobile/
   *   4) Build a ScannedFileRecordJSON batch and append it to /uploads/tenants/<tenant>/data.json
   *   5) Respond with the saved metadata (no DB)
   */
  private registerTenantMobileFileUpload(): void {
    // Multer storage that places the raw file into a TEMP token folder
    const storage = multer.diskStorage({
      destination: (req, _file, cb) => {
        const token = req.params.token;
        if(!token) {
          cb(new Error("Token is required in the URL path."), "");
          return;
        }
        const tempUploadPath = path.join(this.TENANT_UPLOAD_ROOT, "tokens", token, "scanned", "mobile");
        fs.mkdirSync(tempUploadPath, {recursive: true});
        cb(null, tempUploadPath);
      },
      filename: (_req, file, cb) => cb(null, this.sanitizeFilename(file.originalname)),
    });

    // Basic filter: accept common image types for mobile scans
    const fileFilter = (_req: Request, file: Express.Multer.File, cb: any) => {
      const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/tiff", "image/svg+xml"];
      if(allowed.includes(file.mimetype)) cb(null, true);
      else cb(new Error(`Unsupported image type: ${file.mimetype}`));
    };

    const upload = multer({storage, fileFilter});

    this.router.post(
      "/get-tenant-mobile-file-upload/:token",
      upload.single("image"),
      async (req: Request<{token: string}>, res: Response) => {
        try {
          // 1) Validate token in URL
          const encryptedToken = decodeURIComponent(req.params.token ?? "");
          if(!encryptedToken) {
            res.status(400).json({status: "error", message: "Token is required!"});
            return;
          }

          // 2) Decrypt token => { tenant, issuedAt }
          const decrypted = await this.cryptoService.decrypt(encryptedToken);
          const parsed = JSON.parse(decrypted) as {tenant?: string; issuedAt?: number};
          const tenant = parsed.tenant?.trim();
          const issuedAt = parsed.issuedAt;

          if(!tenant || !issuedAt) {
            res.status(400).json({status: "error", message: "Invalid token payload."});
            return;
          }

          // 3) Token expiry (10 minutes)
          const maxAgeMs = 10 * 60 * 1000;
          if(Date.now() - issuedAt > maxAgeMs) {
            res.status(401).json({status: "error", message: "Token expired!"});
            return;
          }

          // 4) Ensure we actually received a file
          const file = req.file as Express.Multer.File | undefined;
          if(!file) {
            res.status(400).json({status: "error", message: "Image is required."});
            return;
          }

          // 5) Move temp folder (by token) → tenant final folder
          const tempFolder = path.join(this.TENANT_UPLOAD_ROOT, "tokens", encryptedToken, "scanned", "mobile");
          const finalFolder = this.buildTenantPath(tenant, true, "scanned", "mobile");

          // Ensure final exists, then move the entire folder content
          if(fs.existsSync(tempFolder)) {
            // Move the file itself (not the folder) to keep token folder structure intact for other potential files
            const oldPath = path.join(tempFolder, file.filename);
            const newPath = path.join(finalFolder, file.filename);
            await fs.promises.rename(oldPath, newPath);
            // Optional: you can clean empty temp folder here if you want
          }

          // 6) Build public URL
          const baseUrl = this.getBaseUrl(req);
          const fileUrl = `${baseUrl}/${this.buildTenantUrl(tenant, "scanned", "mobile", file.filename)}`;

          // 7) Build FILE + TokenViceData + ScannedFileRecordJSON
          const filedata: FILE = {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            filename: file.filename,
            URL: fileUrl,
          };

          const tokenEntry: TokenViceData = {ageInMinutes: 0, file: filedata};

          const record: ScannedFileRecordJSON = {
            date: new Date().toISOString(),
            tenant,
            token: encryptedToken,           // keep the token for traceability
            files: [tokenEntry],
          };

          // 8) Append to the tenant's flat ledger (no DB)
          await this.appendToTenantLedger(tenant, [record]);

          // 9) Send response
          res.status(200).json({
            status: "success",
            message: "Image uploaded successfully",
            data: record,
          });
          return;
        } catch(error) {
          console.error("Error in mobile file upload:", error);
          res.status(500).json({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
    );
  }

  // ============ 2) LIST RECENT FILES (LAST 24H) BY TENANT (DISK SCAN) ============
  /**
   * GET /get-reason-file-uploads-by-tenant-username/:tenant
   * Reads /uploads/tenants/<tenant>/scanned/* (currently we look at /mobile only)
   * and returns files created within the last 24 hours.
   * NOTE: We rely on filesystem timestamps; if your environment preserves ctime/birthtime
   *       differently, you can also consult the tenant's data.json ledger.
   */
  private registerRecentUploadsByTenantUsername(): void {
    this.router.get(
      "/get-reason-file-uploads-by-tenant-username/:tenant",
      async (req: Request<{tenant: string}>, res: Response) => {
        try {
          const tenant = (req.params.tenant || "").trim();
          if(!tenant) {
            res.status(400).json({status: "error", message: "Tenant is required."});
            return;
          }

          const baseUrl = this.getBaseUrl(req);
          const now = Date.now();
          const oneDayMs = 24 * 60 * 60 * 1000;

          // We will read /uploads/tenants/<tenant>/scanned/mobile
          const mobileDir = this.buildTenantPath(tenant, false, "scanned", "mobile");

          const results: ScannedFileRecordJSON[] = [];

          if(fs.existsSync(mobileDir)) {
            // List all files in the mobile scanned folder
            const fileNames = await fs.promises.readdir(mobileDir);

            for(const fname of fileNames) {
              const fpath = path.join(mobileDir, fname);
              const stat = await fs.promises.stat(fpath);
              if(!stat.isFile()) continue;

              // Determine file's "created time" (best-effort: birthtimeMs or ctimeMs)
              const createdAt = (stat as any).birthtimeMs || stat.ctimeMs || stat.mtimeMs || Date.now();
              const within24h = now - createdAt <= oneDayMs;
              if(!within24h) continue;

              // Compute age in minutes
              const ageInMinutes = Math.floor((now - createdAt) / (60 * 1000));

              // Build FILE + TokenViceData (token is unknown here — these are disk-scanned entries)
              const publicUrl = `${baseUrl}/${this.buildTenantUrl(tenant, "scanned", "mobile", fname)}`;
              const filedata: FILE = {
                fieldname: "tenantScanedDocuments",
                originalname: fname,
                mimetype: this.guessMimeFromExt(fname),
                size: stat.size,
                filename: fname,
                URL: publicUrl,
              };
              const tokenData: TokenViceData = {ageInMinutes, file: filedata};

              // For disk-scan, we group each file as its own record (you can batch if you prefer)
              const record: ScannedFileRecordJSON = {
                date: new Date(createdAt).toISOString(),
                tenant,
                token: "disk-scan",                   // We don't know the upload token here
                files: [tokenData],
              };

              results.push(record);
            }
          }

          res.status(200).json({
            status: "success",
            tenant,
            total: results.length,
            data: results,
          });
          return;
        } catch(error) {
          console.error("Error reading tenant scanned files:", error);
          res.status(500).json({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
    );
  }

  /** Very small helper to guess a MIME from extension when listing */
  private guessMimeFromExt(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch(ext) {
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".png":
        return "image/png";
      case ".webp":
        return "image/webp";
      case ".gif":
        return "image/gif";
      case ".bmp":
        return "image/bmp";
      case ".tif":
      case ".tiff":
        return "image/tiff";
      case ".svg":
      case ".svgz":
        return "image/svg+xml";
      case ".pdf":
        return "application/pdf";
      default:
        return "application/octet-stream";
    }
  }

  // ============ 3) AUTO-CLEANUP TOKEN FOLDERS (/uploads/tenants/tokens) ============
  /**
   * Periodically deletes token folders older than 30 minutes.
   * Runs every 5 minutes; checks /uploads/tenants/tokens/*
   */
  private scheduleTokenFolderCleanup(): void {
    const ROOT = path.join(this.TENANT_UPLOAD_ROOT, "tokens");
    const TIME_LIMIT_MS = 30 * 60 * 1000;   // 30 minutes
    const INTERVAL_MS = 5 * 60 * 1000;      // check every 5 minutes

    const sweep = async () => {
      try {
        if(!fs.existsSync(ROOT)) return;

        const tokenFolders = await fs.promises.readdir(ROOT);
        for(const tokenFolder of tokenFolders) {
          // Each token folder is: /uploads/tenants/tokens/<token>
          const tokenPath = path.join(ROOT, tokenFolder);
          try {
            const stats = await fs.promises.stat(tokenPath);
            const createdMs = (stats as any).birthtimeMs || stats.ctimeMs || stats.mtimeMs || Date.now();
            if(Date.now() - createdMs > TIME_LIMIT_MS) {
              await fs.promises.rm(tokenPath, {recursive: true, force: true});
              console.log(`[CLEANUP] Deleted expired token folder: ${tokenFolder}`);
            }
          } catch(err) {
            console.error(`[CLEANUP] Failed to inspect ${tokenFolder}:`, err);
          }
        }
      } catch(err) {
        console.error("[CLEANUP] Unexpected error:", err);
      }
    };

    // Run immediately once at startup, then schedule
    sweep().catch(() => void 0);
    setInterval(() => sweep().catch(() => void 0), INTERVAL_MS);
  }

  // ============ 4) DOC → PDF CONVERSION (STREAMS PDF) ============
  /**
   * POST /convert-to-pdf
   * Body: { fileUrl: string }
   * Downloads the file, converts it to PDF via LibreOffice (must be installed),
   * and streams the PDF back to the client.
   * - This does NOT save to disk; it just converts in-memory and sends.
   */
  private registerConvertToPDF(): void {
    this.router.post("/convert-to-pdf", async (req: Request, res: Response) => {
      try {
        const fileUrl = (req.body?.fileUrl || "").trim();
        if(!fileUrl) {
          res.status(400).json({status: "error", message: "File URL is required"});
          return;
        }

        // 1) Download the file as binary buffer
        const response = await axios.get<ArrayBuffer>(fileUrl, {responseType: "arraybuffer"});
        const fileBuffer = Buffer.from(response.data);

        // 2) Convert using LibreOffice
        // libre.convert(buffer, '.pdf', undefined, cb)
        libre.convert(fileBuffer, ".pdf", undefined, (err, done) => {
          if(err) {
            console.error("Conversion error:", err);
            res.status(500).json({status: "error", message: "PDF conversion failed"});
            return;
          }

          // 3) Stream PDF content
          res.setHeader("Content-Type", "application/pdf");
          res.send(done);
        });
      } catch(error) {
        console.error("PDF conversion failed:", error);
        res.status(500).json({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    });
  }
}


