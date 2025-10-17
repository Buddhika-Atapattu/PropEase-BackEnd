// src/api/tenants.ts
// ============================================================================
// Tenants API
// - Insert a new tenant
// - Get all tenants
// - Delete a tenant (and safely move all their leases to recyclebin)
// ----------------------------------------------------------------------------
// BEGINNER NOTES
//   • "Recyclebin" is a safe location under /public/recyclebin where we move
//     files instead of deleting them immediately.
//   • We export DB rows to JSON files for recovery/audit.
//   • We always prefer renaming a folder (fast) and fall back to copy+delete
//     if moving across devices fails.
// ============================================================================

import express, {Request, Response, Router} from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import multer from "multer";

import {ITenant, TenantModel} from "../models/tenant.model";
import {LeaseModel} from "../models/lease.model";
import NotificationService from "../services/notification.service";
import {UserModel} from "../models/user.model";

dotenv.config();

export default class Tenant {
  // ---------------------------- Express router ----------------------------
  private readonly router: Router;

  // ---------------------------- Base directories --------------------------
  // IMPORTANT:
  // • PUBLIC_ROOT points at /public (must be served statically in your app)
  // • UPLOADS_ROOT is where runtime-uploaded files live
  // • RECYCLEBIN_ROOT is where we *move* deleted assets for recovery
  private readonly PUBLIC_ROOT = path.resolve(__dirname, "../../public");
  private readonly UPLOADS_ROOT = path.join(this.PUBLIC_ROOT, "uploads");
  private readonly RECYCLEBIN_ROOT = path.join(this.PUBLIC_ROOT, "recyclebin");

