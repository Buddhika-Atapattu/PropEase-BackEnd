// File: src/api/property.ts
// Class-based Property API with all helpers encapsulated as private methods/fields

import express, {Request, Response, Router} from "express";
import dotenv from "dotenv";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import fse from "fs-extra";
import NotificationService from "../services/notification.service";
import {
  PropertyModel,
  IProperty,
  Address,
  CountryDetails,
  AddedBy,
  GoogleMapLocation,
} from "../models/property.model";

dotenv.config();

type UploadedImage = {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  imageURL: string;
};

type UploadedDocument = {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  documentURL: string;
};

export default class Property {
  /* ------------------------------- Paths/URLs ------------------------------- */
  private readonly DEFAULT_UPLOAD_PATH = path.join(
    __dirname,
    "../../public/uploads/properties/"
  );
  private readonly DEFAULT_RECYCLE_PATH = path.join(
    __dirname,
    "../../public/recyclebin/properties/"
  );
  private readonly DEFAULT_PROPERTY_URL = "uploads/properties";
  private readonly DEFAULT_RECYCLE_URL = "recyclebin/properties";

  /* ------------------------------- Enum sets -------------------------------- */
  private readonly PROPERTY_TYPES = new Set([
    "apartment",
    "house",
    "villa",
    "commercial",
    "land",
    "studio",
  ]);
  private readonly LISTINGS = new Set(["sale", "rent", "sold", "rented"]);
  private readonly FURNISHING = new Set([
    "furnished",
    "semi-furnished",
    "unfurnished",
  ]);
  private readonly CONDITIONS = new Set([
    "new",
    "old",
    "excellent",
    "good",
    "needs renovation",
  ]);
  private readonly OWNERSHIP = new Set([
    "freehold",
    "leasehold",
    "company",
    "trust",
  ]);
  private readonly AVAILABILITY = new Set([
    "available",
    "not available",
    "pending",
    "ready to move",
  ]);
  private readonly VERIFICATION = new Set([
    "pending",
    "verified",
    "rejected",
    "approved",
  ]);
  private readonly PRIORITY = new Set(["high", "medium", "low"]);
  private readonly STATUS = new Set(["draft", "published", "archived"]);

  /* -------------------------------- Router --------------------------------- */
  private router: express.Router;

  constructor () {
    this.router = express.Router();

    this.test();
    this.insertProperty();
    this.getAllPropertiesWithPagination();
    this.getSinglePropertyById();
    this.deleteProperty();
    this.updateProperty();
    this.getAllProperties();
  }

  get route(): Router {
    return this.router;
  }

  /* =============================== ROUTES =================================== */

  private test() {
    this.router.get("/test", (_req, res) => {
      res.status(200).json({status: "success", message: "Property API is working"});
    });
  }

