// ==========================================================
// File: src/api/user.ts
// Description: User routes (create, verify, update, search,
//              upload docs, token utilities, and deletion).
// Notes:
//  - Class-based router (no global functions).
//  - Validations aligned with src/models/user.model.ts.
//  - Safer file handling & structured error responses.
// ==========================================================

import express, {Request, Response, NextFunction, Router} from "express";
import path from "path";
import fse from "fs-extra";
import multer from "multer";
import sharp from "sharp";
import * as Argon2 from "argon2";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import twilio, {Twilio} from "twilio";
import crypto from "crypto";
import jwt from "jsonwebtoken";

import {UserModel, IUser} from "../models/user.model";
import {TokenMap} from "../models/token.model";
import {UserDocument} from "../models/file-upload.model";
import {PropertyModel} from "../models/property.model";
import NotificationService from "../services/notification.service";

// If you keep a Role helper type elsewhere, you can import it.
// (Optional; we only rely on the actual field enum in the model.)
import {Role} from "../types/roles";
import {Config} from "../configs/config";

dotenv.config();

export default class UserRoute {
  // ─────────────────── Public folders (must match your static mount) ───────────────────
  private readonly DEFAULT_PATH = path.join(
    __dirname,
    "../../public/uploads/users/"
  );
  private readonly RECYCLE_PATH = path.join(
    __dirname,
    "../../public/recyclebin/users/"
  );
  private readonly DEFAULT_URL = "uploads/users";
  private readonly RECYCLE_URL = "recyclebin/users";

  private router: Router;
  private readonly twilioClient: Twilio = twilio(
    Config.twilio.sid,
    Config.twilio.token
  );

  constructor () {
    this.router = express.Router();

    // Route registrations (keep class-based style)
    this.createUser();
    this.getAllUsers();
    this.getUserData(); // login verification
    this.updateUser();
    this.getAllUsersWithPagination();
    this.findUserByUsername();
    this.findUserByEmail();
    this.findUserByPhone();
    this.verifyNewUserEmail();
    this.generateToken();
    this.getUserByToken();
    this.uploadDocument();
    this.getUserDocuments();
    this.getUserDataByUsername();
    this.deleteUserByUsername();
  }

  get route(): Router {
    return this.router;
  }

  // ==========================================================
  // Utilities / helpers (pure methods inside the class)
  // ==========================================================

  /** Hash password with Argon2 (strong default params). */
  private async hashPassword(password: string): Promise<string> {
    return Argon2.hash(password);
  }

  /** Guard for safe single path segments (avoid traversal/odd chars). */
  private isSafeSegment(seg: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(seg);
  }