  // ---------------------------- Tenant paths ------------------------------
  private readonly TENANT_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, "tenants");
  private readonly TENANT_UPLOAD_DIR_URL = "uploads/tenants";

  private readonly TENANT_RECYCLE_ROOT = path.join(this.RECYCLEBIN_ROOT, "tenants");
  private readonly TENANT_RECYCLE_DIR_URL = "recyclebin/tenants";

  // Recycle location for leases that belong to a tenant
  // Final target when deleting a tenant:
  //   /public/recyclebin/tenants/leases/<username>/<timestamp>-<leaseID>/
  private readonly TENANT_RECYCLE_LEASES_ROOT = path.join(this.TENANT_RECYCLE_ROOT, "leases");
  private readonly TENANT_RECYCLE_LEASES_DIR_URL = "recyclebin/tenants/leases";

  // ---------------------------- Lease paths (source) ----------------------
  // Lease uploads live here (this matches your Lease controller):
  //   /public/uploads/leases/<leaseID>/
  private readonly LEASE_UPLOAD_ROOT = path.join(this.UPLOADS_ROOT, "leases");

  constructor () {
    this.router = express.Router();

    // Register endpoints
    this.insertTenant();      // POST   /insertTenant
    this.getAllTenants();     // GET    /get-all-tenants
    this.deleteTenant();      // DELETE /delete-tenant/:username/:deletor
  }

  /** Expose router so the main app can mount it. */
  public get route(): Router {
    return this.router;
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /** 
   * Join a path safely under a root to prevent path traversal like "../../".
   * If the resolved path is outside the root, throw an error.
   */
  private safeJoin(root: string, ...segments: string[]): string {
    const target = path.normalize(path.join(root, ...segments));
    const normalizedRoot = path.normalize(root);
    if(!target.startsWith(normalizedRoot)) {
      throw new Error("Unsafe path resolution detected.");
    }
    return target;
  }

  /**
   * Ensure a directory exists; like `mkdir -p`.
   */
  private async ensureDir(dir: string): Promise<void> {
    await fs.promises.mkdir(dir, {recursive: true});
  }

  /**
   * Move (or copy+delete) a file or directory.
   * - First tries fast `rename()`.
   * - If it fails (e.g., across devices), copy then remove source.
   */
  private async movePath(src: string, dest: string): Promise<void> {
    try {
      await this.ensureDir(path.dirname(dest));
      await fs.promises.rename(src, dest);
    } catch(err) {
      // Fallback: copy recursively then remove
      await this.ensureDir(path.dirname(dest));
      await this.copyRecursive(src, dest);
      await this.rmRecursive(src);
    }
  }

  /** Recursively copy a file/dir. */
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

  /** Recursively remove a file/dir. */
  private async rmRecursive(target: string): Promise<void> {
    await fs.promises.rm(target, {recursive: true, force: true});
  }

  /** Simple timestamp for folder names: 20251018-153642 */
  private makeStamp(date = new Date()): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const mi = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
  }

  // ============================================================================
  // POST /insertTenant
  // Creates a new tenant document after validating required fields.
  // ============================================================================

  private insertTenant(): void {
    const upload = multer(); // parse multipart/form-data (no files here)

    this.router.post("/insertTenant", upload.none(), async (req: Request, res: Response) => {
      try {
        // --------------------- 1) Validate payload (basic) ---------------------
        const username = (req.body.username || "").trim();
        if(!username) throw new Error("Username required!");
        if(!req.body.name) throw new Error("Name required!");
        if(!req.body.image) throw new Error("Image required!");
        if(!req.body.phoneNumber) throw new Error("Phone number required!");
        if(!req.body.email) throw new Error("Email required!");
        if(!req.body.gender) throw new Error("Gender required!");
        if(!req.body.addedBy) throw new Error("Added by required!");

        // If there is an old recyclebin bucket for this username, clear it.
        const recycleBinForTenant = this.safeJoin(this.TENANT_RECYCLE_ROOT, username);
        if(fs.existsSync(recycleBinForTenant)) {
          await this.rmRecursive(recycleBinForTenant);
        }

        // --------------------- 2) Build DB document ---------------------------
        const doc = {
          username: req.body.username,
          image: req.body.image,
          name: req.body.name,
          contactNumber: req.body.phoneNumber,
          email: req.body.email,
          gender: req.body.gender,
          addedBy: req.body.addedBy,
        };

        const tenant: ITenant = new TenantModel(doc);
        await tenant.save();

        // --------------------- 3) Notify interested parties -------------------
        const notificationService = new NotificationService();
        const io = req.app.get("io") as import("socket.io").Server;

        await notificationService.createNotification(
          {
            title: "New Tenant",
            body: `A new tenant named ${tenant.name} has been added.`,
            type: "create",
            severity: "info",
            audience: {mode: "role", roles: ["admin", "agent", "manager", "operator"], usernames: [tenant.username]},
            channels: ["inapp", "email"],
            metadata: {tenant: doc, addedDate: new Date().toISOString(), addedBy: tenant.addedBy},
          },
          (rooms, payload) => rooms.forEach((room) => io.to(room).emit("notification.new", payload))
        );

        // --------------------- 4) Respond -------------------------------------
        res.status(200).json({status: "success", message: "Tenant added successfully", data: tenant});
        return;
      } catch(error) {
        console.error(error);
        res.status(500).json({status: "error", message: "Error: " + (error instanceof Error ? error.message : error)});
        return;
      }
    });
  }

  // ============================================================================
  // GET /get-all-tenants
  // Returns all tenants. (Consider adding pagination if list grows.)
  // ============================================================================

  private getAllTenants(): void {
    this.router.get("/get-all-tenants", async (_req: Request, res: Response) => {
      try {
        const tenants = await TenantModel.find().lean();
        if(!tenants || tenants.length === 0) throw new Error("No tenants found");
        res.status(200).json({status: "success", message: "Tenants fetched successfully", data: tenants});
        return;
      } catch(error) {
        console.error(error);
        res.status(500).json({status: "error", message: "Error: " + (error instanceof Error ? error.message : error)});
        return;
      }
    });
  }

  // ============================================================================
  // DELETE /delete-tenant/:username/:deletor
  // - Exports tenant info + all related leases to recyclebin
  // - Moves all lease file assets to recyclebin under the tenant bucket
  // - Deletes DB rows (leases + tenant)
  // ============================================================================

  private deleteTenant(): void {
    this.router.delete(
      "/delete-tenant/:username/:deletor",
      async (req: Request<{username: string; deletor: string}>, res: Response) => {
        try {
          // --------------------- 1) Validate route params ---------------------
          const username = (req.params.username || "").trim();
          const deletor = (req.params.deletor || "").trim();
          if(!username) throw new Error("Username required!");
          if(!deletor) throw new Error("Deletor required!");

          // Check the tenant exists
          const tenantDoc = await TenantModel.findOne({username});
          if(!tenantDoc) throw new Error("Tenant not found!");

          // Validate deletor (the user who performs deletion)
          const deletorDoc = await UserModel.findOne({username: deletor});
          if(!deletorDoc) throw new Error("Deletor not found!");

          // --------------------- 2) Load all leases for this tenant -----------
          const leases = await LeaseModel.find({"tenantInformation.tenantUsername": username}).lean();

          // Prepare recyclebin structure for this tenant
          const tenantRecycleRoot = this.safeJoin(this.TENANT_RECYCLE_ROOT, username);
          await this.ensureDir(tenantRecycleRoot);

          // Save tenant snapshot to recyclebin: data.json (append mode)
          const tenantDataJson = this.safeJoin(tenantRecycleRoot, "data.json");
          const todayISO = new Date().toISOString();
          const tenantExport = {date: todayISO, tenant: tenantDoc};

          if(fs.existsSync(tenantDataJson)) {
            const existing = JSON.parse(await fs.promises.readFile(tenantDataJson, "utf-8"));
            const arr = Array.isArray(existing) ? existing : [existing];
            arr.push(tenantExport);
            await fs.promises.writeFile(tenantDataJson, JSON.stringify(arr, null, 2));
          } else {
            await fs.promises.writeFile(tenantDataJson, JSON.stringify([tenantExport], null, 2));
          }

          // --------------------- 3) Export lease DB rows to recyclebin --------
          if(leases.length > 0) {
            const tenantLeasesRecycleRoot = this.safeJoin(this.TENANT_RECYCLE_LEASES_ROOT, username);
            await this.ensureDir(tenantLeasesRecycleRoot);

            const leasesDBPath = this.safeJoin(tenantLeasesRecycleRoot, "leasesDB.json");
            if(fs.existsSync(leasesDBPath)) {
              const existing = JSON.parse(await fs.promises.readFile(leasesDBPath, "utf-8"));
              const merged = Array.isArray(existing) ? existing.concat(leases) : leases;
              await fs.promises.writeFile(leasesDBPath, JSON.stringify(merged, null, 2));
            } else {
              await fs.promises.writeFile(leasesDBPath, JSON.stringify(leases, null, 2));
            }

            // --------------------- 4) Move each lease's FILES to recyclebin ----
            // Source: /public/uploads/leases/<leaseID>/
            // Dest:   /public/recyclebin/tenants/leases/<username>/<stamp>-<leaseID>/
            const stamp = this.makeStamp();

            for(const lease of leases) {
              const leaseID = lease.leaseID;
              const srcLeaseRoot = this.safeJoin(this.LEASE_UPLOAD_ROOT, leaseID);
              const destLeaseRoot = this.safeJoin(
                this.TENANT_RECYCLE_LEASES_ROOT,
                username,
                `${stamp}-${leaseID}`
              );

              if(fs.existsSync(srcLeaseRoot)) {
                try {
                  await this.movePath(srcLeaseRoot, destLeaseRoot);
                } catch(e) {
                  console.warn(`Failed to move lease folder ${leaseID}`, e);
                }
              } else {
                // Not all leases may have files (e.g., draft-only).
                console.warn(`Lease files source not found (skipped): ${srcLeaseRoot}`);
              }
            }

            // --------------------- 5) Remove lease DB rows ---------------------
            const deleteResult = await LeaseModel.deleteMany({
              "tenantInformation.tenantUsername": username,
            });
            if(deleteResult.deletedCount === 0) {
              // Not fatal for the flow; we already exported. But report clearly.
              console.warn("No lease rows deleted; DB may have been already clean.");
            }
          }

          // --------------------- 6) Notify (deletion summary) -----------------
          const organisedMetadata: any = {
            deletor: deletorDoc,
            deletedAt: todayISO,
            tenantRecycleRoot,
            leasesRecycleRoot: this.safeJoin(this.TENANT_RECYCLE_LEASES_ROOT, username),
          };

          const notificationService = new NotificationService();
          const io = req.app.get("io") as import("socket.io").Server;

          await notificationService.createNotification(
            {
              title: "Delete Tenant",
              body: `Tenant ${username} has been deleted.`,
              type: "delete",
              severity: "warning",
              audience: {mode: "role", roles: ["admin", "agent", "manager", "operator"]},
              channels: ["inapp", "email"],
              metadata: {tenant: tenantDoc, data: organisedMetadata},
            },
            (rooms, payload) => rooms.forEach((room) => io.to(room).emit("notification.new", payload))
          );

          // --------------------- 7) Finally delete the tenant row -------------
          await TenantModel.findOneAndDelete({username});

          // --------------------- 8) Respond -----------------------------------
          res.status(200).json({
            status: "success",
            message: "Tenant and all related lease records have been safely moved to recyclebin and removed from DB.",
          });
          return;
        } catch(error) {
          console.error("Error deleting tenant:", error);
          const message = error instanceof Error ? error.message : "Unexpected error occurred during tenant deletion.";
          res.status(500).json({status: "error", message});
          return;
        }
      }
    );
  }
}