  // ------------------------------ INSERT -------------------------------------
  private insertProperty(): void {
    const allowedDocumentTypes = [
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
    ];
    const allowedImageTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/bmp",
      "image/tiff",
      "image/webp",
      "image/svg+xml",
    ];

    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const propertyID = this.s(req.params.propertyID);
        if(!propertyID)
          return cb(new Error("Property ID is required in URL param."), "");
        const base = path.join(this.DEFAULT_UPLOAD_PATH, propertyID);
        const uploadPath =
          file.fieldname === "images"
            ? path.join(base, "tempImages")
            : file.fieldname === "documents"
              ? path.join(base, "documents")
              : "";
        if(!uploadPath)
          return cb(new Error("Unexpected field: " + file.fieldname), "");
        fse.mkdirpSync(uploadPath);
        cb(null, uploadPath);
      },
      filename: (_req, file, cb) => {
        const u = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, `${u}-${file.originalname.replace(/\s+/g, "_")}`);
      },
    });

    const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
      if(
        file.fieldname === "images" &&
        allowedImageTypes.includes(file.mimetype)
      )
        return cb(null, true);
      if(
        file.fieldname === "documents" &&
        allowedDocumentTypes.includes(file.mimetype)
      )
        return cb(null, true);
      return cb(
        new Error(`File type not allowed for ${file.fieldname}: ${file.mimetype}`)
      );
    };

    const upload = multer({
      storage,
      fileFilter,
      limits: {fileSize: 25 * 1024 * 1024, files: 40},
    });

    this.router.post(
      "/insert-property/:propertyID",
      upload.fields([
        {name: "images", maxCount: 30},
        {name: "documents", maxCount: 20},
      ]),
      async (req: Request<{propertyID: string}>, res: Response): Promise<void> => {
        try {
          const propertyID = this.s(req.params.propertyID);
          if(!propertyID) {
            res
              .status(400)
              .json({status: "error", message: "Property ID missing in URL."});
            return;
          }

          // Build media arrays & convert images to .webp
          const files = req.files as {[k: string]: Express.Multer.File[]} | undefined;
          const imagesIn = files?.images ?? [];
          const docsIn = files?.documents ?? [];

          const images: UploadedImage[] = [];
          const documents: UploadedDocument[] = [];
          const conversions: Promise<void>[] = [];

          // Documents
          for(const f of docsIn) {
            documents.push({
              originalname: f.originalname.trim(),
              filename: f.filename.trim(),
              mimetype: f.mimetype.trim(),
              size: f.size,
              documentURL: `${req.protocol}://${req.get("host")}/${this.DEFAULT_PROPERTY_URL}/${propertyID}/documents/${f.filename}`,
            });
          }

          // Images (tempImages -> images/*.webp)
          const outDir = path.join(this.DEFAULT_UPLOAD_PATH, propertyID, "images");
          fse.mkdirpSync(outDir);

          for(const f of imagesIn) {
            const base = path.basename(f.filename, path.extname(f.filename));
            const out = path.join(outDir, `${base}.webp`);
            const url = `${req.protocol}://${req.get("host")}/${this.DEFAULT_PROPERTY_URL}/${propertyID}/images/${base}.webp`;

            const p = sharp(f.path)
              .webp({quality: 90})
              .resize(1600, 1200, {fit: "inside", withoutEnlargement: true})
              .toFile(out)
              .then(() => void 0);
            conversions.push(p);

            images.push({
              originalname: f.originalname.trim(),
              filename: `${base}.webp`,
              mimetype: "image/webp",
              size: f.size,
              imageURL: url,
            });
          }

          await Promise.all(conversions);

          // Validate payload strictly against model (insert mode)
          const {data, errors} = this.buildValidatedPayload(req, {
            images,
            documents,
            isUpdate: false,
          });
          data.id = propertyID; // enforce URL id

          if(errors.length) {
            await this.deleteFolderWithRetry(
              path.join(this.DEFAULT_UPLOAD_PATH, propertyID, "tempImages")
            );
            res
              .status(400)
              .json({status: "fail", message: "Validation failed", errors});
            return;
          }

          const inserted = await new PropertyModel(data as IProperty).save();

          await this.deleteFolderWithRetry(
            path.join(this.DEFAULT_UPLOAD_PATH, propertyID, "tempImages")
          );

          // Notify
          const notificationService = new NotificationService();
          const io = req.app.get("io") as import("socket.io").Server;
          await notificationService.createNotification(
            {
              title: "New Property",
              body: `A new property "${inserted.title}" has been added.`,
              type: "create",
              severity: "info",
              audience: {mode: "role", roles: ["admin", "agent", "manager", "operator"]},
              channels: ["inapp", "email"],
              metadata: {property: inserted},
            },
            (rooms, payload) => rooms.forEach((r) => io.to(r).emit("notification.new", payload))
          );

          res
            .status(201)
            .json({status: "success", message: "Property inserted successfully", data: inserted});
        } catch(err: any) {
          console.error("[insert-property] error:", err);
          res
            .status(500)
            .json({status: "error", message: err?.message || "Internal server error"});
        }
      }
    );
  }

  // --------------------- GET ALL (pagination + filters) ----------------------
  private getAllPropertiesWithPagination(): void {
    this.router.get(
      "/get-all-properties-with-pagination/:start/:end/",
      async (req: Request<{start: string; end: string}>, res: Response) => {
        try {
          const start = Math.max(0, parseInt(req.params.start, 10));
          const end = Math.max(1, parseInt(req.params.end, 10));
          if(Number.isNaN(start) || Number.isNaN(end))
            throw new Error("Invalid start or end parameters.");

          const rawSearch = this.s(req.query.search);
          const rawFilter = this.s(req.query.filter);

          const filterData = rawFilter
            ? this.parseJSON<{
              minPrice: number;
              maxPrice: number;
              beds: string;
              bathrooms: string;
              amenities: string[];
              type: string;
              status: string;
            }>(rawFilter, {
              minPrice: 0,
              maxPrice: Number.MAX_SAFE_INTEGER,
              beds: "",
              bathrooms: "",
              amenities: [],
              type: "",
              status: "",
            })
            : {
              minPrice: 0,
              maxPrice: Number.MAX_SAFE_INTEGER,
              beds: "",
              bathrooms: "",
              amenities: [],
              type: "",
              status: "",
            };

          const and: any[] = [];

          if(rawSearch) {
            const rx = new RegExp(rawSearch, "i");
            and.push({
              $or: [
                {title: {$regex: rx}},
                {type: {$regex: rx}},
                {status: {$regex: rx}},
                {"address.country": {$regex: rx}},
              ],
            });
          }

          and.push({
            price: {
              $gte: Number(filterData.minPrice) || 0,
              $lte: Number(filterData.maxPrice) || Number.MAX_SAFE_INTEGER,
            },
          });

          if(filterData.beds === "10+") and.push({bedrooms: {$gte: 10}});
          else if(filterData.beds)
            and.push({bedrooms: Number.parseInt(filterData.beds, 10) || 0});

          if(filterData.bathrooms === "10+")
            and.push({bathrooms: {$gte: 10}});
          else if(filterData.bathrooms)
            and.push({
              bathrooms: Number.parseInt(filterData.bathrooms, 10) || 0,
            });

          if(filterData.type) {
            const t = filterData.type.toLowerCase();
            if(this.PROPERTY_TYPES.has(t)) and.push({type: t});
          }

          if(filterData.status) {
            const st = filterData.status.toLowerCase();
            if(this.STATUS.has(st)) and.push({status: st});
          }

          if(Array.isArray(filterData.amenities) && filterData.amenities.length) {
            and.push({featuresAndAmenities: {$all: filterData.amenities}});
          }

          const match = and.length ? {$and: and} : {};

          const properties = await PropertyModel.aggregate([
            {$match: match},
            {
              $addFields: {
                priorityOrder: {
                  $switch: {
                    branches: [
                      {case: {$eq: ["$priority", "high"]}, then: 1},
                      {case: {$eq: ["$priority", "medium"]}, then: 2},
                      {case: {$eq: ["$priority", "low"]}, then: 3},
                    ],
                    default: 4,
                  },
                },
              },
            },
            {$sort: {priorityOrder: 1, updatedAt: -1}},
            {$skip: start},
            {$limit: end - start},
          ]);

          const totalCount = await PropertyModel.countDocuments(match);

          res.status(200).json({
            status: "success",
            message: "Properties fetched successfully.",
            data: {properties, count: totalCount},
          });
        } catch(error) {
          console.error("[get-all-properties-with-pagination] error:", error);
          res
            .status(500)
            .json({status: "error", message: "Error occurred while fetching properties."});
        }
      }
    );
  }

  // --------------------------- GET SINGLE BY ID ------------------------------
  private getSinglePropertyById(): void {
    this.router.get(
      "/get-single-property-by-id/:id",
      async (req: Request<{id: string}>, res: Response) => {
        try {
          const id = this.s(req.params.id);
          if(!id) throw new Error("Property ID is required.");
          const property = await PropertyModel.findOne({id});
          if(!property) throw new Error("Property not found.");
          res.status(200).json({
            status: "success",
            message: "Property fetched successfully.",
            data: property,
          });
        } catch(error) {
          console.error("[get-single-property] error:", error);
          res
            .status(500)
            .json({status: "error", message: "Error occurred while fetching property."});
        }
      }
    );
  }

  // --------------------------------- DELETE ----------------------------------
  private deleteProperty(): void {
    this.router.delete(
      "/delete-property/:id/:username",
      async (req: Request<{id: string; username: string}>, res: Response) => {
        try {
          const safeID = this.s(req.params.id);
          const urlUsername = this.s(req.params.username);
          if(!safeID) {
            res.status(400).json({status: "error", message: "Property ID is required."});
            return;
          }
          if(!urlUsername) {
            res
              .status(400)
              .json({status: "error", message: "Property deletor is required."});
            return;
          }

          // @ts-ignore optional auth middleware
          const actorUsername: string =
            (req.user?.username as string | undefined)?.trim() || urlUsername;

          const property = await PropertyModel.findOne({id: safeID}).lean();
          if(!property) {
            res.status(404).json({status: "error", message: "Property not found."});
            return;
          }

          const srcDir = path.join(this.DEFAULT_UPLOAD_PATH, safeID);
          let dstDir = path.join(this.DEFAULT_RECYCLE_PATH, safeID);
          if(await fse.pathExists(dstDir)) {
            dstDir = path.join(this.DEFAULT_RECYCLE_PATH, `${safeID}_${Date.now()}`);
          }

          if(await fse.pathExists(srcDir))
            await fse.move(srcDir, dstDir, {overwrite: false});
          else await fse.mkdirp(dstDir);

          const snapshotPath = path.join(dstDir, "data.json");
          await fse.writeJson(snapshotPath, property, {spaces: 2});

          const delRes = await PropertyModel.deleteOne({id: safeID});
          if(delRes.deletedCount !== 1) {
            res.status(409).json({
              status: "error",
              message: "Delete conflict: document was not removed from DB.",
            });
            return;
          }

          try {
            const io = req.app.get("io") as import("socket.io").Server | undefined;
            if(io) {
              const notificationService = new NotificationService();
              await notificationService.createNotification(
                {
                  title: "Delete Property",
                  body: `Property "${(property as any)?.title ?? safeID}" has been deleted.`,
                  type: "delete",
                  severity: "warning",
                  audience: {mode: "role", roles: ["admin", "agent", "manager", "operator"]},
                  channels: ["inapp", "email"],
                  metadata: {
                    deletedBy: actorUsername,
                    deletedAt: new Date().toISOString(),
                    propertyId: safeID,
                    recyclebin: {
                      folder: dstDir,
                      dataJson: snapshotPath,
                      base: `${req.protocol}://${req.get("host")}/${this.DEFAULT_RECYCLE_URL}/${path.basename(
                        dstDir
                      )}`,
                    },
                  },
                  target: {kind: "Property", refId: safeID},
                },
                (rooms, payload) => rooms.forEach((r) => io.to(r).emit("notification.new", payload))
              );
            }
          } catch(notifyErr) {
            console.warn("[delete-property] notification failed:", notifyErr);
          }

          res.status(200).json({status: "success", message: "Property deleted.", data: null});
        } catch(error: any) {
          console.error("[delete-property] error:", error?.message || error);
          res
            .status(500)
            .json({status: "error", message: "Error occurred while deleting property."});
        }
      }
    );
  }

  // --------------------------------- UPDATE ----------------------------------
  private updateProperty(): void {
    const allowedDocumentTypes = [
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
    ];
    const allowedImageTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/bmp",
      "image/tiff",
      "image/webp",
      "image/svg+xml",
    ];

    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const propertyID = this.s(req.params.id);
        if(!propertyID) return cb(new Error("Property ID is required in URL."), "");
        const base = path.join(this.DEFAULT_UPLOAD_PATH, propertyID);
        const uploadPath =
          file.fieldname === "images"
            ? path.join(base, "tempImages")
            : file.fieldname === "documents"
              ? path.join(base, "documents")
              : "";
        if(!uploadPath)
          return cb(new Error("Unexpected field: " + file.fieldname), "");
        fse.mkdirpSync(uploadPath);
        cb(null, uploadPath);
      },
      filename: (_req, file, cb) => {
        const u = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, `${u}-${file.originalname.replace(/\s+/g, "_")}`);
      },
    });

    const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
      if(
        file.fieldname === "images" &&
        allowedImageTypes.includes(file.mimetype)
      )
        return cb(null, true);
      if(
        file.fieldname === "documents" &&
        allowedDocumentTypes.includes(file.mimetype)
      )
        return cb(null, true);
      return cb(new Error("File type not allowed: " + file.mimetype));
    };

    const upload = multer({storage, fileFilter});

    this.router.put(
      "/update-property/:id",
      upload.fields([{name: "images"}, {name: "documents"}]),
      async (req: Request<{id: string}>, res: Response): Promise<void> => {
        try {
          const propertyID = this.s(req.params.id || req.body.id);
          if(!propertyID) {
            res
              .status(400)
              .json({status: "error", message: "Property ID is required in URL or body."});
            return;
          }

          const files = req.files as {[k: string]: Express.Multer.File[]} | undefined;
          const imagesIn = files?.images ?? [];
          const docsIn = files?.documents ?? [];

          // Start with existing media (kept)
          const existingImages = this.parseJSON<UploadedImage[]>(
            req.body.existingImages,
            []
          );
          const existingDocs = this.parseJSON<UploadedDocument[]>(
            req.body.existingDocuments,
            []
          );
          if(!Array.isArray(existingImages) || !Array.isArray(existingDocs)) {
            res.status(400).json({
              status: "fail",
              message: "existingImages / existingDocuments must be arrays",
            });
            return;
          }

          const Images: UploadedImage[] = [...existingImages];
          const Documents: UploadedDocument[] = [...existingDocs];

          // Remove images -> move to /deleted
          const removeImages = this.parseJSON<UploadedImage[]>(
            req.body.removeImages,
            []
          );
          if(Array.isArray(removeImages) && removeImages.length) {
            for(const img of removeImages) {
              if(!img?.filename) continue;
              const src = path.join(
                this.DEFAULT_UPLOAD_PATH,
                propertyID,
                "images",
                img.filename
              );
              const dst = path.join(
                this.DEFAULT_UPLOAD_PATH,
                propertyID,
                "deleted",
                "images"
              );
              try {
                await this.moveToTheRecycleBin(dst, src);
              } catch(e) {
                console.warn("[update] failed moving image to deleted:", e);
              }
              const idx = Images.findIndex((x) => x.filename === img.filename);
              if(idx >= 0) Images.splice(idx, 1);
            }
          }

          // Remove docs -> move to /deleted
          const removeDocs = this.parseJSON<UploadedDocument[]>(
            req.body.removeDocuments,
            []
          );
          if(Array.isArray(removeDocs) && removeDocs.length) {
            for(const d of removeDocs) {
              if(!d?.filename) continue;
              const src = path.join(
                this.DEFAULT_UPLOAD_PATH,
                propertyID,
                "documents",
                d.filename
              );
              const dst = path.join(
                this.DEFAULT_UPLOAD_PATH,
                propertyID,
                "deleted",
                "documents"
              );
              try {
                await this.moveToTheRecycleBin(dst, src);
              } catch(e) {
                console.warn("[update] failed moving doc to deleted:", e);
              }
              const idx = Documents.findIndex((x) => x.filename === d.filename);
              if(idx >= 0) Documents.splice(idx, 1);
            }
          }

          // Convert new images
          const conversions: Promise<void>[] = [];
          if(imagesIn.length) {
            const outDir = path.join(this.DEFAULT_UPLOAD_PATH, propertyID, "images");
            await fse.mkdirp(outDir);

            for(const f of imagesIn) {
              const base = path.basename(f.filename, path.extname(f.filename));
              const out = path.join(outDir, `${base}.webp`);
              const url = `${req.protocol}://${req.get("host")}/${this.DEFAULT_PROPERTY_URL}/${propertyID}/images/${base}.webp`;
              const p = sharp(f.path)
                .webp({quality: 100})
                .resize(800, 600, {fit: "inside", withoutEnlargement: true})
                .toFile(out)
                .then(async () => {
                  await fse.remove(f.path);
                })
                .catch((e) => console.warn("[update] image convert error:", e));
              conversions.push(p);
              Images.push({
                originalname: f.originalname.trim(),
                filename: `${base}.webp`,
                mimetype: "image/webp",
                size: f.size,
                imageURL: url,
              });
            }
          }

          // Accept new docs
          if(docsIn.length) {
            for(const f of docsIn) {
              Documents.push({
                originalname: f.originalname.trim(),
                filename: f.filename.trim(),
                mimetype: f.mimetype.trim(),
                size: f.size,
                documentURL: `${req.protocol}://${req.get("host")}/${this.DEFAULT_PROPERTY_URL}/${propertyID}/documents/${f.filename}`,
              });
            }
          }

          // Validate (update mode)
          const {data, errors} = this.buildValidatedPayload(req, {
            images: Images,
            documents: Documents,
            isUpdate: true,
          });
          data.id = propertyID;

          if(errors.length) {
            await this.deleteFolderWithRetry(
              path.join(this.DEFAULT_UPLOAD_PATH, propertyID, "tempImages")
            );
            res
              .status(400)
              .json({status: "fail", message: "Validation failed", errors});
            return;
          }

          const updated = await PropertyModel.findOneAndUpdate(
            {id: propertyID},
            {$set: data},
            {new: true}
          );
          if(!updated) {
            res
              .status(404)
              .json({status: "error", message: "Property not found or update failed."});
            return;
          }

          // Notify
          try {
            const notificationService = new NotificationService();
            const io = req.app.get("io") as import("socket.io").Server | undefined;
            if(io) {
              await notificationService.createNotification(
                {
                  title: "Update Property",
                  body: `Property with ID ${propertyID} has been updated.`,
                  type: "update",
                  severity: "info",
                  audience: {mode: "role", roles: ["admin", "operator"]},
                  channels: ["inapp", "email"],
                  metadata: {property: updated, updatedAt: new Date().toISOString(), propertyID},
                  target: {kind: "Property", refId: propertyID},
                },
                (rooms, payload) => rooms.forEach((room) => io.to(room).emit("notification.new", payload))
              );
            }
          } catch(e) {
            console.warn("[update-property] notification failed:", e);
          }

          res
            .status(200)
            .json({status: "success", message: "Property updated successfully.", data: updated});

          await Promise.all(conversions);
          await this.deleteFolderWithRetry(
            path.join(this.DEFAULT_UPLOAD_PATH, propertyID, "tempImages")
          );
        } catch(error: any) {
          console.error("[update-property] error:", error?.stack || error);
          res
            .status(500)
            .json({status: "error", message: "Error occurred while updating property."});
        }
      }
    );
  }

  // ------------------------------- GET ALL -----------------------------------
  private getAllProperties(): void {
    this.router.get("/get-all-properties/", async (_req, res) => {
      try {
        const properties = await PropertyModel.find().sort({createdAt: -1});
        res.status(200).json({
          status: "success",
          message: "Properties fetched successfully.",
          data: properties,
        });
      } catch {
        res
          .status(500)
          .json({status: "error", message: "Error fetching properties."});
      }
    });
  }

  /* ============================ PRIVATE HELPERS ============================= */

  // --- Narrow/convert ---
  private isStr(v: unknown): v is string {
    return typeof v === "string";
  }
  private s(v: unknown): string {
    return this.isStr(v) ? v.trim() : "";
  }
  private toLower(v: unknown): string {
    return this.s(v).toLowerCase();
  }
  private toNum(v: unknown, def = 0): number {
    const n = Number(this.s(v));
    return Number.isFinite(n) ? n : def;
  }
  private toNonNeg(v: unknown, def = 0): number {
    return Math.max(0, this.toNum(v, def));
  }
  private parseJSON<T>(v: unknown, fallback: T): T {
    try {
      if(v == null) return fallback;
      if(typeof v === "string") {
        const t = v.trim();
        if(!t) return fallback;
        return JSON.parse(t) as T;
      }
      return v as T;
    } catch {
      return fallback;
    }
  }
  private toDateOrNull(v: unknown): Date | null {
    const str = this.s(v);
    if(!str) return null;
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  private toDateOrThrow(v: unknown, field: string): Date {
    const d = this.toDateOrNull(v);
    if(!d) throw new Error(`Invalid date for "${field}"`);
    return d;
  }

  // --- shape validators ---
  private validateAddress(raw: unknown): Address {
    const a = this.parseJSON<Address>(raw, {} as any);
    return {
      houseNumber: this.s(a.houseNumber),
      street: this.s((a as any).street),
      city: this.s(a.city),
      stateOrProvince: this.s((a as any).stateOrProvince),
      postcode: this.s(a.postcode),
      country: this.s(a.country),
    };
  }
  private validateCountryDetails(raw: unknown): CountryDetails {
    const c = this.parseJSON<CountryDetails>(raw, {} as any);
    const out = {...c} as CountryDetails;
    (out.tld as any) = Array.isArray((c as any).tld) ? (c as any).tld : undefined;
    (out.capital as any) = Array.isArray((c as any).capital) ? (c as any).capital : undefined;
    (out.timezones as any) = Array.isArray((c as any).timezones) ? (c as any).timezones : undefined;
    (out.continents as any) = Array.isArray((c as any).continents) ? (c as any).continents : undefined;
    (out.latlng as any) = Array.isArray((c as any).latlng) ? (c as any).latlng : undefined;
    (out.flags as any) = typeof (c as any).flags === "object" ? (c as any).flags : ({} as any);
    return out;
  }
  private validateAddedBy(raw: unknown): AddedBy {
    const a = this.parseJSON<AddedBy>(raw, {} as any);
    return {
      username: this.s(a.username),
      name: this.s(a.name),
      email: this.s(a.email),
      role: this.s(a.role) as any,
      contactNumber: this.s(a.contactNumber),
      addedAt: a?.addedAt ? this.toDateOrNull(a.addedAt) || new Date() : new Date(),
    };
  }
  private validateLocation(raw: unknown): GoogleMapLocation | undefined {
    const loc = this.parseJSON<GoogleMapLocation>(raw, {} as any);
    const lat = Number((loc as any).lat);
    const lng = Number((loc as any).lng);
    const embeddedUrl = this.s((loc as any).embeddedUrl);
    if(!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
    return {lat, lng, embeddedUrl};
  }

  // --- payload builder (insert/update) ---
  private buildValidatedPayload(
    req: Request,
    ctx: {images: UploadedImage[]; documents: UploadedDocument[]; isUpdate: boolean}
  ): {data: Partial<IProperty>; errors: string[]} {
    const errors: string[] = [];
    const isUpdate = ctx.isUpdate;

    // Basic
    const id = this.s((req.params as any).propertyID || (req.params as any).id || req.body.id);
    if(!isUpdate && !id) errors.push("id (as :propertyID in URL or body.id) is required.");

    const title = this.s(req.body.title);
    if(!isUpdate && !title) errors.push("title is required.");

    const type = this.toLower(req.body.type);
    if(!isUpdate && !type) errors.push("type is required.");
    if(type && !this.PROPERTY_TYPES.has(type))
      errors.push(`type must be one of: ${Array.from(this.PROPERTY_TYPES).join(", ")}`);

    const listing = this.toLower(req.body.listing);
    if(!isUpdate && !listing) errors.push("listing is required.");
    if(listing && !this.LISTINGS.has(listing))
      errors.push(`listing must be one of: ${Array.from(this.LISTINGS).join(", ")}`);

    const description = this.s(req.body.description);
    if(!isUpdate && !description) errors.push("description is required.");

    // Location
    const countryDetails = this.validateCountryDetails(req.body.countryDetails);
    const address = this.validateAddress(req.body.address);
    const location = this.validateLocation(req.body.location);

    // Specs
    const totalArea = this.toNonNeg(req.body.totalArea);
    const builtInArea = this.toNonNeg(req.body.builtInArea);
    const livingRooms = this.toNonNeg(req.body.livingRooms);
    const balconies = this.toNonNeg(req.body.balconies);
    const kitchen = this.toNonNeg(req.body.kitchen);
    const bedrooms = this.toNonNeg(req.body.bedrooms);
    const bathrooms = this.toNonNeg(req.body.bathrooms);
    const maidrooms = this.toNonNeg(req.body.maidrooms);
    const driverRooms = this.toNonNeg(req.body.driverRooms);
    const furnishingStatus = this.toLower(req.body.furnishingStatus);
    if(!isUpdate && !furnishingStatus) errors.push("furnishingStatus is required.");
    if(furnishingStatus && !this.FURNISHING.has(furnishingStatus))
      errors.push(`furnishingStatus must be one of: ${Array.from(this.FURNISHING).join(", ")}`);
    const totalFloors = this.toNonNeg(req.body.totalFloors);
    const numberOfParking = this.toNonNeg(req.body.numberOfParking);

    // Construction & Age
    const builtYear = this.toNonNeg(req.body.builtYear);
    const propertyCondition = this.toLower(req.body.propertyCondition);
    if(!isUpdate && !propertyCondition) errors.push("propertyCondition is required.");
    if(propertyCondition && !this.CONDITIONS.has(propertyCondition))
      errors.push(`propertyCondition must be one of: ${Array.from(this.CONDITIONS).join(", ")}`);
    const developerName = this.s(req.body.developerName);
    const projectName = this.s(req.body.projectName);
    const ownerShipType = this.toLower(req.body.ownerShipType);
    if(!isUpdate && !ownerShipType) errors.push("ownerShipType is required.");
    if(ownerShipType && !this.OWNERSHIP.has(ownerShipType))
      errors.push(`ownerShipType must be one of: ${Array.from(this.OWNERSHIP).join(", ")}`);

    // Financial
    const price = this.toNonNeg(req.body.price);
    const currency = this.s(req.body.currency) || "lkr";
    const pricePerSqurFeet = this.toNonNeg(
      req.body.pricePerSqurFeet,
      totalArea > 0 ? Number((price / totalArea).toFixed(2)) : 0
    );
    const expectedRentYearly = this.toNonNeg(req.body.expectedRentYearly);
    const expectedRentQuartely = this.toNonNeg(req.body.expectedRentQuartely);
    const expectedRentMonthly = this.toNonNeg(req.body.expectedRentMonthly);
    const expectedRentDaily = this.toNonNeg(req.body.expectedRentDaily);
    const maintenanceFees = this.toNonNeg(req.body.maintenanceFees);
    const serviceCharges = this.toNonNeg(req.body.serviceCharges);
    const transferFees = this.toNonNeg(req.body.transferFees);

    const availabilityStatus = this.toLower(req.body.availabilityStatus);
    if(availabilityStatus && !this.AVAILABILITY.has(availabilityStatus))
      errors.push(
        `availabilityStatus must be one of: ${Array.from(this.AVAILABILITY).join(", ")}`
      );

    // Features & Amenities
    const featuresAndAmenities = this.parseJSON<string[]>(
      req.body.featuresAndAmenities,
      []
    );
    if(!Array.isArray(featuresAndAmenities))
      errors.push("featuresAndAmenities must be an array of strings.");

    // Media (require at least one of each on insert)
    const images = ctx.images || [];
    const documents = ctx.documents || [];
    if(!isUpdate) {
      if(images.length === 0) errors.push("At least one image is required.");
      if(documents.length === 0) errors.push("At least one document is required.");
    }

    // Listing Management
    const listingDate = isUpdate
      ? this.toDateOrNull(req.body.listingDate) || undefined
      : this.toDateOrThrow(req.body.listingDate, "listingDate");
    const availabilityDate = this.toDateOrNull(req.body.availabilityDate);
    const listingExpiryDate = this.toDateOrNull(req.body.listingExpiryDate);
    const rentedDate = this.toDateOrNull(req.body.rentedDate);
    const soldDate = this.toDateOrNull(req.body.soldDate);

    const addedBy = this.validateAddedBy(req.body.addedBy);
    if(!isUpdate) {
      if(!addedBy.username) errors.push("addedBy.username is required.");
      if(!addedBy.email) errors.push("addedBy.email is required.");
      if(!addedBy.role) errors.push("addedBy.role is required.");
    }
    const owner = this.s(req.body.owner);
    if(!isUpdate && !owner) errors.push("owner is required.");

    // Admin
    const referenceCode = this.s(req.body.referenceCode);
    if(!isUpdate && !referenceCode) errors.push("referenceCode is required.");
    const verificationStatus = this.toLower(req.body.verificationStatus) || "verified";
    if(verificationStatus && !this.VERIFICATION.has(verificationStatus))
      errors.push(
        `verificationStatus must be one of: ${Array.from(this.VERIFICATION).join(", ")}`
      );
    const priority = this.toLower(req.body.priority) || "medium";
    if(priority && !this.PRIORITY.has(priority))
      errors.push(`priority must be one of: ${Array.from(this.PRIORITY).join(", ")}`);
    const status = this.toLower(req.body.status) || "published";
    if(status && !this.STATUS.has(status))
      errors.push(`status must be one of: ${Array.from(this.STATUS).join(", ")}`);
    const internalNote = this.s(req.body.internalNote);

    // Build data
    const data: Partial<IProperty> = {};

    if(id) data.id = id;
    if(title) data.title = title;
    if(type) data.type = type as any;
    if(listing) data.listing = listing as any;
    if(description || !isUpdate) data.description = description;

    if(Object.keys(countryDetails || {}).length) data.countryDetails = countryDetails;
    if(Object.keys(address || {}).length) data.address = address;
    if(location) data.location = location;

    if(!isUpdate || req.body.totalArea != null) data.totalArea = totalArea;
    if(!isUpdate || req.body.builtInArea != null) data.builtInArea = builtInArea;
    if(!isUpdate || req.body.livingRooms != null) data.livingRooms = livingRooms;
    if(!isUpdate || req.body.balconies != null) data.balconies = balconies;
    if(!isUpdate || req.body.kitchen != null) data.kitchen = kitchen;
    if(!isUpdate || req.body.bedrooms != null) data.bedrooms = bedrooms;
    if(!isUpdate || req.body.bathrooms != null) data.bathrooms = bathrooms;
    if(!isUpdate || req.body.maidrooms != null) data.maidrooms = maidrooms;
    if(!isUpdate || req.body.driverRooms != null) data.driverRooms = driverRooms;
    if(furnishingStatus) data.furnishingStatus = furnishingStatus as any;
    if(!isUpdate || req.body.totalFloors != null) data.totalFloors = totalFloors;
    if(!isUpdate || req.body.numberOfParking != null)
      data.numberOfParking = numberOfParking;

    if(!isUpdate || req.body.builtYear != null) data.builtYear = builtYear;
    if(propertyCondition) data.propertyCondition = propertyCondition as any;
    if(developerName || !isUpdate) data.developerName = developerName;
    if(projectName || !isUpdate) data.projectName = projectName;
    if(ownerShipType) data.ownerShipType = ownerShipType as any;

    if(!isUpdate || req.body.price != null) data.price = price;
    if(currency || !isUpdate) data.currency = currency;
    if(!isUpdate || req.body.pricePerSqurFeet != null)
      data.pricePerSqurFeet = pricePerSqurFeet;
    if(!isUpdate || req.body.expectedRentYearly != null)
      data.expectedRentYearly = expectedRentYearly;
    if(!isUpdate || req.body.expectedRentQuartely != null)
      data.expectedRentQuartely = expectedRentQuartely;
    if(!isUpdate || req.body.expectedRentMonthly != null)
      data.expectedRentMonthly = expectedRentMonthly;
    if(!isUpdate || req.body.expectedRentDaily != null)
      data.expectedRentDaily = expectedRentDaily;
    if(!isUpdate || req.body.maintenanceFees != null)
      data.maintenanceFees = maintenanceFees;
    if(!isUpdate || req.body.serviceCharges != null)
      data.serviceCharges = serviceCharges;
    if(!isUpdate || req.body.transferFees != null) data.transferFees = transferFees;
    if(availabilityStatus) data.availabilityStatus = availabilityStatus as any;

    if(Array.isArray(featuresAndAmenities))
      data.featuresAndAmenities = featuresAndAmenities;

    if(ctx.images?.length) data.images = ctx.images;
    if(ctx.documents?.length) data.documents = ctx.documents;
    if(this.isStr(req.body.videoTour)) data.videoTour = this.s(req.body.videoTour);
    if(this.isStr(req.body.virtualTour))
      data.virtualTour = this.s(req.body.virtualTour);

    if(listingDate !== undefined) data.listingDate = listingDate as any;
    if(availabilityDate !== null) data.availabilityDate = availabilityDate as any;
    if(listingExpiryDate !== null)
      data.listingExpiryDate = listingExpiryDate as any;
    if(rentedDate !== null) data.rentedDate = rentedDate as any;
    if(soldDate !== null) data.soldDate = soldDate as any;

    if(Object.keys(addedBy || {}).length) data.addedBy = addedBy;
    if(owner || !isUpdate) data.owner = owner;
    if(referenceCode || !isUpdate) data.referenceCode = referenceCode;
    if(verificationStatus)
      data.verificationStatus = verificationStatus as any;
    if(priority) data.priority = priority as any;
    if(status) data.status = status as any;
    if(this.isStr(req.body.internalNote)) data.internalNote = internalNote;

    return {data, errors};
  }

  // --- fs helpers ---
  private async deleteFolderWithRetry(
    folderPath: string,
    retries = 5,
    delayMs = 500
  ): Promise<void> {
    for(let i = 1; i <= retries; i++) {
      try {
        await fs.promises.rm(folderPath, {recursive: true, force: true});
        return;
      } catch(e: any) {
        if(e.code === "EBUSY" || e.code === "EPERM") {
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          throw e;
        }
      }
    }
    throw new Error(`Failed to delete folder after ${retries} attempts: ${folderPath}`);
  }

  private async moveToTheRecycleBin(
    recycleBinPath: string,
    filePath: string
  ): Promise<void> {
    try {
      if(!fs.existsSync(filePath)) return;
      await fs.promises.mkdir(recycleBinPath, {recursive: true});
      const targetPath = path.join(
        recycleBinPath,
        `${Date.now()}-${path.basename(filePath)}`
      );
      await fs.promises.rename(filePath, targetPath);
    } catch(error) {
      console.log(
        "Error while moving file to deleted:",
        error instanceof Error ? error.stack : error
      );
    }
  }
}