  /** Parse JSON safely with fallback. */
  private parseJSON<T = unknown>(value: unknown, fallback: T): T {
    try {
      if(typeof value !== "string") return fallback;
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  /** Escape user-supplied regex parts. */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Email validation (basic but safe). */
  private isEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  /** Convert to boolean from string or boolean input. */
  private toBool(v: unknown, def = false): boolean {
    if(typeof v === "boolean") return v;
    if(typeof v === "string") {
      const s = v.trim().toLowerCase();
      if(s === "true") return true;
      if(s === "false") return false;
    }
    return def;
  }

  /** Convert to number safely (NaN → fallback). */
  private toNum(v: unknown, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Parse date or return null. */
  private toDate(v: unknown): Date | null {
    if(typeof v !== "string" && !(v instanceof Date)) return null;
    const d = new Date(v as any);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Ensure E.164 format for Twilio sends. */
  private ensureE164(phone: string): string {
    const trimmed = phone.trim();
    const e164 = /^\+[1-9]\d{7,14}$/;
    if(!e164.test(trimmed)) {
      throw new Error(
        `Invalid phone format. Provide E.164 like +9477xxxxxxx (got "${phone}").`
      );
    }
    return trimmed;
  }

  /** Send SMS via Twilio (for OTP). */
  private async verifyPhoneNumber(
    to: string,
    otp: string
  ): Promise<{sid: string; to: string}> {
    const code = String(otp ?? "").trim();
    if(code.length < 4 || code.length > 10) {
      throw new Error(`OTP length invalid.`);
    }
    const toE164 = this.ensureE164(to);

    try {
      const result = await this.twilioClient.messages.create({
        body: `Your verification code is: ${code}`,
        from: Config.twilio.from,
        to: toE164,
      });
      return {sid: result.sid, to: result.to ?? toE164};
    } catch(err: any) {
      console.error(`[twilio] send failed: ${err?.message || err}`);
      throw new Error("Failed to send verification SMS.");
    }
  }

  /** Generate a 6-digit OTP. */
  private generateOTP(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  // ==========================================================
  // Auth: Login/verify user (JWT issue)
  // ==========================================================
  private getUserData() {
    this.router.post(
      "/verify-user",
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
          const username = String(req.body.username || "").trim();
          const password = String(req.body.password || "");

          if(!username || !password) {
            res
              .status(400)
              .json({status: "error", message: "Username and password required"});
            return;
          }

          const user: IUser | null = await UserModel.findOne({username});
          if(!user) {
            res.status(401).json({status: "error", message: "Invalid username"});
            return;
          }

          const isPasswordValid = await Argon2.verify(user.password, password);
          if(!isPasswordValid) {
            res.status(401).json({status: "error", message: "Invalid password"});
            return;
          }

          // JWT payload
          const payload = {
            sub: String(user._id),
            username: user.username,
            role: user.role as Role,
          };

          const token = jwt.sign(
            payload,
            process.env.JWT_SECRET || "defaultsecret",
            {expiresIn: "30d"}
          );

          // Remove password from the returned user
          const plain = user.toObject ? user.toObject() : (user as any);
          const {password: _omit, ...userWithoutPassword} = plain;

          res.status(200).json({
            status: "success",
            message: "User verified successfully!",
            token,
            user: userWithoutPassword,
          });
        } catch(error) {
          console.error("[verify-user] error:", error);
          res
            .status(500)
            .json({status: "error", message: "Error verifying user"});
          next(error);
        }
      }
    );
  }

  // ==========================================================
  // Create user (image upload → webp, email verify, OTP fields)
  // ==========================================================
  private createUser(): void {
    // Memory storage (we convert & write the file ourselves)
    const storage = multer.memoryStorage();

    // Accept images only
    const allowedTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/jpg",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      "image/ico",
    ]);

    const upload = multer({
      storage,
      limits: {fileSize: 5 * 1024 * 1024}, // 5MB
      fileFilter: (_req, file, cb) => {
        if(allowedTypes.has(file.mimetype)) cb(null, true);
        else cb(new Error("Only image files are allowed"));
      },
    });

    this.router.post(
      "/create-user",
      upload.fields([{name: "userimage", maxCount: 1}]),
      async (req: Request, res: Response): Promise<void> => {
        try {
          const files = req.files as Record<
            string,
            Express.Multer.File[] | undefined
          >;
          const image = files?.userimage?.[0];

          // Required strings
          const username = String(req.body.username || "").trim();
          const name = String(req.body.name || "").trim();
          const email = String(req.body.email || "").trim();
          const passRaw = String(req.body.userPassword || "").trim();
          const role = String(req.body.role || "user").trim();
          const creator = String(req.body.creator || "system").trim();

          // Required numerics / dates
          const age = this.toNum(req.body.age, NaN);
          const dateOfBirth = this.toDate(req.body.dateOfBirth);

          // Optional
          const phoneNumber = String(req.body.phoneNumber || "").trim();
          const gender = String(req.body.gender || "").trim();
          const bio = String(req.body.bio || "").trim();

          // Basic validation aligned with the model
          if(!username || !this.isSafeSegment(username)) {
            res
              .status(400)
              .json({status: "error", message: "Invalid username"});
            return;
          }
          if(!name) {
            res.status(400).json({status: "error", message: "Name is required"});
            return;
          }
          if(!email || !this.isEmail(email)) {
            res
              .status(400)
              .json({status: "error", message: "A valid email is required"});
            return;
          }
          if(!passRaw) {
            res
              .status(400)
              .json({status: "error", message: "Password is required"});
            return;
          }
          if(!dateOfBirth) {
            res
              .status(400)
              .json({status: "error", message: "Valid dateOfBirth is required"});
            return;
          }
          if(!Number.isFinite(age)) {
            res
              .status(400)
              .json({status: "error", message: "Valid age is required"});
            return;
          }
          if(!image) {
            res
              .status(400)
              .json({status: "error", message: "Profile image is required"});
            return;
          }

          // Ensure unique username before disk writes
          if(await UserModel.exists({username})) {
            res
              .status(409)
              .json({status: "error", message: "Username already exists"});
            return;
          }

          // Compute where to write the final image
          const imagePath = path.join(this.DEFAULT_PATH, username, "image.webp");
          await fse.ensureDir(path.dirname(imagePath));
          await sharp(image.buffer).webp({quality: 80}).toFile(imagePath);

          const baseUrl = `${req.protocol}://${req.get("host")}`;
          const publicImageUrl = `${baseUrl}/${this.DEFAULT_URL}/${encodeURIComponent(
            username
          )}/image.webp`;

          // Read structured inputs
          const access = this.parseJSON(req.body.access, undefined) as
            | IUser["access"]
            | undefined;

          // Optional email verification payload
          const verifyEmailObj = this.parseJSON<{
            token?: string;
            expires?: string;
          }>(req.body.verifyEmail, {});

          // If you want to send email verification now, do it before user save.
          if(verifyEmailObj.token) {
            const ok = await this.sendVerificationEmail(
              email,
              verifyEmailObj.token
            );
            if(!ok) {
              res
                .status(502)
                .json({
                  status: "error",
                  message: "Failed to send verification email",
                });
              return;
            }
          }

          // Prepare OTP (if you want to start with an OTP flow)
          const otp = this.generateOTP();
          // Optional custom TTL seconds; otherwise 5 minutes
          const otpTtlSecs = this.toNum(req.body.otpValidTime, 300);
          const otpExpires = new Date(Date.now() + otpTtlSecs * 1000);

          // Hash password
          const password = await this.hashPassword(passRaw);

          // Build address (required in model)
          const address = {
            street: String(req.body.street || "").trim(),
            houseNumber: String(req.body.houseNumber || "").trim(),
            city: String(req.body.city || "").trim(),
            postcode: String(req.body.postcode || "").trim(),
            country: String(req.body.country || "").trim() || undefined,
            stateOrProvince:
              String(req.body.stateOrProvince || "").trim() || undefined,
          };
          if(!address.street || !address.houseNumber || !address.city || !address.postcode) {
            res
              .status(400)
              .json({
                status: "error",
                message:
                  "Address fields street, houseNumber, city, postcode are required",
              });
            return;
          }

          // Create user document (aligned with the schema)
          const newUser = new UserModel({
            name,
            username,
            email,
            password,
            dateOfBirth,
            age,
            gender,
            bio,
            phoneNumber,
            role, // must be one of model enums
            image: publicImageUrl,
            isActive: this.toBool(req.body.isActive, true),
            address,
            access: access ?? {
              role,
              permissions: [], // fallback minimal shape if not provided
            },
            otpVerifycation: false, // not verified yet
            otpToken: otp,
            otpTokenExpires: otpExpires, // <-- aligns with model
            emailVerified: false,
            emailVerificationToken: verifyEmailObj.token || undefined,
            emailVerificationTokenExpires: verifyEmailObj.expires
              ? new Date(verifyEmailObj.expires)
              : undefined,
            autoDelete: this.toBool(req.body.autoDelete, true),
            creator,
          });

          await newUser.save();

          // Broadcast to back-office roles (best-effort)
          const notificationService = new NotificationService();
          const io = req.app.get("io") as import("socket.io").Server;

          await notificationService.createNotification(
            {
              title: "New User",
              body: `User ${newUser.name || newUser.username} has registered.`,
              type: "create",
              severity: "info",
              audience: {mode: "role", roles: ["admin", "manager", "operator"]},
              channels: ["inapp", "email"],
              metadata: {
                username: newUser.username,
                email: newUser.email,
                role: newUser.role,
                createdAt: newUser.createdAt,
                creator: newUser.creator,
              },
            },
            (rooms, payload) =>
              rooms.forEach((room) => io.to(room).emit("notification.new", payload))
          );

          res.status(201).json({
            status: "success",
            message: "User created successfully",
            user: newUser,
          });
        } catch(error: any) {
          console.error("[create-user] error:", error?.message || error);
          res.status(500).json({
            status: "error",
            message: `Failed to create user: ${error?.message || "Internal error"}`,
          });
        }
      }
    );
  }

  // ==========================================================
  // Update user (optional image replace, partial updates)
  // ==========================================================
  private updateUser(): void {
    const storage = multer.memoryStorage();
    const allowedTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/jpg",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      "image/ico",
    ]);

