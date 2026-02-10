// ==========================================================
// Path: src/api/user.router.ts
// Description: User routes (create, verify, update, search,
//              upload docs, token utilities, and deletion).
// Notes:
//  - Class-based router (no global functions).
//  - Validations aligned with src/models/user.model.ts.
//  - Safer file handling & structured error responses.
// ==========================================================

import * as Argon2 from "argon2";
import crypto from "crypto";
import express, { Request, Response, Router } from "express";
import fse from "fs-extra";
import nodemailer from "nodemailer";
import path from "path";
import twilio, { Twilio } from "twilio";

import { Config } from "../configs/config";
import { ENV } from "../configs/env.config";

import {
  UserDocumentModel,
  type UserDocumentEntity,
} from "../models/file-upload.model";
import { PropertyModel } from "../models/property.model";
import { TokenMap } from "../models/token.model";
import { USER_MODEL_PROJECTION, UserModel, type IUser, type User } from "../models/user.model";

import { GuardTokenService } from "../services/guard-token.service";
import NotificationService from "../services/notification.service";

import type { PaginationMeta } from "../types/api-message";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";
import FileUploader from "../utils/file-uploader.helper";

export default class UserRoute {
  // Guard service:
  private readonly guardTokenService: GuardTokenService = new GuardTokenService();

  // ──────────────────────────────────────────────────────────
  // Paths (must match your static mount)
  // ──────────────────────────────────────────────────────────
  private readonly DEFAULT_PATH: string = path.join(
    __dirname,
    "../../public/uploads/users/"
  );
  private readonly RECYCLE_PATH: string = path.join(
    __dirname,
    "../../public/recyclebin/users/"
  );
  private readonly DEFAULT_URL: string = "uploads/users";
  private readonly RECYCLE_URL: string = "recyclebin/users";

  private readonly router: Router;
  private readonly twilioClient: Twilio = twilio(
    Config.twilio.sid,
    Config.twilio.token
  );

  constructor () {
    this.router = express.Router();

    // ────────────────────────────────────────────────────────
    // Route registrations
    // ────────────────────────────────────────────────────────

    // CRUD: user
    this.createUser();
    this.updateUser();
    this.deleteUserByUsername();
    this.getUserDataByUsername();
    this.getUserDataById();
    this.getUserSectionByKey();

    // Listing / search
    this.getAllUsers();
    this.getAllUserCount();
    this.getAllUsersWithPagination();
    this.findUserById();
    this.findUserByUsername();
    this.findUserByEmail();
    this.findUserByPhone();

    // Email verification
    this.verifyNewUserEmail();

    // Token utilities
    this.generateToken();
    this.getUserByToken();

    // Document upload / retrieval
    this.uploadDocument();
    this.getUserDocuments();
  }

  public get route(): Router {
    return this.router;
  }

  // ==========================================================
  // Utilities / helpers
  // ==========================================================

  /** Hash password with Argon2 (strong default params). */
  private async hashPassword( password: string ): Promise<string> {
    return Argon2.hash( password );
  }

  /** Guard for safe single path segments (avoid traversal/odd chars). */
  private isSafeSegment( seg: string ): boolean {
    return /^[A-Za-z0-9._-]+$/.test( seg );
  }

  /** Parse JSON safely with fallback – supports strings or plain objects. */
  private parseJSON<T = unknown>( value: unknown, fallback: T ): T {
    try {
      if ( value == null ) return fallback;

      if ( typeof value === "string" ) {
        const t = value.trim();
        if ( !t ) return fallback;
        return JSON.parse( t ) as T;
      }

      // If it's already an object/array, just trust the shape
      return value as T;
    } catch {
      return fallback;
    }
  }

  /** Escape user-supplied regex parts. */
  private escapeRegex( str: string ): string {
    return str.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
  }

