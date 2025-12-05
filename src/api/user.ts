// ==========================================================
// File: src/api/user.ts
// Description: User routes (create, verify, update, search,
//              upload docs, token utilities, and deletion).
// Notes:
//  - Class-based router (no global functions).
//  - Validations aligned with src/models/user.model.ts.
//  - Safer file handling & structured error responses.
// ==========================================================

import * as Argon2 from "argon2";
import crypto from "crypto";
import dotenv from "dotenv";
import express, { Request, Response, Router } from "express";
import fse from "fs-extra";
import jwt from "jsonwebtoken";
import multer from "multer";
import nodemailer from "nodemailer";
import path from "path";
import sharp from "sharp";
import twilio, { Twilio } from "twilio";

import { Config } from "../configs/config";
import { UserDocumentModel, type UserDocumentEntity } from "../models/file-upload.model";
import { PropertyModel } from "../models/property.model";
import { TokenMap } from "../models/token.model";
import { IUser, UserModel } from "../models/user.model";
import NotificationService from "../services/notification.service";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";
import type { PaginationMeta } from "../types/api-message";
import { Role } from "../types/roles";
import { GuardTokenService } from '../services/guard-token.service';

dotenv.config();

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
    // Auth
    this.getUserData(); // login verification

    // CRUD: user
    this.createUser();
    this.updateUser();
    this.deleteUserByUsername();
    this.getUserDataByUsername();
    this.getUserSectionByKey();

    // Listing / search
    this.getAllUsers();
    this.getAllUserCount();
    this.getAllUsersWithPagination();
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

  /** Parse JSON safely with fallback. */
  private parseJSON<T = unknown>( value: unknown, fallback: T ): T {
    try {
      if ( typeof value !== "string" ) return fallback;
      return JSON.parse( value ) as T;
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

  // ==========================================================
  // Auth: Login / verify user (JWT)
  // ==========================================================

  // Inside UserRoute class
  private getUserData(): void {
    this.router.post(
      '/verify-user',
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const username: string = String( req.body.username || '' ).trim();
          const password: string = String( req.body.password || '' );

          // 1) Basic input validation
          if ( !username || !password ) {
            ApiResponseBuilder.validationError(
              res,
              'Username and password are required'
            );
            return;
          }

          // 2) Load user
          const user: IUser | null = await UserModel.findOne( { username } ).exec();

          if ( !user ) {
            ApiResponseBuilder.validationError( res, 'Invalid username' );
            return;
          }

          // 3) Verify password (argon2)
          const isPasswordValid: boolean = await Argon2.verify(
            ( user as any ).password, // adjust if your field is passwordHash
            password
          );

          if ( !isPasswordValid ) {
            ApiResponseBuilder.validationError( res, 'Invalid password' );
            return;
          }

          // 4) If multi-auth is enabled, stop here and ask frontend to perform MFA.
          //    We DO NOT issue session/guard tokens yet.
          if ( user.multiAuthEnabled ) {
            const plain = user.toObject ? user.toObject() : ( user as any );
            const { password: _omit, ...userWithoutPassword } = plain;

            ApiResponseBuilder.ok(
              res,
              'user',
              userWithoutPassword,
              'User verified, multi-authentication required',
              {
                other: {
                  mfaRequired: true,
                  multiAuthEnabled: true,
                  username: user.username
                }
              }
            );
            return;
          }

          // 5) Multi-auth NOT enabled → get or create main session+guard token
          const tokens = await this.guardTokenService.getOrIssueForUser( user );

          // 6) Issue a JWT as well (frontend can use this for UI, but backend guard
          //    is driven by sessionToken + guardToken)
          const payload = {
            sub: String( user._id ),
            username: user.username,
            role: user.role as Role,
          };

          const jwtToken: string = jwt.sign(
            payload,
            process.env.JWT_SECRET || 'defaultsecret',
            { expiresIn: '30d' }
          );

          // 7) Set cookies for main tokens (defence in depth)
          res.cookie( 'sessionToken', tokens.sessionToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
          } );

          res.cookie( 'guardToken', tokens.guardToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
            maxAge: 30 * 24 * 60 * 60 * 1000
          } );

          // 8) Sanitise user object (never send password to client)
          const plain = user.toObject ? user.toObject() : ( user as any );
          const { password: _omit, ...userWithoutPassword } = plain;

          // 9) Final response:
          //    - system.user = safe user data
          //    - other = tokens and flags for frontend
          ApiResponseBuilder.ok(
            res,
            'user',
            userWithoutPassword,
            'User verified successfully',
            {
              other: {
                jwtToken,                  // optional JWT for FE
                sessionToken: tokens.sessionToken, // main 30-day token
                guardToken: tokens.guardToken,     // rotating guard token
                multiAuthEnabled: false,  // explicit flag for UI
              }
            }
          );
          return;
        } catch ( error ) {
          console.error( '[verify-user] error:', error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }


  // ==========================================================
  // Create user (image upload → webp, email verify, OTP fields)
  // ==========================================================

  private createUser(): void {
    const storage = multer.memoryStorage();

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

    const upload = multer( {
      storage,
      limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
      fileFilter: ( _req, file, cb ) => {
        if ( allowedTypes.has( file.mimetype ) ) cb( null, true );
        else cb( new Error( "Only image files are allowed" ) );
      },
    } );

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

          // Required numerics / dates
          const age = this.toNum( req.body.age, NaN );
          const dateOfBirth = this.toDate( req.body.dateOfBirth );
          const multiAuthEnabled: boolean = req.body.multiAuthEnabled.trim().toLowerCase() === 'true' ? true : false;

          // Optional
          const phoneNumber = String( req.body.phoneNumber || "" ).trim();
          const gender = String( req.body.gender || "" ).trim();
          const bio = String( req.body.bio || "" ).trim();

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
            ApiResponseBuilder.validationError( res, "Valid dateOfBirth is required" );
            return;
          }
          if ( !Number.isFinite( age ) ) {
            ApiResponseBuilder.validationError( res, "Valid age is required" );
            return;
          }
          if ( !image ) {
            ApiResponseBuilder.validationError( res, "Profile image is required" );
            return;
          }

          // Ensure unique username before disk writes
          if ( await UserModel.exists( { username } ) ) {
            ApiResponseBuilder.validationError( res, "Username already exists" );
            return;
          }

          // Compute where to write the final image
          const imagePath = path.join( this.DEFAULT_PATH, username, "image.webp" );
          await fse.ensureDir( path.dirname( imagePath ) );
          await sharp( image.buffer ).webp( { quality: 80 } ).toFile( imagePath );

          const baseUrl = `${ req.protocol }://${ req.get( "host" ) }`;
          const publicImageUrl = `${ baseUrl }/${ this.DEFAULT_URL }/${ encodeURIComponent(
            username
          ) }/image.webp`;

          // Access information
          const access = this.parseJSON( req.body.access, undefined ) as
            | IUser[ "access" ]
            | undefined;

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

          const newUser = new UserModel( {
            name,
            username,
            email,
            password,
            dateOfBirth,
            age,
            gender,
            bio,
            phoneNumber,
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
          } );

          await newUser.save();

          // Broadcast to back-office roles (best-effort)
          const notificationService = new NotificationService();
          const io = req.app.get( "io" ) as import( "socket.io" ).Server;

          await notificationService.createNotification(
            {
              title: "New User",
              body: `User ${ newUser.name || newUser.username } has registered.`,
              type: "create",
              severity: "info",
              audience: { mode: "role", roles: [ "admin", "manager", "operator" ] },
              channels: [ "inapp", "email" ],
              metadata: {
                refId: newUser.username,
                data: {
                  email: newUser.email,
                  role: newUser.role,
                  createdAt: newUser.createdAt,
                  creator: newUser.creator,
                },
              },
            },
            ( rooms, payload ) =>
              rooms.forEach( ( room ) =>
                io.to( room ).emit( "notification.new", payload )
              )
          );

          ApiResponseBuilder.ok(
            res,
            "user",
            newUser,
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
    const storage = multer.memoryStorage();
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

    const upload = multer( {
      storage,
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: ( _req, file, cb ) => {
        if ( allowedTypes.has( file.mimetype ) ) cb( null, true );
        else cb( new Error( "Only image files are allowed" ) );
      },
    } );

    this.router.put(
      "/user-update/:username",
      upload.fields( [ { name: "userimage", maxCount: 1 } ] ),
      async ( req: Request<{ username: string; }>, res: Response ): Promise<void> => {
        try {
          const username = String( req.params.username || "" ).trim();
          if ( !username || !this.isSafeSegment( username ) ) {
            ApiResponseBuilder.validationError( res, "Invalid username" );
            return;
          }

          const user = await UserModel.findOne( { username } );
          if ( !user ) {
            ApiResponseBuilder.notFound( res, "User not found" );
            return;
          }

          const files = req.files as Record<
            string,
            Express.Multer.File[] | undefined
          >;
          const image = files?.userimage?.[ 0 ];

          const baseUrl = `${ req.protocol }://${ req.get( "host" ) }`;
          let imageUrl = user.image;

          // If there is a new image -> convert to webp and replace
          if ( image ) {
            const imagePath = path.join( this.DEFAULT_PATH, username, "image.webp" );
            await fse.ensureDir( path.dirname( imagePath ) );
            await fse.remove( imagePath ).catch( () => {} );
            await sharp( image.buffer ).webp( { quality: 80 } ).toFile( imagePath );
            imageUrl = `${ baseUrl }/${ this.DEFAULT_URL }/${ encodeURIComponent(
              username
            ) }/image.webp`;
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
            if ( !Number.isFinite( n ) || !Number.isInteger( n ) || Number.isNaN( n ) ) {
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

          if ( "phoneNumber" in body ) {
            updates.phoneNumber = String( body.phoneNumber || "" ).trim();
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
            updates.address = { ...( user.address || {} ), ...addr };
          }

          // Access: expect JSON or object
          if ( "access" in body ) {
            const access = this.parseJSON<IUser[ "access" ]>(
              body.access,
              user.access
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

          const updatedUser = await UserModel.findOneAndUpdate(
            { username },
            { $set: updates },
            { new: true, upsert: false }
          );

          if ( !updatedUser ) {
            ApiResponseBuilder.notFound( res, "User not found or update failed" );
            return;
          }

          // Notify back-office (best-effort)
          const notificationService = new NotificationService();
          const io = req.app.get( "io" ) as import( "socket.io" ).Server;

          await notificationService.createNotification(
            {
              title: "Update User",
              body: `User ${ updatedUser.name || updatedUser.username } has been updated.`,
              type: "update",
              severity: "info",
              audience: { mode: "role", roles: [ "admin", "manager", "operator" ] },
              channels: [ "inapp", "email" ],
              metadata: {
                refId: updatedUser.username,
                data: {
                  email: updatedUser.email,
                  role: updatedUser.role,
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

          ApiResponseBuilder.ok(
            res,
            "user",
            updatedUser,
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
          const users = ( await UserModel.find(
            {},
            { password: 0 }
          )
            .sort( { createdAt: -1 } )
            .lean<IUser>()
            .exec() ) as unknown as IUser[];

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

          const [ users, total ] = await Promise.all( [
            UserModel.find( filter, { password: 0 } )
              .sort( { createdAt: -1 } )
              .skip( safeStart )
              .limit( safeLimit )
              .lean<IUser>()
              .exec() as Promise<unknown>,
            UserModel.countDocuments( filter ),
          ] ) as [ IUser[], number ];

          const totalPages: number = total > 0 ? Math.ceil( total / safeLimit ) : 0;
          const currentPage = totalPages > 0 ? Math.floor( safeStart / safeLimit ) + 1 : 0;
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
      async ( req: Request<{ username: string; }>, res: Response ): Promise<void> => {
        try {
          const username = String( req.params.username || "" ).trim();
          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Username is required" );
            return;
          }

          const exists = await UserModel.exists( { username } );
          const user: IUser | null = await UserModel.findOne( { username } )
            .lean<IUser>()
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

  private findUserByEmail(): void {
    this.router.get(
      "/user-email/:email",
      async ( req: Request<{ email: string; }>, res: Response ): Promise<void> => {
        try {
          const email = decodeURIComponent( req.params.email ?? "" ).trim();
          if ( !this.isEmail( email ) ) {
            ApiResponseBuilder.validationError( res, "Invalid email" );
            return;
          }

          const user = await UserModel.findOne( {
            email: { $regex: `^${ this.escapeRegex( email ) }$`, $options: "i" },
          } )
            .lean<IUser>()
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
            { other: { status: true } }
          );
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
    this.router.get(
      "/user-phone/:phone",
      async ( req: Request<{ phone: string; }>, res: Response ): Promise<void> => {
        try {
          const phoneNumber = String( req.params.phone || "" ).trim();
          const phoneRegex = /^(?:\+?[1-9]\d{1,3}|0)[\d\s\-()]{7,20}$/;

          if ( !phoneRegex.test( phoneNumber ) ) {
            ApiResponseBuilder.validationError(
              res,
              "Invalid phone number format"
            );
            return;
          }

          const user = await UserModel.findOne( {
            phoneNumber: {
              $regex: `^${ this.escapeRegex( phoneNumber ) }$`,
              $options: "i",
            },
          } )
            .lean<IUser>()
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
            { other: { status: "true" } }
          );
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
      async ( req: Request<{ token: string; }>, res: Response ): Promise<void> => {
        try {
          const token = req.params.token;
          const user = await UserModel.findOne( {
            emailVerificationToken: token,
            emailVerificationTokenExpires: { $gt: new Date() },
          } );

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
          delete ( user as any ).emailVerificationToken;
          delete ( user as any ).emailVerificationTokenExpires;
          user.autoDelete = false;
          await user.save();

          res.redirect( process.env.FRONTEND_ORIGIN || "http://localhost:4200" );
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
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
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
      async ( req: Request<{ token: string; }>, res: Response ): Promise<void> => {
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

          const user = await UserModel.findOne( { username: record.username } );
          if ( !user ) {
            ApiResponseBuilder.notFound( res, "User not found" );
            return;
          }

          ApiResponseBuilder.ok( res, "user", user, "User found" );
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

    const storage = multer.diskStorage( {
      destination: async ( req, _file, cb ) => {
        try {
          const username = String( req.params.username || "" ).trim();
          if ( !username || !this.isSafeSegment( username ) ) {
            cb( new Error( "Username is required or invalid" ), "" );
            return;
          }
          const uploadPath = path.join( this.DEFAULT_PATH, username, "documents" );
          await fse.ensureDir( uploadPath );
          cb( null, uploadPath );
        } catch ( error: any ) {
          cb( error instanceof Error ? error : new Error( String( error ) ), "" );
        }
      },
      filename: ( _req, file, cb ) => {
        const original = path.basename( file.originalname ).replace( /\s+/g, "_" );
        const unique = `${ Date.now() }-${ Math.round( Math.random() * 1e9 ) }`;
        cb( null, `${ unique }-${ original }` );
      },
    } );

    const upload = multer( {
      storage,
      limits: { fileSize: 20 * 1024 * 1024, files: 10 },
      fileFilter: ( _req, file, cb ) => {
        if ( allowedTypes.has( file.mimetype ) ) cb( null, true );
        else cb( new Error( `File type not allowed: ${ file.mimetype }` ) );
      },
    } );

    this.router.post(
      "/user-document-upload/:username",
      upload.array( "files", 10 ),
      async ( req: Request<{ username: string; }>, res: Response ): Promise<void> => {
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
            ApiResponseBuilder.fail(
              res,
              "Failed to save files"
            );
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
          console.error( "[user-document-upload] error:", error?.message || error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  private getUserDocuments(): void {
    this.router.get(
      "/uploads/:username/documents",
      async ( req: Request<{ username: string; }>, res: Response ): Promise<void> => {
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

  private getUserDataByUsername(): void {
    this.router.get(
      "/user-data/:username",
      async ( req: Request<{ username: string; }>, res: Response ): Promise<void> => {
        try {
          const username = String( req.params.username || "" ).trim();
          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Username is required" );
            return;
          }

          const user = await UserModel.findOne(
            { username },
            { password: 0 }
          )
            .lean<IUser>()
            .exec();

          if ( !user ) {
            ApiResponseBuilder.notFound(
              res,
              "User not found under the given username"
            );
            return;
          }

          ApiResponseBuilder.ok(
            res,
            "user",
            user,
            "User found under username"
          );
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

          const userDoc = await UserModel.findOne( { username } ).lean();
          const recycleUserDir = path.join( this.RECYCLE_PATH, username );
          const userImagePath = path.join(
            this.DEFAULT_PATH,
            username,
            "image.webp"
          );
          const snapshot = userDoc;
          const userDocsPath = path.join( this.DEFAULT_PATH, username, "documents" );
          const deletedCopyDir = path.join( this.DEFAULT_PATH, "deleted", username );
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
            await fse.copy( userImagePath, deletedCopyImage, { overwrite: true } );
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
                audience: { mode: "role", roles: [ "admin", "manager", "operator" ] },
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
            ApiResponseBuilder.notFound(
              res,
              "User not found to delete"
            );
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
      async ( req: Request<{ username: string; key: string; }>, res: Response ): Promise<void> => {
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

          const projection: Record<string, 0 | 1> = {
            [ key ]: 1,
            _id: 0,
          };

          const section = await UserModel.findOne( { username }, projection )
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