    const upload = multer({
      storage,
      limits: {fileSize: 5 * 1024 * 1024},
      fileFilter: (_req, file, cb) => {
        if(allowedTypes.has(file.mimetype)) cb(null, true);
        else cb(new Error("Only image files are allowed"));
      },
    });

    this.router.put(
      "/user-update/:username",
      upload.fields([{name: "userimage", maxCount: 1}]),
      async (req: Request<{username: string}>, res: Response): Promise<void> => {
        try {
          const username = String(req.params.username || "").trim();
          if(!username || !this.isSafeSegment(username)) {
            res
              .status(400)
              .json({status: "error", message: "Invalid username"});
            return;
          }

          const user = await UserModel.findOne({username});
          if(!user) {
            res.status(404).json({status: "error", message: "User not found"});
            return;
          }

          const files = req.files as Record<
            string,
            Express.Multer.File[] | undefined
          >;
          const image = files?.userimage?.[0];

          const baseUrl = `${req.protocol}://${req.get("host")}`;
          let imageUrl = user.image;

          // If there is a new image -> convert to webp and replace
          if(image) {
            const imagePath = path.join(this.DEFAULT_PATH, username, "image.webp");
            await fse.ensureDir(path.dirname(imagePath));
            await fse.remove(imagePath).catch(() => {});
            await sharp(image.buffer).webp({quality: 80}).toFile(imagePath);
            imageUrl = `${baseUrl}/${this.DEFAULT_URL}/${encodeURIComponent(
              username
            )}/image.webp`;
          }

          const body = req.body as Record<string, any>;

          // Prepare updates (only set provided fields)
          const updates: Record<string, any> = {updatedAt: new Date()};

          // Immutable identity key
          updates["username"] = username;

          if("name" in body) updates["name"] = String(body.name || "").trim();

          if("email" in body) {
            const newEmail = String(body.email || "").trim();
            if(!this.isEmail(newEmail)) {
              res
                .status(400)
                .json({status: "error", message: "Invalid email format"});
              return;
            }
            updates["email"] = newEmail;
          }

          if("dateOfBirth" in body) {
            const dob = this.toDate(body.dateOfBirth);
            if(!dob) {
              res
                .status(400)
                .json({status: "error", message: "Invalid dateOfBirth"});
              return;
            }
            updates["dateOfBirth"] = dob;
          }

          if("age" in body) {
            const n = this.toNum(body.age, NaN);
            if(!Number.isFinite(n)) {
              res
                .status(400)
                .json({status: "error", message: "Invalid age"});
              return;
            }
            updates["age"] = n;
          }

          if("gender" in body) updates["gender"] = String(body.gender || "").trim();
          if("bio" in body) updates["bio"] = String(body.bio || "").trim();
          if("phoneNumber" in body)
            updates["phoneNumber"] = String(body.phoneNumber || "").trim();

          // image (replace if uploaded)
          updates["image"] = imageUrl;

          if("role" in body) updates["role"] = String(body.role || "").trim();
          if("isActive" in body) updates["isActive"] = this.toBool(body.isActive);

          // address (merge fields)
          const addrKeys = [
            "street",
            "houseNumber",
            "city",
            "postcode",
            "country",
            "stateOrProvince",
          ] as const;
          const addr: Record<string, any> = {};
          for(const k of addrKeys) {
            if(k in body) addr[k] = String(body[k] ?? "").trim();
          }
          if(Object.keys(addr).length > 0) {
            updates["address"] = {...(user.address || {}), ...addr};
          }

          // Access: expect JSON or object
          if("access" in body) {
            const access = this.parseJSON<IUser["access"]>(body.access, user.access);
            updates["access"] = access;
          }

          if("creator" in body)
            updates["creator"] = String(body.creator || "").trim();
          if("updator" in body)
            updates["updator"] = String(body.updator || "").trim();

          // Optional password change
          if("password" in body && typeof body.password === "string") {
            const pw = body.password.trim();
            if(pw) {
              updates["password"] = await this.hashPassword(pw);
            }
          }

          // Optional: email change triggers new verify token/expiry
          if("emailVerificationToken" in body) {
            updates["emailVerificationToken"] = String(
              body.emailVerificationToken || ""
            ).trim();
          }
          if("emailVerificationTokenExpires" in body) {
            const exp = this.toDate(body.emailVerificationTokenExpires);
            if(exp) updates["emailVerificationTokenExpires"] = exp;
          }

          const updatedUser = await UserModel.findOneAndUpdate(
            {username},
            {$set: updates},
            {new: true, upsert: false}
          );

          if(!updatedUser) {
            res
              .status(404)
              .json({status: "error", message: "User not found or update failed"});
            return;
          }

          // Notify back-office (best-effort)
          const notificationService = new NotificationService();
          const io = req.app.get("io") as import("socket.io").Server;

          await notificationService.createNotification(
            {
              title: "Update User",
              body: `User ${updatedUser.name || updatedUser.username} has been updated.`,
              type: "update",
              severity: "info",
              audience: {mode: "role", roles: ["admin", "manager", "operator"]},
              channels: ["inapp", "email"],
              metadata: {
                username: updatedUser.username,
                email: updatedUser.email,
                role: updatedUser.role,
                updatedAt: new Date(),
                updatedBy:
                  (typeof body.updator === "string"
                    ? body.updator.trim()
                    : undefined) || "system",
              },
            },
            (rooms, payload) =>
              rooms.forEach((room) => io.to(room).emit("notification.new", payload))
          );

          res.status(200).json({
            status: "success",
            message: "User updated successfully",
            user: updatedUser,
          });
        } catch(error: any) {
          console.error("[user-update] error:", error?.message || error);
          res
            .status(500)
            .json({status: "error", message: error?.message || "Server error"});
        }
      }
    );
  }

  // ==========================================================
  // Listing & search
  // ==========================================================
  private getAllUsers() {
    this.router.get("/users", async (_req: Request, res: Response) => {
      try {
        const users = await UserModel.find({}, {password: 0}).sort({
          createdAt: -1,
        });
        res.status(200).json(users);
      } catch(error) {
        res.status(500).json({error: `Failed to fetch users: ${error}`});
      }
    });
  }

  private getAllUsersWithPagination() {
    this.router.get(
      "/users-with-pagination/:start/:limit",
      async (req: Request, res: Response) => {
        try {
          const start = this.toNum(req.params.start, 0);
          const limit = this.toNum(req.params.limit, 10);
          const search = String(req.query.search || "").trim();

          const safeStart = Math.max(0, start);
          const safeLimit = Math.max(1, Math.min(limit, 100));

          const filter: any = {};
          if(search) {
            const rx = new RegExp(this.escapeRegex(search), "i");
            filter.$or = [{name: rx}, {username: rx}, {email: rx}];
          }

          const count = await UserModel.countDocuments(filter);
          const users = await UserModel.find(filter, {password: 0})
            .sort({createdAt: -1})
            .skip(safeStart)
            .limit(safeLimit)
            .lean();

          res.status(200).json({
            count,
            start: safeStart,
            end: Math.min(safeStart + safeLimit, count),
            limit: safeLimit,
            data: users,
          });
        } catch(error) {
          console.error("Pagination error:", error);
          res.status(500).json({message: "Internal server error: " + error});
        }
      }
    );
  }

  private findUserByUsername() {
    this.router.get(
      "/user-username/:username",
      async (req: Request<{username: string}>, res: Response) => {
        try {
          const username = String(req.params.username || "").trim();
          if(!username) {
            res.status(400).json({status: "error", message: "Username required"});
            return;
          }
          const exists = await UserModel.exists({username});
          res.status(200).json({status: exists ? "true" : "false"});
        } catch(error) {
          console.error("findUserByUsername:", error);
          res.status(500).json({status: "error", message: "Server error"});
        }
      }
    );
  }

  private findUserByEmail() {
    this.router.get(
      "/user-email/:email",
      async (req: Request<{email: string}>, res: Response) => {
        try {
          const email = decodeURIComponent(req.params.email ?? "").trim();
          if(!this.isEmail(email)) {
            res.status(400).json({status: "error", message: "Invalid email"});
            return;
          }
          const user = await UserModel.findOne({
            email: {$regex: `^${this.escapeRegex(email)}$`, $options: "i"},
          });
          res.status(200).json({status: user ? "true" : "false"});
        } catch(error) {
          console.error("findUserByEmail:", error);
          res.status(500).json({status: "error", message: "Server error"});
        }
      }
    );
  }

  private findUserByPhone() {
    this.router.get(
      "/user-phone/:phone",
      async (req: Request<{phone: string}>, res: Response) => {
        try {
          const phoneNumber = String(req.params.phone || "").trim();
          const phoneRegex = /^(?:\+?[1-9]\d{1,3}|0)[\d\s\-()]{7,20}$/;
          if(!phoneRegex.test(phoneNumber)) {
            res
              .status(400)
              .json({status: "error", message: "Invalid phone number format"});
            return;
          }
          const user = await UserModel.findOne({
            phoneNumber: {
              $regex: `^${this.escapeRegex(phoneNumber)}$`,
              $options: "i",
            },
          });
          res.status(200).json({
            status: user ? "success" : "error",
            message: user ? "Phone number exists!" : "Phone number does not exist!",
            data: user ?? null,
          });
        } catch(error) {
          console.error("findUserByPhone:", error);
          res.status(500).json({status: "error", message: "Server error"});
        }
      }
    );
  }

  // ==========================================================
  // Email verification flow
  // ==========================================================
  private verifyNewUserEmail() {
    // NOTE: route spelling kept to match your original path `/emailverifycation/...`
    this.router.get(
      "/emailverifycation/:token",
      async (req: Request<{token: string}>, res: Response) => {
        try {
          const token = req.params.token;
          const user = await UserModel.findOne({
            emailVerificationToken: token,
            emailVerificationTokenExpires: {$gt: new Date()},
          });

          if(!user) {
            res
              .status(400)
              .sendFile(
                path.join(__dirname, "../../public/error/emailExpire.html"),
                (error) => error && console.error(error)
              );
            return;
          }

          user.emailVerified = true;
          delete (user as any).emailVerificationToken;
          delete (user as any).emailVerificationTokenExpires;
          user.autoDelete = false;
          await user.save();

          // Redirect to your frontend
          res.redirect(process.env.FRONTEND_ORIGIN || "http://localhost:4200");
        } catch(e) {
          console.error("[emailverifycation] error:", e);
          res.status(500).send("Server error");
        }
      }
    );
  }

  private async sendVerificationEmail(
    userEmail: string,
    token: string
  ): Promise<boolean> {
    const verifyLink = `http://localhost:3000/api-user/emailverifycation/${token}`;
    const html = `
      <div style="max-width:600px;margin:auto;border:1px solid #e0e0e0;border-radius:8px;padding:20px;font-family:Arial,sans-serif">
        <h2 style="text-align:center;color:#007bff">Verify Your Email Address</h2>
        <p>Hi there,</p>
        <p>Thanks for registering. Click below to verify your email:</p>
        <div style="text-align:center;margin:30px 0">
          <a href="${verifyLink}" style="background:#007bff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:5px">Verify Email</a>
        </div>
        <p>If the button doesn't work, copy this link:</p>
        <p style="word-break:break-word">${verifyLink}</p>
      </div>
    `;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const sent = await transporter.sendMail({
      from: '"PropEase Real Estate" <no-reply@propease.com>',
      to: userEmail,
      subject: "Verify Your Email",
      html,
    });

    return !!sent;
  }

  // ==========================================================
  // One-time view token endpoints (utility)
  // ==========================================================
  private generateToken() {
    this.router.post(
      "/generate-token",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const username = String(req.body.username || "").trim();
          if(!username) {
            res.status(400).json({status: "error", message: "Invalid username"});
            return;
          }

          const token = crypto.randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

          const saved = await TokenMap.create({
            token,
            username,
            type: "view",
            expiresAt,
          });
          if(!saved) throw new Error("Failed to persist token");

          res.status(201).json({
            status: "success",
            message: "Token generated successfully",
            token: saved.token,
          });
        } catch(error) {
          console.error("[generate-token] error:", error);
          res.status(500).json({
            status: "error",
            message: "Server error occurred",
          });
        }
      }
    );
  }

  private getUserByToken() {
    this.router.get(
      "/user-token/:token",
      async (req: Request<{token: string}>, res: Response): Promise<void> => {
        try {
          const token = String(req.params.token || "");
          if(!token) {
            res.status(400).json({status: "error", message: "Token required"});
            return;
          }

          const record = await TokenMap.findOne({token});
          if(!record || record.expiresAt <= new Date()) {
            res.status(404).json({status: "error", message: "Token not found/expired"});
            return;
          }

          const user = await UserModel.findOne({username: record.username});
          if(!user) {
            res.status(404).json({status: "error", message: "User not found"});
            return;
          }

          res.status(200).json({
            status: "success",
            message: "User found",
            user,
          });
        } catch(error) {
          console.error("[user-token] error:", error);
          res.status(500).json({
            status: "error",
            message: "Server error occurred",
          });
        }
      }
    );
  }

  // ==========================================================
  // User document upload & retrieval
  // ==========================================================
  private uploadDocument(): void {
    const allowedTypes = new Set<string>([
      // Word
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
      // PDF & text
      "application/pdf",
      "text/plain",
      // Images
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/jpg",
      "image/svg+xml",
      "image/x-icon",
      "image/vnd.microsoft.icon",
    ]);

    const storage = multer.diskStorage({
      destination: async (req, _file, cb) => {
        try {
          const username = String(req.params.username || "").trim();
          if(!username || !this.isSafeSegment(username)) {
            cb(new Error("Username is required/invalid"), "");
            return;
          }
          const uploadPath = path.join(this.DEFAULT_PATH, username, "documents");
          await fse.ensureDir(uploadPath);
          cb(null, uploadPath);
        } catch(e: any) {
          cb(e instanceof Error ? e : new Error(String(e)), "");
        }
      },
      filename: (_req, file, cb) => {
        const original = path.basename(file.originalname).replace(/\s+/g, "_");
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${unique}-${original}`);
      },
    });

    const upload = multer({
      storage,
      limits: {fileSize: 20 * 1024 * 1024, files: 10},
      fileFilter: (_req, file, cb) => {
        if(allowedTypes.has(file.mimetype)) cb(null, true);
        else cb(new Error(`File type not allowed: ${file.mimetype}`));
      },
    });

    this.router.post(
      "/user-document-upload/:username",
      upload.array("files", 10),
      async (req: Request<{username: string}>, res: Response): Promise<void> => {
        try {
          const files = req.files as Express.Multer.File[] | undefined;
          if(!files?.length) {
            res.status(400).json({status: "error", message: "No files uploaded"});
            return;
          }

          const username = String(req.params.username || "").trim();
          if(!username || !this.isSafeSegment(username)) {
            res
              .status(400)
              .json({status: "error", message: "Invalid username format"});
            return;
          }

          if(!(await UserModel.exists({username}))) {
            await Promise.all(files.map((f) => fse.remove(f.path).catch(() => {})));
            res.status(404).json({status: "error", message: "User not found"});
            return;
          }

          const baseUrl = `${req.protocol}://${req.get("host")}`;
          const uploader = String(req.body?.uploader || "system").trim();

          const savedFiles = files.map((file) => ({
            originalName: file.originalname,
            storedName: file.filename,
            mimeType: file.mimetype,
            size: file.size,
            path: file.path, // internal path (omit if you prefer)
            extension: path.extname(file.originalname),
            download: `${username}/documents/${file.filename}`,
            URL: `${baseUrl}/${this.DEFAULT_URL}/${encodeURIComponent(
              username
            )}/documents/${encodeURIComponent(file.filename)}`,
            uploader,
            uploadDate: new Date(),
          }));

          const doc = await UserDocument.findOneAndUpdate(
            {username},
            {$push: {files: {$each: savedFiles}}},
            {upsert: true, new: true}
          );

          if(!doc) {
            res.status(500).json({status: "error", message: "Failed to save files"});
            return;
          }

          res.status(200).json({
            status: "success",
            message: "Files uploaded successfully",
            fileCount: files.length,
            uploadedFiles: savedFiles.map((f) => ({
              originalName: f.originalName,
              storedName: f.storedName,
              mimeType: f.mimeType,
              size: f.size,
              extension: f.extension,
              URL: f.URL,
              uploader: f.uploader,
              uploadedAt: f.uploadDate,
            })),
          });
        } catch(error: any) {
          console.error("[user-document-upload] error:", error?.message || error);
          res.status(500).json({
            status: "error",
            message: error?.message || "Server error",
          });
        }
      }
    );
  }

  private getUserDocuments() {
    this.router.get(
      "/uploads/:username/documents",
      async (req: Request<{username: string}>, res: Response) => {
        try {
          const username = String(req.params.username || "").trim();
          if(!username) throw new Error("Username is required");
          const user = await UserDocument.findOne({username}).sort({
            updatedAt: -1,
          });
          if(!user) throw new Error("User not found");
          res.status(200).json({
            status: "success",
            message: "Files retrieved successfully",
            data: user.files,
          });
        } catch(error) {
          console.error("getUserDocuments:", error);
          res
            .status(500)
            .json({status: "error", message: "Server error: " + error});
        }
      }
    );
  }

  // ==========================================================
  // Single user read
  // ==========================================================
  private getUserDataByUsername() {
    this.router.get(
      "/user-data/:username",
      async (req: Request<{username: string}>, res: Response) => {
        try {
          const username = String(req.params.username || "").trim();
          if(!username) throw new Error("Username is required");
          const user = await UserModel.findOne({username}, {password: 0});
          if(!user) throw new Error("User not found");
          res.status(200).json({
            status: "success",
            message: "User found",
            data: user,
          });
        } catch(error) {
          res.status(500).json({status: "error", message: String(error)});
        }
      }
    );
  }

  // ==========================================================
  // Delete user (move media to recyclebin, clear relations)
  // ==========================================================
  private deleteUserByUsername() {
    this.router.delete(
      "/user-delete/:username/:deletedBy",
      async (
        req: Request<{username: string; deletedBy: string}>,
        res: Response
      ): Promise<void> => {
        try {
          const username = String(
            req.params.username || req.body?.username || req.query?.username || ""
          ).trim();
          const deletedBy = String(
            req.params.deletedBy ||
            req.body?.deletedBy ||
            req.query?.deletedBy ||
            ""
          ).trim();

          if(!username) throw new Error("Username is required");
          if(!deletedBy) throw new Error("Deletor is required");
          if(!this.isSafeSegment(username)) {
            res
              .status(400)
              .json({status: "error", message: "Invalid username format"});
            return;
          }

          const baseUrl = `${req.protocol}://${req.get("host")}`;

          const userDoc = await UserModel.findOne({username}).lean();
          const recycleUserDir = path.join(this.RECYCLE_PATH, username);
          const userImagePath = path.join(
            this.DEFAULT_PATH,
            username,
            "image.webp"
          );
          const userDocsPath = path.join(this.DEFAULT_PATH, username, "documents");
          const deletedCopyDir = path.join(this.DEFAULT_PATH, "deleted", username);
          const deletedCopyImage = path.join(deletedCopyDir, "image.webp");
          const deletedImageURL = `${baseUrl}/${this.DEFAULT_URL}/deleted/${encodeURIComponent(
            username
          )}/image.webp`;

          await fse.ensureDir(recycleUserDir);

          // Save snapshot to recyclebin
          if(userDoc) {
            await fse.writeJson(path.join(recycleUserDir, "data.json"), userDoc, {
              spaces: 2,
            });
          }

          // Keep a "deleted preview" copy under /uploads/users/deleted/<username>/
          if(await fse.pathExists(userImagePath)) {
            await fse.ensureDir(deletedCopyDir);
            await fse.copy(userImagePath, deletedCopyImage, {overwrite: true});
          }

          // Move image to recyclebin
          if(await fse.pathExists(userImagePath)) {
            await fse.copy(userImagePath, path.join(recycleUserDir, "image.webp"), {
              overwrite: true,
            });
            await fse.remove(userImagePath);
          }

          // Move documents to recyclebin
          if(await fse.pathExists(userDocsPath)) {
            await fse.copy(userDocsPath, path.join(recycleUserDir, "documents"), {
              overwrite: true,
            });
            await fse.remove(userDocsPath);
          }

          // Clean example relations (optional; adjust for your app)
          await PropertyModel.updateMany({owner: username}, {$unset: {owner: 1}});
          await PropertyModel.updateMany(
            {"addedBy.username": username},
            {$unset: {addedBy: {} as any}}
          );

          // Notify back-office
          if(userDoc) {
            const notificationService = new NotificationService();
            const io = req.app.get("io") as import("socket.io").Server;

            await notificationService.createNotification(
              {
                title: "Delete User",
                body: `User ${userDoc.name ?? username} has been deleted.`,
                type: "delete",
                severity: "warning",
                audience: {mode: "role", roles: ["admin", "manager", "operator"]},
                channels: ["inapp", "email"],
                metadata: {
                  username,
                  userId: String(userDoc._id ?? ""),
                  deletedBy,
                  deletedAt: new Date().toISOString(),
                  recyclebinUrl: `${this.RECYCLE_URL}/${encodeURIComponent(
                    username
                  )}/`,
                  deletedImageURL,
                },
              },
              (rooms, payload) =>
                rooms.forEach((r) => io.to(r).emit("notification.new", payload))
            );
          }

          // Remove from DB last
          const deleted = await UserModel.findOneAndDelete({username}).lean();
          if(!deleted) {
            res.status(404).json({status: "error", message: "User not found"});
            return;
          }

          res.status(200).json({
            status: "success",
            message: "User deleted successfully",
            data: {
              username,
              recyclebin: path.join(this.RECYCLE_URL, username, "/"),
              deletedImageURL,
            },
          });
        } catch(err: any) {
          console.error("[user-delete] error:", err?.message || err);
          res
            .status(500)
            .json({status: "error", message: err?.message || "Internal error"});
        }
      }
    );
  }
}