  /** Email validation (basic but safe). */
  private isEmail( v: string ): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test( v );
  }

  /** Convert to boolean from string or boolean input. */
  private toBool( v: unknown, def = false ): boolean {
    if ( typeof v === "boolean" ) return v;
    if ( typeof v === "string" ) {
      const s = v.trim().toLowerCase();
      if ( s === "true" ) return true;
      if ( s === "false" ) return false;
    }
    return def;
  }

  /** Convert to number safely (NaN → fallback). */
  private toNum( v: unknown, fallback = 0 ): number {
    const n = Number( v );
    return Number.isFinite( n ) ? n : fallback;
  }

  /** Parse date or return null. */
  private toDate( v: unknown ): Date | null {
    if ( typeof v !== "string" && !( v instanceof Date ) ) return null;
    const d = new Date( v as any );
    return Number.isNaN( d.getTime() ) ? null : d;
  }

  /** Ensure E.164 format for Twilio sends. */
  private ensureE164( phone: string ): string {
    const trimmed = phone.trim();
    const e164 = /^\+[1-9]\d{7,14}$/;
    if ( !e164.test( trimmed ) ) {
      throw new Error(
        `Invalid phone format. Provide E.164 like +9477xxxxxxx (got "${ phone }").`
      );
    }
    return trimmed;
  }

  /** Send SMS via Twilio (for OTP). */
  private async verifyPhoneNumber(
    to: string,
    otp: string
  ): Promise<{ sid: string; to: string; }> {
    const code = String( otp ?? "" ).trim();
    if ( code.length < 4 || code.length > 10 ) {
      throw new Error( "OTP length invalid." );
    }
    const toE164 = this.ensureE164( to );

    try {
      const result = await this.twilioClient.messages.create( {
        body: `Your verification code is: ${ code }`,
        from: Config.twilio.from,
        to: toE164,
      } );
      return { sid: result.sid, to: result.to ?? toE164 };
    } catch ( err: any ) {
      console.error( "[twilio] send failed:", err?.message || err );
      throw new Error( "Failed to send verification SMS." );
    }
  }

  /** Generate a 6-digit OTP. */
  private generateOTP(): string {
    return String( Math.floor( 100000 + Math.random() * 900000 ) );
  }

  /**
   * Build PhoneNumber object for new IUser model:
   *  phoneNumber?: { code: CountryCodes; number: string }
   *
   * Expecting frontend to send JSON in `req.body.phoneNumber`, e.g.:
   *  {
   *    "code": { "name": "...", "code": "+94", "flags": { ... } },
   *    "number": "771234567"
   *  }
   */
  private buildPhoneNumberFromBody(
    body: Record<string, unknown>
  ): IUser[ "phoneNumber" ] | undefined {
    const raw: unknown = body?.phoneNumber;

    if ( !raw ) {
      return undefined;
    }

    // If frontend already sends an object (from fetch / axios, not FormData)
    if ( typeof raw === "object" ) {
      const candidate = raw as IUser[ "phoneNumber" ];
      if ( candidate && typeof candidate.number === "string" && candidate.code ) {
        return candidate;
      }
    }

    // If it came as JSON string in multipart/form-data → parse
    if ( typeof raw === "string" ) {
      const parsed = this.parseJSON<IUser[ "phoneNumber" ] | null>( raw, null );
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.number === "string" &&
        parsed.code
      ) {
        return parsed;
      }
    }

    // Fallback: ignore if malformed; user.phoneNumber stays undefined
    return undefined;
  }

  /** Normalize phone for search: remove spaces, dashes, parentheses. Keep leading '+' if present. */
  private normalizePhoneForSearch( raw: string ): string {
    const trimmed = String( raw || '' ).trim();
    if ( !trimmed ) return '';

    // Keep leading + if present, strip it from the rest
    const hasPlus = trimmed.startsWith( '+' );
    const digitsOnly = trimmed.replace( /[^\d]/g, '' );

    return hasPlus ? `+${ digitsOnly }` : digitsOnly;
  }

  /** Env helper for cookie security. */
  private isProductionEnv(): boolean {
    return process.env.NODE_ENV === "production";
  }


  // ==========================================================
  // Create user (image upload → webp, email verify, OTP fields)
  // ==========================================================

  private createUser(): void {
    // Centralised: delegate to FileUploader helper
    const allowedTypes = new Set<string>( [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/jpg",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      "image/ico",
    ] );

    // Expect FileUploader.createMemoryUpload(...) to return a configured multer instance
    const upload = FileUploader.createMemoryUpload( allowedTypes, 20 ); // 20 MB

    this.router.post(
      "/create-user",
      upload.fields( [ { name: "userimage", maxCount: 1 } ] ),
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const files = req.files as Record<
            string,
            Express.Multer.File[] | undefined
          >;
          const image = files?.userimage?.[ 0 ];

          // Required strings
          const username = String( req.body.username || "" ).trim();
          const name = String( req.body.name || "" ).trim();
          const email = String( req.body.email || "" ).trim();
          const passRaw = String( req.body.userPassword || "" ).trim();
          const role = String( req.body.role || "user" ).trim();
          const creator = String( req.body.creator || "system" ).trim();

          // NEW: nationality (required by model)
          const nationality = String( req.body.nationality || "" ).trim();
          const nicOrPassport = String( req.body.nicOrPassport || "" ).trim();

          // Required numerics / dates
          const age = this.toNum( req.body.age, NaN );
          const dateOfBirth = this.toDate( req.body.dateOfBirth );
          const multiAuthEnabled: boolean = this.toBool(
            req.body.multiAuthEnabled,
            false
          );

          // Optional
          const gender = String( req.body.gender || "" ).trim();
          const bio = String( req.body.bio || "" ).trim();

          // phoneNumber for new model (object)
          const phoneNumber = this.buildPhoneNumberFromBody(
            req.body as Record<string, unknown>
          );

          // Basic validation aligned with the model
          if ( !username || !this.isSafeSegment( username ) ) {
            ApiResponseBuilder.validationError( res, "Invalid username" );
            return;
          }
          if ( !name ) {
            ApiResponseBuilder.validationError( res, "Name is required" );
            return;
          }
          if ( !email || !this.isEmail( email ) ) {
            ApiResponseBuilder.validationError( res, "A valid email is required" );
            return;
          }
          if ( !passRaw ) {
            ApiResponseBuilder.validationError( res, "Password is required" );
            return;
          }
          if ( !dateOfBirth ) {
            ApiResponseBuilder.validationError(
              res,
              "Valid dateOfBirth is required"
            );
            return;
          }
          if ( !Number.isFinite( age ) ) {
            ApiResponseBuilder.validationError( res, "Valid age is required" );
            return;
          }
          if ( !image ) {
            ApiResponseBuilder.validationError(
              res,
              "Profile image is required"
            );
            return;
          }
          if ( !nationality ) {
            ApiResponseBuilder.validationError(
              res,
              "Nationality is required"
            );
            return;
          }
          if ( !nicOrPassport ) {
            ApiResponseBuilder.validationError(
              res,
              "NIC / Passport number is required"
            );
            return;
          }

          // Ensure unique username before disk writes
          if ( await UserModel.exists( { username } ) ) {
            ApiResponseBuilder.validationError( res, "Username already exists" );
            return;
          }

          // Use FileUploader to persist the image (webp) to /public/uploads/users/<username>/image.webp
          const baseUrl = `${ req.protocol }://${ req.get( "host" ) }`;
          const subPath = path.join( this.DEFAULT_PATH, `${ username }`, );
          const imageResult = await FileUploader.saveSingleWebPFromMemory( {
            req,
            subPath,
            fieldName: "image.webp",
            originalName: image.originalname,
            buffer: image.buffer,
            webpQuality: 80,
          } );

          const publicImageUrl = imageResult.basePublicUrl;

          // Access information
          const access = this.parseJSON<IUser[ "access" ] | undefined>(
            req.body.access,
            undefined
          );

          // Optional email verification payload
          const verifyEmailObj = this.parseJSON<{
            token?: string;
            expires?: string;
          }>( req.body.verifyEmail, {} );

          if ( verifyEmailObj.token ) {
            const ok = await this.sendVerificationEmail(
              email,
              verifyEmailObj.token
            );
            if ( !ok ) {
              ApiResponseBuilder.fail(
                res,
                "Failed to send verification email"
              );
              return;
            }
          }

          // Prepare OTP (if you want to start with an OTP flow)
          const otp = this.generateOTP();
          const otpTtlSecs = this.toNum( req.body.otpValidTime, 300 ); // default 5 minutes
          const otpExpires = new Date( Date.now() + otpTtlSecs * 1000 );

          // Hash password
          const password = await this.hashPassword( passRaw );

          // Build address (required in model)
          const address = {
            street: String( req.body.street || "" ).trim(),
            houseNumber: String( req.body.houseNumber || "" ).trim(),
            city: String( req.body.city || "" ).trim(),
            postcode: String( req.body.postcode || "" ).trim(),
            country: String( req.body.country || "" ).trim() || undefined,
            stateOrProvince:
              String( req.body.stateOrProvince || "" ).trim() || undefined,
          };
          if (
            !address.street ||
            !address.houseNumber ||
            !address.city ||
            !address.postcode
          ) {
            ApiResponseBuilder.validationError(
              res,
              "Address fields street, houseNumber, city and postcode are required"
            );
            return;
          }

          const newUserDoc: IUser = new UserModel( {
            name,
            username,
            email,
            password,
            dateOfBirth,
            age,
            gender,
            bio,
            phoneNumber, // new object type or undefined
            role,
            image: publicImageUrl,
            isActive: this.toBool( req.body.isActive, true ),
            address,
            access: access ?? {
              role,
              permissions: [],
            },
            otpVerifycation: false,
            otpToken: otp,
            otpTokenExpires: otpExpires,
            emailVerified: false,
            emailVerificationToken: verifyEmailObj.token || undefined,
            emailVerificationTokenExpires: verifyEmailObj.expires
              ? new Date( verifyEmailObj.expires )
              : undefined,
            multiAuthEnabled,
            autoDelete: this.toBool( req.body.autoDelete, true ),
            creator,
            nationality,
            nicOrPassport,
          } );

          await newUserDoc.save();

          // Broadcast to back-office roles (best-effort)
          const notificationService = new NotificationService();
          const io = req.app.get( "io" ) as import( "socket.io" ).Server;

          await notificationService.createNotification(
            {
              title: "New User",
              body: `User ${ newUserDoc.name || newUserDoc.username } has registered.`,
              type: "create",
              severity: "info",
              audience: {
                mode: "role",
                roles: [ "admin", "manager", "operator" ],
              },
              channels: [ "inapp", "email" ],
              metadata: {
                refId: newUserDoc.username,
                data: {
                  email: newUserDoc.email,
                  role: newUserDoc.role,
                  createdAt: newUserDoc.createdAt,
                  creator: newUserDoc.creator,
                },
              },
            },
            ( rooms, payload ) =>
              rooms.forEach( ( room ) =>
                io.to( room ).emit( "notification.new", payload )
              )
          );

          const safeUser: User = newUserDoc.toSafeDTO();

          ApiResponseBuilder.ok(
            res,
            "user",
            safeUser,
            "User created successfully"
          );
          return;
        } catch ( error: any ) {
          console.error( "[create-user] error:", error?.message || error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ==========================================================
  // Update user (optional image replace, partial updates)
  // ==========================================================

  private updateUser(): void {
    const allowedTypes = new Set<string>( [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/jpg",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      "image/ico",
    ] );

    // Centralised memory upload for profile images
    const upload = FileUploader.createMemoryUpload( allowedTypes, 20 ); // 20 MB

    this.router.put(
      "/user-update/:username",
      upload.fields( [ { name: "userimage", maxCount: 1 } ] ),
      async (
        req: Request<{ username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const username = String( req.params.username || "" ).trim();
          if ( !username || !this.isSafeSegment( username ) ) {
            ApiResponseBuilder.validationError( res, "Invalid username" );
            return;
          }

          const userDoc = await UserModel.findOne( { username }, USER_MODEL_PROJECTION );
          if ( !userDoc ) {
            ApiResponseBuilder.notFound( res, "User not found" );
            return;
          }

          const files = req.files as Record<
            string,
            Express.Multer.File[] | undefined
          >;
          const image = files?.userimage?.[ 0 ];

          const baseUrl = `${ req.protocol }://${ req.get( "host" ) }`;
          let imageUrl = userDoc.image;

          // If there is a new image -> convert to webp and replace
          if ( image ) {
            const subPath = path.join( this.DEFAULT_PATH, `${ username }`, );
            const imageResult = await FileUploader.saveSingleWebPFromMemory( {
              req,
              subPath,
              fieldName: "image.webp",
              originalName: image.originalname,
              buffer: image.buffer,
              webpQuality: 80,
            } );

            imageUrl = imageResult.basePublicUrl;

          }

          const body = req.body as Record<string, any>;

          // Prepare updates (only set provided fields)
          const updates: Record<string, any> = { updatedAt: new Date() };

          // Immutable identity key
          updates.username = username;

          if ( "name" in body ) {
            updates.name = String( body.name || "" ).trim();
          }

          if ( "email" in body ) {
            const newEmail = String( body.email || "" ).trim();
            if ( !this.isEmail( newEmail ) ) {
              ApiResponseBuilder.validationError( res, "Invalid email format" );
              return;
            }
            updates.email = newEmail;
          }

          if ( "dateOfBirth" in body ) {
            const dob = this.toDate( body.dateOfBirth );
            if ( !dob ) {
              ApiResponseBuilder.validationError( res, "Invalid dateOfBirth" );
              return;
            }
            updates.dateOfBirth = dob;
          }

          if ( "age" in body ) {
            const n = this.toNum( body.age, NaN );
            if (
              !Number.isFinite( n ) ||
              !Number.isInteger( n ) ||
              Number.isNaN( n )
            ) {
              ApiResponseBuilder.validationError( res, "Invalid age" );
              return;
            }
            updates.age = n;
          }

          if ( "gender" in body ) {
            updates.gender = String( body.gender || "" ).trim();
          }

          if ( "bio" in body ) {
            updates.bio = String( body.bio || "" ).trim();
          }

          if ( "nationality" in body ) {
            updates.nationality = String( body.nationality || "" ).trim();
          }

          if ( "nicOrPassport" in body ) {
            updates.nicOrPassport = String( body.nicOrPassport || "" ).trim();
          }

          // phoneNumber (new object model)
          if ( "phoneNumber" in body ) {
            const updatedPhone = this.buildPhoneNumberFromBody(
              body as Record<string, unknown>
            );
            if ( updatedPhone ) {
              updates.phoneNumber = updatedPhone;
            }
          }

          // image (replace if uploaded)
          updates.image = imageUrl;

          if ( "role" in body ) {
            updates.role = String( body.role || "" ).trim();
          }

          if ( "isActive" in body ) {
            updates.isActive = this.toBool( body.isActive );
          }

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
          for ( const k of addrKeys ) {
            if ( k in body ) {
              addr[ k ] = String( body[ k ] ?? "" ).trim();
            }
          }
          if ( Object.keys( addr ).length > 0 ) {
            updates.address = { ...( userDoc.address || {} ), ...addr };
          }

          // Access: expect JSON or object
          if ( "access" in body ) {
            const access = this.parseJSON<IUser[ "access" ]>(
              body.access,
              userDoc.access
            );
            updates.access = access;
          }

          if ( "creator" in body ) {
            updates.creator = String( body.creator || "" ).trim();
          }

          if ( "updator" in body ) {
            updates.updator = String( body.updator || "" ).trim();
          }

          // Optional password change
          if ( "password" in body && typeof body.password === "string" ) {
            const pw = body.password.trim();
            if ( pw ) {
              updates.password = await this.hashPassword( pw );
            }
          }

          // Optional: email change triggers new verify token/expiry
          if ( "emailVerificationToken" in body ) {
            updates.emailVerificationToken = String(
              body.emailVerificationToken || ""
            ).trim();
          }
          if ( "emailVerificationTokenExpires" in body ) {
            const exp = this.toDate( body.emailVerificationTokenExpires );
            if ( exp ) updates.emailVerificationTokenExpires = exp;
          }

          const updatedUserDoc = await UserModel.findOneAndUpdate(
            { username },
            { $set: updates },
            { new: true, upsert: false }
          );

          if ( !updatedUserDoc ) {
            ApiResponseBuilder.notFound(
              res,
              "User not found or update failed"
            );
            return;
          }

          // Notify back-office (best-effort)
          const notificationService = new NotificationService();
          const io = req.app.get( "io" ) as import( "socket.io" ).Server;

          await notificationService.createNotification(
            {
              title: "Update User",
              body: `User ${ updatedUserDoc.name || updatedUserDoc.username } has been updated.`,
              type: "update",
              severity: "info",
              audience: {
                mode: "role",
                roles: [ "admin", "manager", "operator" ],
              },
              channels: [ "inapp", "email" ],
              metadata: {
                refId: updatedUserDoc.username,
                data: {
                  email: updatedUserDoc.email,
                  role: updatedUserDoc.role,
                  updatedAt: new Date(),
                  updatedBy:
                    ( typeof body.updator === "string"
                      ? body.updator.trim()
                      : undefined ) || "system",
                },
              },
            },
            ( rooms, payload ) =>
              rooms.forEach( ( room ) =>
                io.to( room ).emit( "notification.new", payload )
              )
          );

          const safeUser: User = updatedUserDoc.toSafeDTO();

          ApiResponseBuilder.ok(
            res,
            "user",
            safeUser,
            "User updated successfully"
          );
          return;
        } catch ( error: any ) {
          console.error( "[user-update] error:", error?.message || error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ==========================================================
  // Listing & search
  // ==========================================================

  private getAllUsers(): void {
    this.router.get(
      "/users",
      async ( _req: Request, res: Response ): Promise<void> => {
        try {
          const users = ( await UserModel.find( {}, USER_MODEL_PROJECTION )
            .sort( { createdAt: -1 } )
            .lean<User>()
            .exec() ) as unknown as User[];

          ApiResponseBuilder.ok(
            res,
            "users",
            users,
            "Users fetched successfully"
          );
          return;
        } catch ( error ) {
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private getAllUserCount(): void {
    this.router.get(
      "/users-count",
      async ( _req: Request, res: Response ): Promise<void> => {
        try {
          const total = await UserModel.countDocuments();

          ApiResponseBuilder.ok(
            res,
            "other",
            {},
            `Total number of users is ${ total }`,
            { pagination: { total } }
          );
          return;
        } catch ( error ) {
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private getAllUsersWithPagination(): void {
    this.router.get(
      "/users-with-pagination/:start/:limit",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const start = this.toNum( req.params.start, 0 );
          const limit = this.toNum( req.params.limit, 10 );
          const search = String( req.query.search || "" ).trim();

          const safeStart = Math.max( 0, start );
          const safeLimit = Math.max( 1, Math.min( limit, 100 ) );

          const filter: Record<string, unknown> = {};
          if ( search ) {
            const rx = new RegExp( this.escapeRegex( search ), "i" );
            filter.$or = [ { name: rx }, { username: rx }, { email: rx } ];
          }

          const [ users, total ] = ( await Promise.all( [
            UserModel.find( filter, USER_MODEL_PROJECTION )
              .sort( { createdAt: -1 } )
              .skip( safeStart )
              .limit( safeLimit )
              .lean<User>()
              .exec() as Promise<unknown>,
            UserModel.countDocuments( filter ),
          ] ) ) as [ User[], number ];

          const totalPages: number =
            total > 0 ? Math.ceil( total / safeLimit ) : 0;
          const currentPage =
            totalPages > 0 ? Math.floor( safeStart / safeLimit ) + 1 : 0;
          const index: number = currentPage > 0 ? currentPage - 1 : 0;
          const hasResults: boolean = total > 0;
          const end: number = Math.min( safeStart + safeLimit, total );

          const pagination: PaginationMeta = {
            index,
            limit: safeLimit,
            total,
            start: safeStart,
            end,
            hasNext: currentPage < totalPages,
            hasPrevious: currentPage > 1 && totalPages > 0,
            hasResults,
          };

          if ( search ) {
            pagination.search = search;
          }

          ApiResponseBuilder.ok(
            res,
            "users",
            users,
            "Users fetched successfully",
            { pagination }
          );
          return;
        } catch ( error ) {
          console.error( "[users-with-pagination] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private findUserByUsername(): void {
    this.router.get(
      "/user-username/:username",
      async (
        req: Request<{ username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const username = String( req.params.username || "" ).trim();
          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Username is required" );
            return;
          }

          const exists = await UserModel.exists( { username } );
          const user: User | null = await UserModel.findOne( { username } )
            .lean<User>()
            .exec();

          if ( !user ) {
            ApiResponseBuilder.notFound( res, "User not found" );
            return;
          }

          ApiResponseBuilder.ok(
            res,
            "user",
            user,
            "User found",
            { other: { exists: exists ? "true" : "false" } }
          );
          return;
        } catch ( error ) {
          console.error( "[user-username] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private findUserById(): void {
    this.router.get(
      "/user-id/:id",
      async (
        req: Request<{ id: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const id = String( req.params.id || "" ).trim();
          if ( !id ) {
            ApiResponseBuilder.validationError( res, "ID is required" );
            return;
          }

          const exists = await UserModel.exists( { _id: id } );
          const user: User | null = await UserModel.findOne( { _id: id } )
            .lean<User>()
            .exec();

          if ( !user ) {
            ApiResponseBuilder.notFound( res, "User not found" );
            return;
          }

          ApiResponseBuilder.ok(
            res,
            "user",
            user,
            "User found",
            { other: { exists: exists ? "true" : "false" } }
          );
          return;
        } catch ( error ) {
          console.error( "[user-id] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private findUserByEmail(): void {
    this.router.get(
      "/user-email/:email",
      async (
        req: Request<{ email: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const email = decodeURIComponent( req.params.email ?? "" ).trim();
          if ( !this.isEmail( email ) ) {
            ApiResponseBuilder.validationError( res, "Invalid email" );
            return;
          }

          const user = await UserModel.findOne( {
            email: {
              $regex: `^${ this.escapeRegex( email ) }$`,
              $options: "i",
            },
          }, USER_MODEL_PROJECTION )
            .lean<User>()
            .exec();

          if ( !user ) {
            ApiResponseBuilder.notFound( res, "User not found" );
            return;
          }

          ApiResponseBuilder.ok( res, "user", user, "User found", {
            other: { status: true },
          } );
          return;
        } catch ( error ) {
          console.error( "[user-email] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private findUserByPhone(): void {
    this.router.post(
      "/user-phone",
      async (
        req: Request,
        res: Response
      ): Promise<void> => {
        try {

          const phoneNumber: User[ 'phoneNumber' ] | null = req.body.phone;

          if ( !phoneNumber ) {
            ApiResponseBuilder.validationError( res, 'Phone number is required!' );
            return;
          }

          const fullNumber: string = phoneNumber.code.code + phoneNumber.number;


          // 1) Basic format validation (same as before, can be adjusted)
          const phoneRegex = /^(?:\+?[1-9]\d{1,3}|0)[\d\s\-()]{7,20}$/;
          if ( !phoneRegex.test( fullNumber ) ) {
            ApiResponseBuilder.validationError(
              res,
              "Invalid phone number format"
            );
            return;
          }

          // 2) Normalize input for matching
          const normalizedFull = this.normalizePhoneForSearch( fullNumber ); // e.g. "+94771234567" or "94771234567"
          if ( !normalizedFull ) {
            ApiResponseBuilder.validationError(
              res,
              "Invalid phone number after normalization"
            );
            return;
          }

          // Use last 6 digits as a safety fallback for suffix match
          const digitsOnly = normalizedFull.replace( /[^\d]/g, "" );
          const suffix = digitsOnly.length >= 6
            ? digitsOnly.slice( -6 )
            : digitsOnly;

          // Build regex patterns (case-insensitive)
          const fullRx = new RegExp( `^${ this.escapeRegex( normalizedFull ) }$`, "i" );
          const suffixRx = suffix
            ? new RegExp( `${ this.escapeRegex( suffix ) }$`, "i" )
            : null;

          // 3) Aggregation pipeline to support:
          //    - New schema: phoneNumber: { code: { code }, number }
          //    - Legacy schema: phoneNumber: string
          const pipeline: any[] = [
            {
              $addFields: {
                phoneNewRaw: {
                  $concat: [
                    { $ifNull: [ "$phoneNumber.code.code", "" ] },
                    { $ifNull: [ "$phoneNumber.number", "" ] },
                  ],
                },
                phoneLegacyRaw: {
                  $cond: [
                    { $eq: [ { $type: "$phoneNumber" }, "string" ] },
                    "$phoneNumber",
                    "",
                  ],
                },
              },
            },
            {
              $addFields: {
                phoneNewNorm: {
                  $replaceAll: {
                    input: {
                      $replaceAll: {
                        input: {
                          $replaceAll: {
                            input: {
                              $replaceAll: {
                                input: "$phoneNewRaw",
                                find: " ",
                                replacement: "",
                              },
                            },
                            find: "-",
                            replacement: "",
                          },
                        },
                        find: "(",
                        replacement: "",
                      },
                    },
                    find: ")",
                    replacement: "",
                  },
                },
                phoneLegacyNorm: {
                  $replaceAll: {
                    input: {
                      $replaceAll: {
                        input: {
                          $replaceAll: {
                            input: {
                              $replaceAll: {
                                input: "$phoneLegacyRaw",
                                find: " ",
                                replacement: "",
                              },
                            },
                            find: "-",
                            replacement: "",
                          },
                        },
                        find: "(",
                        replacement: "",
                      },
                    },
                    find: ")",
                    replacement: "",
                  },
                },
              },
            },
            {
              // Match exact normalized number OR (fallback) suffix match
              $match: {
                $or: [
                  { phoneNewNorm: { $regex: fullRx } },
                  { phoneLegacyNorm: { $regex: fullRx } },
                  ...( suffixRx
                    ? [
                      { phoneNewNorm: { $regex: suffixRx } },
                      { phoneLegacyNorm: { $regex: suffixRx } },
                    ]
                    : [] ),
                ],
              },
            },
            {
              // Exclude password hash and internal fields
              $project: {
                password: 0,
              },
            },
            { $limit: 1 },
            {
              $project: USER_MODEL_PROJECTION,
            },
          ];

          const users = await UserModel.aggregate<User>( pipeline ).exec();
          const user = users[ 0 ];

          if ( !user ) {
            ApiResponseBuilder.notFound( res, "User not found" );
            return;
          }

          ApiResponseBuilder.ok( res, "user", user, "User found", {
            other: { status: "true" },
          } );
          return;
        } catch ( error ) {
          console.error( "[user-phone] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ==========================================================
  // Email verification flow
  // ==========================================================

  private verifyNewUserEmail(): void {
    // NOTE: route spelling kept to match your original path `/emailverifycation/...`
    this.router.get(
      "/emailverifycation/:token",
      async (
        req: Request<{ token: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const token = req.params.token;
          const user: IUser | null = await UserModel.findOne( {
            emailVerificationToken: token,
            emailVerificationTokenExpires: { $gt: new Date() },
          }, USER_MODEL_PROJECTION ).exec();

          if ( !user ) {
            res
              .status( 400 )
              .sendFile(
                path.join( __dirname, "../../public/error/emailExpire.html" ),
                ( error ) => error && console.error( error )
              );
            return;
          }

          user.emailVerified = true;
          delete user.emailVerificationToken;
          delete user.emailVerificationTokenExpires;
          user.autoDelete = false;
          await user.save();

          res.redirect( ENV.cors.FRONTEND_ORIGIN || "http://localhost:4200" );
          return;
        } catch ( error ) {
          console.error( "[emailverifycation] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private async sendVerificationEmail(
    userEmail: string,
    token: string
  ): Promise<boolean> {
    const verifyLink = `http://localhost:3000/api-user/emailverifycation/${ token }`;
    const html = `
      <div style="max-width:600px;margin:auto;border:1px solid #e0e0e0;border-radius:8px;padding:20px;font-family:Arial,sans-serif">
        <h2 style="text-align:center;color:#007bff">Verify Your Email Address</h2>
        <p>Hi there,</p>
        <p>Thanks for registering. Click below to verify your email:</p>
        <div style="text-align:center;margin:30px 0">
          <a href="${ verifyLink }" style="background:#007bff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:5px">Verify Email</a>
        </div>
        <p>If the button doesn't work, copy this link:</p>
        <p style="word-break:break-word">${ verifyLink }</p>
      </div>
    `;

    const transporter = nodemailer.createTransport( {
      service: "gmail",
      auth: {
        user: ENV.smtp.SMTP_USER,
        pass: ENV.smtp.SMTP_PASS,
      },
    } );

    const sent = await transporter.sendMail( {
      from: '"PropEase Real Estate" <no-reply@propease.com>',
      to: userEmail,
      subject: "Verify Your Email",
      html,
    } );

    return !!sent;
  }

  // ==========================================================
  // One-time view token endpoints (utility)
  // ==========================================================

  private generateToken(): void {
    this.router.post(
      "/generate-token",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const username = String( req.body.username || "" ).trim();
          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Invalid username" );
            return;
          }

          const token = crypto.randomBytes( 32 ).toString( "hex" );
          const expiresAt = new Date( Date.now() + 30 * 60 * 1000 ); // 30 minutes

          const saved = await TokenMap.create( {
            token,
            username,
            type: "view",
            expiresAt,
          } );
          if ( !saved ) {
            throw new Error( "Failed to persist token" );
          }

          ApiResponseBuilder.ok(
            res,
            "other",
            { token: saved.token },
            "Token generated successfully"
          );
          return;
        } catch ( error ) {
          console.error( "[generate-token] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private getUserByToken(): void {
    this.router.get(
      "/user-token/:token",
      async (
        req: Request<{ token: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const token = String( req.params.token || "" );
          if ( !token ) {
            ApiResponseBuilder.validationError( res, "Token is required" );
            return;
          }

          const record = await TokenMap.findOne( { token } );
          if ( !record || record.expiresAt <= new Date() ) {
            ApiResponseBuilder.notFound( res, "Token not found or expired" );
            return;
          }

          const userDoc: IUser | null = await UserModel.findOne( {
            username: record.username,
          }, USER_MODEL_PROJECTION ).exec();

          if ( !userDoc ) {
            ApiResponseBuilder.notFound( res, "User not found" );
            return;
          }

          const safeUser: User = userDoc.toSafeDTO();

          ApiResponseBuilder.ok( res, "user", safeUser, "User found" );
          return;
        } catch ( error ) {
          console.error( "[user-token] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ==========================================================
  // User document upload & retrieval
  // ==========================================================

  private uploadDocument(): void {
    const allowedTypes = new Set<string>( [
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
    ] );

    const upload = FileUploader.createDiskUpload( {
      allowedMimeTypes: allowedTypes,
      maxFileSizeMb: 20,
      maxFiles: 10,
      resolveDestination: async ( req: Request ): Promise<string> => {
        const username = String( req.params.username || "" ).trim();
        if ( !username || !this.isSafeSegment( username ) ) {
          throw new Error( "Username is required or invalid" );
        }
        const uploadPath = path.join( this.DEFAULT_PATH, username, "documents" );
        await fse.ensureDir( uploadPath );
        return uploadPath;
      },
    } );

    this.router.post(
      "/user-document-upload/:username",
      upload.array( "files", 10 ),
      async (
        req: Request<{ username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const files = req.files as Express.Multer.File[] | undefined;
          if ( !files?.length ) {
            ApiResponseBuilder.validationError( res, "No files uploaded" );
            return;
          }

          const username = String( req.params.username || "" ).trim();
          if ( !username || !this.isSafeSegment( username ) ) {
            ApiResponseBuilder.validationError( res, "Invalid username format" );
            return;
          }

          if ( !( await UserModel.exists( { username } ) ) ) {
            await Promise.all(
              files.map( ( f ) => fse.remove( f.path ).catch( () => {} ) )
            );
            ApiResponseBuilder.notFound( res, "User not found" );
            return;
          }

          const baseUrl = `${ req.protocol }://${ req.get( "host" ) }`;
          const uploader = String( req.body?.uploader || "system" ).trim();

          const savedFiles = files.map( ( file ) => ( {
            originalName: file.originalname,
            storedName: file.filename,
            mimeType: file.mimetype,
            size: file.size,
            path: file.path,
            extension: path.extname( file.originalname ),
            download: `${ username }/documents/${ file.filename }`,
            URL: `${ baseUrl }/${ this.DEFAULT_URL }/${ encodeURIComponent(
              username
            ) }/documents/${ encodeURIComponent( file.filename ) }`,
            uploader,
            uploadDate: new Date(),
          } ) );

          const doc = await UserDocumentModel.findOneAndUpdate(
            { username },
            { $push: { files: { $each: savedFiles } } },
            { upsert: true, new: true }
          );

          if ( !doc ) {
            ApiResponseBuilder.fail( res, "Failed to save files" );
            return;
          }

          const data = {
            fileCount: files.length,
            uploadedFiles: savedFiles.map( ( f ) => ( {
              originalName: f.originalName,
              storedName: f.storedName,
              mimeType: f.mimeType,
              size: f.size,
              extension: f.extension,
              URL: f.URL,
              uploader: f.uploader,
              uploadedAt: f.uploadDate,
            } ) ),
          };

          ApiResponseBuilder.ok(
            res,
            "other",
            data,
            "Files uploaded successfully"
          );
          return;
        } catch ( error: any ) {
          console.error(
            "[user-document-upload] error:",
            error?.message || error
          );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private getUserDocuments(): void {
    this.router.get(
      "/uploads/:username/documents",
      async (
        req: Request<{ username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const username = String( req.params.username || "" ).trim();
          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Username is required" );
            return;
          }

          const files = await UserDocumentModel.findOne( { username } )
            .sort( { updatedAt: -1 } )
            .lean<UserDocumentEntity>()
            .exec();

          if ( !files ) {
            ApiResponseBuilder.notFound(
              res,
              "File documents not found under username"
            );
            return;
          }

          ApiResponseBuilder.ok(
            res,
            "fileUpload",
            files,
            "Files retrieved successfully"
          );
          return;
        } catch ( error ) {
          console.error( "[getUserDocuments] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ==========================================================
  // Single user read
  // ==========================================================



  private getUserDataById(): void {
    this.router.get(
      "/user-data/:id",
      async (
        req: Request<{ id: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const id = String( req.params.id || "" ).trim();
          if ( !id ) {
            ApiResponseBuilder.validationError( res, "ID is required" );
            return;
          }

          const user = await UserModel.findOne( { _id: id }, USER_MODEL_PROJECTION )
            .lean<User>()
            .exec();

          if ( !user ) {
            ApiResponseBuilder.notFound(
              res,
              "User not found under the given username"
            );
            return;
          }

          ApiResponseBuilder.ok( res, "user", user, "User found under username" );
          return;
        } catch ( error ) {
          console.error( "[user-data] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );

  }

  private getUserDataByUsername(): void {
    this.router.get(
      "/user-data/:username",
      async (
        req: Request<{ username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const username = String( req.params.username || "" ).trim();
          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Username is required" );
            return;
          }

          const user = await UserModel.findOne( { username }, USER_MODEL_PROJECTION )
            .lean<User>()
            .exec();

          if ( !user ) {
            ApiResponseBuilder.notFound(
              res,
              "User not found under the given username"
            );
            return;
          }

          ApiResponseBuilder.ok( res, "user", user, "User found under username" );
          return;
        } catch ( error ) {
          console.error( "[user-data] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ==========================================================
  // Delete user (move media to recyclebin, clear relations)
  // ==========================================================

  private deleteUserByUsername(): void {
    this.router.delete(
      "/user-delete/:username/:deletedBy",
      async (
        req: Request<{ username: string; deletedBy: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const username = String(
            req.params.username ||
            req.body?.username ||
            req.query?.username ||
            ""
          ).trim();
          const deletedBy = String(
            req.params.deletedBy ||
            req.body?.deletedBy ||
            req.query?.deletedBy ||
            ""
          ).trim();

          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Username is required" );
            return;
          }

          if ( !deletedBy ) {
            ApiResponseBuilder.validationError(
              res,
              "Deletor's identity is required"
            );
            return;
          }

          if ( !this.isSafeSegment( username ) ) {
            ApiResponseBuilder.validationError( res, "Invalid username" );
            return;
          }

          const baseUrl = `${ req.protocol }://${ req.get( "host" ) }`;

          const userDoc = await UserModel.findOne( { username }, USER_MODEL_PROJECTION ).lean();
          const recycleUserDir = path.join( this.RECYCLE_PATH, username );
          const userImagePath = path.join(
            this.DEFAULT_PATH,
            username,
            "image.webp"
          );
          const snapshot = userDoc;
          const userDocsPath = path.join(
            this.DEFAULT_PATH,
            username,
            "documents"
          );
          const deletedCopyDir = path.join(
            this.DEFAULT_PATH,
            "deleted",
            username
          );
          const deletedCopyImage = path.join( deletedCopyDir, "image.webp" );
          const deletedImageURL = `${ baseUrl }/${ this.DEFAULT_URL }/deleted/${ encodeURIComponent(
            username
          ) }/image.webp`;

          await fse.ensureDir( recycleUserDir );

          // Save snapshot to recyclebin
          if ( userDoc ) {
            await fse.writeJson(
              path.join( recycleUserDir, "data.json" ),
              userDoc,
              { spaces: 2 }
            );
          }

          // Keep a "deleted preview" copy under /uploads/users/deleted/<username>/
          if ( await fse.pathExists( userImagePath ) ) {
            await fse.ensureDir( deletedCopyDir );
            await fse.copy( userImagePath, deletedCopyImage, {
              overwrite: true,
            } );
          }

          // Move image to recyclebin
          if ( await fse.pathExists( userImagePath ) ) {
            await fse.copy(
              userImagePath,
              path.join( recycleUserDir, "image.webp" ),
              { overwrite: true }
            );
            await fse.remove( userImagePath );
          }

          // Move documents to recyclebin
          if ( await fse.pathExists( userDocsPath ) ) {
            await fse.copy(
              userDocsPath,
              path.join( recycleUserDir, "documents" ),
              { overwrite: true }
            );
            await fse.remove( userDocsPath );
          }

          // Clean example relations (optional; adjust for your app)
          await PropertyModel.updateMany(
            { owner: username },
            { $unset: { owner: 1 } }
          );
          await PropertyModel.updateMany(
            { "addedBy.username": username },
            { $unset: { addedBy: {} as any } }
          );

          // Notify back-office
          if ( userDoc ) {
            const notificationService = new NotificationService();
            const io = req.app.get( "io" ) as import( "socket.io" ).Server;

            await notificationService.createNotification(
              {
                title: "Delete User",
                body: `User ${ userDoc.name ?? username } has been deleted.`,
                type: "delete",
                severity: "warning",
                audience: {
                  mode: "role",
                  roles: [ "admin", "manager", "operator" ],
                },
                channels: [ "inapp", "email" ],
                metadata: {
                  refId: username,
                  data: {
                    snapshot,
                    image: deletedImageURL,
                    userId: String( userDoc._id ?? "" ),
                    deletedBy,
                    deletedAt: new Date().toISOString(),
                    recyclebinUrl: `${ this.RECYCLE_URL }/${ encodeURIComponent(
                      username
                    ) }/`,
                  },
                },
              },
              ( rooms, payload ) =>
                rooms.forEach( ( room ) =>
                  io.to( room ).emit( "notification.new", payload )
                )
            );
          }

          // Remove from DB last
          const deleted = await UserModel.findOneAndDelete( { username } ).lean();

          if ( !deleted ) {
            ApiResponseBuilder.notFound( res, "User not found to delete" );
            return;
          }

          ApiResponseBuilder.noContent( res, "User deleted successfully" );
          return;
        } catch ( error: any ) {
          console.error( "[user-delete] error:", error?.message || error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ==========================================================
  // Get user section by key
  // ==========================================================

  private getUserSectionByKey(): void {
    this.router.get(
      "/user-section-key/:username/:key",
      async (
        req: Request<{ username: string; key: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const username = String( req.params.username || "" ).trim();
          const key = String( req.params.key || "" ).trim();

          if ( !username || !key ) {
            ApiResponseBuilder.validationError(
              res,
              "Username and key are required"
            );
            return;
          }

          const NOT_ALLOWED_KEYS = new Set<string>( [
            "_id",
            "createdAt",
            "updatedAt",
            "username",
            "password",
            "access",
            "isActive",
            "emailVerified",
            "emailVerificationToken",
            "emailVerificationTokenExpires",
            "otpVerifycation",
            "otpTokenExpires",
            "otpToken",
          ] );

          if ( NOT_ALLOWED_KEYS.has( key ) ) {
            ApiResponseBuilder.validationError(
              res,
              "Access to the requested key is not allowed"
            );
            return;
          }



          const section = await UserModel.findOne( { username }, USER_MODEL_PROJECTION )
            .lean()
            .exec();

          if ( !section ) {
            ApiResponseBuilder.notFound(
              res,
              "Failed to fetch the requested section"
            );
            return;
          }

          ApiResponseBuilder.ok(
            res,
            "other",
            { section },
            "User section retrieved"
          );
          return;
        } catch ( error ) {
          console.error( "[user-section-key] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }
}
