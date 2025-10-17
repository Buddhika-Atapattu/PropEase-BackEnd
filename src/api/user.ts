import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import * as path from "path";
import fse from 'fs-extra';
import {UserModel, IUser} from "../models/user.model";
import * as Argon2 from "argon2";
import multer from "multer";
import sharp from "sharp";
import os from "os";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import twilio, {Twilio} from 'twilio';
import {TokenMap} from "../models/token.model";
import crypto from "crypto";
import {UserDocument} from "../models/file-upload.model";
import {
  PropertyModel,
  IProperty,
  Address,
  CountryDetails,
  AddedBy,
  GoogleMapLocation,
} from "../models/property.model";
import {MSG} from "../controller/commonTypeSetting";
import NotificationService from '../services/notification.service';
import jwt from 'jsonwebtoken';
import {Role} from '../types/roles';
import {Config} from '../configs/config';

dotenv.config();

export default class UserRoute {


  private readonly DEFAULT_PATH = path.join(__dirname, '../../public/uploads/users/');
  private readonly RECYCLE_PATH = path.join(__dirname, '../../public/recyclebin/users/');
  private readonly DEFAULT_URL = 'uploads/users';
  private readonly RECYCLE_URL = 'recyclebin/users';

  private router: express.Router;
  private readonly twilioClient: Twilio = twilio(Config.twilio.sid, Config.twilio.token);
  constructor () {
    this.router = express.Router();
    this.createUser();
    this.getAllUsers();
    this.getUserData();
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

  //<=========== HASH THE PASSWORD WITH ARGON2 ============>

  public async hashPassword(password: string): Promise<string> {
    return await Argon2.hash(password);
  }

  //<=========== HELPER ============>
  private isSafeSegment(seg: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(seg);
  }

  private parseJSON<T = any>(value: unknown, fallback: T): T {
    try {
      if(typeof value !== 'string') return fallback;
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  //<=========== END HELPER ============>


  //<====== VERIFY THE LOGIN USER ============>



  private getUserData() {
    this.router.post(
      "/verify-user",
      async (req: Request, res: Response, next: NextFunction): Promise<any> => {
        try {
          const {username, password} = req.body as {username: string; password: string};

          const user: IUser | null = await UserModel.findOne({username});
          if(!user) {
            return res.status(401).json({status: 'error', message: "Invalid username"});
          }

          const isPasswordValid = await Argon2.verify(user.password, password);
          if(!isPasswordValid) {
            return res.status(401).json({status: 'error', message: "Invalid password"});
          }

          // Build JWT claims your socket/auth middleware need
          const payload = {
            sub: String(user._id),
            username: user.username,
            role: user.role as Role,
          };

          const token = jwt.sign(
            payload,
            process.env.JWT_SECRET || 'defaultsecret',
            {expiresIn: '30d'}
          );

          // sanitize password out of the response
          const plainUser = user.toObject ? user.toObject() : (user as any);
          const {password: _omit, ...userWithoutPassword} = plainUser;

          // unified response shape
          return res.status(200).json({
            status: 'success',
            message: 'User verified successfully!',
            token,                 // <--- JWT here
            user: userWithoutPassword,
          });
        } catch(error) {
          console.error('[verify-user] error:', error);
          res.status(500).json({status: 'error', message: "Error getting user data"});
          next(error);
        }
      }
    );
  }

  //<======== GET USERS SEARCH WITH PAGINATION ===========>

  private getAllUsersWithPagination() {
    this.router.get(
      "/users-with-pagination/:start/:limit",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const start = parseInt(req.params.start as string) || 0;
          const limit = parseInt(req.params.limit as string) || 10;
          const search = (req.query.search as string)?.trim() || "";

          const safeStart = Math.max(0, start);
          const safeLimit = Math.max(1, limit);

          const searchArray = search.trim(); // Split and remove extra spaces

          let nameFilter: any = {};

          nameFilter = {
            $or: [{name: {$regex: searchArray, $options: "i"}}],
          };

          const searchFilter = search
            ? {
              $or: [
                nameFilter,
                {username: {$regex: search, $options: "i"}},
                {email: {$regex: search, $options: "i"}},
              ],
            }
            : {};

          const userCount = await UserModel.countDocuments(searchFilter);
          const users = await UserModel.find(searchFilter)
            .sort({createdAt: -1})
            .skip(safeStart)
            .limit(safeLimit)
            .lean();

          const data = {
            count: userCount,
            start: safeStart,
            end: Math.min(safeStart + safeLimit, userCount),
            limit: safeLimit,
            data: users,
          };

          res.status(200).json(data);
        } catch(error) {
          console.error("Pagination error:", error);
          res.status(500).json({message: "Internal server error: " + error});
        }
      }
    );
  }

  //<=========== GET ALL USERS ==========>

  private getAllUsers() {
    this.router.get("/users", async (req: Request, res: Response) => {
      try {
        const users = await UserModel.find(
          {},
          {
            password: 0,
          },
          {
            sort: {createdAt: -1},
          }
        );
        if(users.length === 0) {
          throw new Error("No users found");
        } else {
          res.status(201).json(users);
        }
      } catch(error) {
        res.status(500).json({error: `Failed to fetch users: ${error}`});
      }
    });
  }

  //<========== VERIFY NEW USER EMAIL ==========>

  private verifyNewUserEmail() {
    this.router.get(
      "/emailverifycation/:token",
      async (req: Request<{token: string}>, res: Response) => {
        const token = req.params.token;

        const user = await UserModel.findOne({
          emailVerificationToken: token,
          emailVerificationTokenExpires: {$gt: new Date()},
        });

        if(user) {
          user.emailVerified = true;
          delete (user as any).emailVerificationToken;
          delete (user as any).emailVerificationTokenExpires;
          user.autoDelete = false;

          await user.save();
          res.redirect("https://localhost:4200/login");
        } else {
          res
            .status(400)
            .sendFile(
              path.join(__dirname, "../../public/error/emailExpire.html"),
              (error) => {
                if(error) {
                  console.log(error);
                }
              }
            );
        }
      }
    );
  }

  //<========== END VERIFY NEW USER EMAIL ==========>

  //<========== SEND THE TOKEN TO THE USER TO VERIFY ==========>
  private async sendVerificationEmail(
    userEmail: string,
    token: string
  ): Promise<boolean> {

    const verifyLink = `http://localhost:3000/api-user/emailverifycation/${token}`;
    const html = `
  <div style="max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; font-family: Arial, sans-serif;">
    <h2 style="text-align: center; color: #007bff;">Verify Your Email Address</h2>
    <p style="font-size: 16px; color: #333;">
      Hi there,
    </p>
    <p style="font-size: 16px; color: #333;">
      Thank you for registering with us. To complete your sign-up and activate your account, please verify your email address by clicking the button below:
    </p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="${verifyLink}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; font-size: 16px; border-radius: 5px; display: inline-block;">
        Verify Email
      </a>
    </div>
    <p style="font-size: 14px; color: #777;">
      If the button above does not work, copy and paste the following link into your browser:
    </p>
    <p style="font-size: 14px; word-break: break-word; color: #555;">
      ${verifyLink}
    </p>
    <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;" />
    <p style="font-size: 12px; color: #999; text-align: center;">
      If you did not create an account, please ignore this email or contact support.
    </p>
  </div>
`;

    const transporter = nodemailer.createTransport({
      service: "gmail", // or SMTP details
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const sendmail = await transporter.sendMail({
      from: '"PropEase Real Estate" <no-reply@propease.com>',
      to: userEmail,
      subject: "Verify Your Email",
      html: html,
    });

    if(sendmail) {
      return true;
    } else {
      return false;
    }
  }

  //<========== END SEND THE TOKEN TO THE USER TO VERIFY ==========>

  //<========== PHONE NUMBER VERIFICATION *USE THIS FOR ONLY IN THE PRODUCTION* ==========>

  private ensureE164(phone: string): string {
    const trimmed = phone.trim();
    // E.164: up to 15 digits, no leading zero after +
    const e164 = /^\+[1-9]\d{7,14}$/;
    if(!e164.test(trimmed)) {
      // If you want to support local numbers, convert here (e.g., SL: +94) before throwing.
      // For now, be strict to avoid sending to a wrong destination.
      throw new Error(
        `Invalid phone format. Provide E.164 like +9477xxxxxxx (got "${phone}").`
      );
    }
    return trimmed;
  }

  private async verifyPhoneNumber(to: string, otp: string): Promise<{sid: string; to: string}> {
    const reqId = (typeof (this as any)?.reqId === 'string' ? (this as any).reqId : undefined) || '-';

    // Basic validation to avoid empty sends
    const code = String(otp ?? '').trim();
    if(code.length < 4 || code.length > 10) {
      throw new Error(`OTP length invalid (reqId=${reqId}).`);
    }

    const toE164 = this.ensureE164(to);

    try {
      const result = await this.twilioClient.messages.create({
        body: `Your verification code is: ${code}`,
        from: Config.twilio.from, // guaranteed string by Config.must()
        to: toE164,
      });

      // Twilio types: result.to can be string | null; normalize for callers
      const normalizedTo = result.to ?? toE164;

      // Optional: log a concise audit line
      console.log(
        `[${reqId}] SMS sent via Twilio → to=${normalizedTo} sid=${result.sid} status=${result.status}`
      );

      return {sid: result.sid, to: normalizedTo};
    } catch(err: unknown) {
      // Surface a clean, actionable error while keeping details in logs
      const e = err as {code?: string | number; message?: string};
      console.error(
        `[${reqId}] Twilio SMS failed: code=${e.code ?? '-'} msg=${e.message ?? String(err)}`
      );
      throw new Error(`Failed to send verification SMS. Please try again.`);
    }
  }

  private generateOTP(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  //<========== END PHONE NUMBER VERIFICATION ==========>

  //<========== CREATE USER ==========>
  private createUser(): void {
    // 1) In-memory storage (we immediately convert → .webp)
    const storage = multer.memoryStorage();

    // 2) Only allow images; cap size (e.g., 5MB)
    const allowedTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/jpg',
      'image/x-icon',
      'image/vnd.microsoft.icon',
      'image/ico',
    ]);

    const upload = multer({
      storage,
      limits: {fileSize: 5 * 1024 * 1024}, // 5 MB
      fileFilter: (_req, file, cb) => {
        if(allowedTypes.has(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files are allowed'));
      },
    });

    this.router.post(
      '/create-user',
      upload.fields([{name: 'userimage', maxCount: 1}]),
      async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
        try {
          // 3) Extract uploaded image & basic fields
          const files = req.files as Record<string, Express.Multer.File[] | undefined>;
          const image = files?.userimage?.[0];
          const username = String(req.body.username || '').trim();

          // 4) Basic input guards
          if(!username) {res.status(400).json({status: 'error', message: 'Invalid username'}); return;}
          if(!this.isSafeSegment(username)) {
            res.status(400).json({status: 'error', message: 'Invalid username format'});
            return;
          }
          if(!image) {res.status(400).json({status: 'error', message: 'Image is required'}); return;}

          // 5) Unique username check up-front (avoid writing files if user exists)
          const exists = await UserModel.exists({username});
          if(exists) {
            res.status(409).json({status: 'error', message: 'Username already exists'});
            return;
          }

          // 6) Build the absolute path for the final image: /public/uploads/users/<username>/image.webp
          const imagePath = path.join(this.DEFAULT_PATH, username, 'image.webp');
          await fse.ensureDir(path.dirname(imagePath)); // make sure folder exists

          // 7) Convert uploaded image buffer → .webp (quality 80)
          await sharp(image.buffer).webp({quality: 80}).toFile(imagePath);

          // 8) Construct a public URL to the image (served by express.static /public)
          const baseUrl = `${req.protocol}://${req.get('host')}`;
          const publicImageUrl = `${baseUrl}/${this.DEFAULT_URL}/${encodeURIComponent(username)}/image.webp`;

          // 9) Parse/validate structured fields (safely)
          const verifyEmailObj = this.parseJSON<{token?: string; expires?: string}>(req.body.verifyEmail, {});
          const token = String(verifyEmailObj.token || '').trim();
          const verifyDate = verifyEmailObj.expires ? new Date(verifyEmailObj.expires) : new Date(Date.now() + 24 * 3600_000);

          const otpValidTimeObj = this.parseJSON<{otpValidTime?: number}>(req.body.otpValidTime, {});
          const otpValidTime = Number.isFinite(otpValidTimeObj.otpValidTime) ? otpValidTimeObj.otpValidTime! : 300; // seconds

          const access = this.parseJSON<any>(req.body.access, {}); // adjust type if you have one

          // 10) Primitive field guards
          const email = String(req.body.email || '').trim();
          const phone = String(req.body.phoneNumber || '').trim();
          const passRaw = String(req.body.userPassword || '').trim();
          if(!email) {res.status(400).json({status: 'error', message: 'Email is required'}); return;}
          if(!this.isSafeSegment(email)) {
            res.status(400).json({status: 'error', message: 'Invalid email format'});
            return;
          }
          if(!phone) {
            res.status(400).json({status: 'error', message: 'Phone number is required'});
            return;
          }
          if(!passRaw) {
            res.status(400).json({status: 'error', message: 'Password is required'});
            return;
          }

          // 11) (Optional) Send verification email first — fail fast if email service is down
          if(token) {
            const ok = await this.sendVerificationEmail(email, token);
            if(!ok) {res.status(502).json({status: 'error', message: 'Failed to send verification email'}); return;}
          }

          // 12) Hash password & generate OTP
          const password = await this.hashPassword(passRaw);
          const otp = this.generateOTP();

          // 13) Construct and save the user
          const newUser = new UserModel({
            name: String(req.body.name || '').trim(),
            username,
            email,
            dateOfBirth: req.body.dateOfBirth || null,
            age: req.body.age || null,
            gender: req.body.gender || null,
            bio: req.body.bio || '',
            phoneNumber: phone,
            image: publicImageUrl, // public URL to the uploaded .webp
            role: req.body.role || 'user',
            isActive: req.body.isActive ?? true,
            address: {
              street: req.body.street || '',
              houseNumber: req.body.houseNumber || '',
              city: req.body.city || '',
              postcode: req.body.postcode || '',
              country: req.body.country || '',
              stateOrProvince: req.body.stateOrProvince || '',
            },
            access,
            password,
            otpToken: otp,
            otpValidTime,
            emailVerificationToken: token || undefined,
            emailVerificationTokenExpires: verifyDate,
            creator: req.body.creator || 'system',
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          await newUser.save();

          // 14) Send a notification to back-office roles
          const notificationService = new NotificationService();
          const io = req.app.get('io') as import('socket.io').Server;

          await notificationService.createNotification(
            {
              title: 'New User',
              body: `User ${newUser.name || newUser.username} has registered.`,
              type: 'create',
              severity: 'info',
              audience: {mode: 'role', roles: ['admin', 'manager', 'operator']},
              channels: ['inapp', 'email'],
              metadata: {
                username: newUser.username,
                email: newUser.email,
                phoneNumber: newUser.phoneNumber,
                image: newUser.image,
                role: newUser.role,
                createdAt: newUser.createdAt,
                creator: newUser.creator,
              },
            },
            (rooms, payload) => rooms.forEach((room) => io.to(room).emit('notification.new', payload))
          );

          // 15) Done
          res.status(201).json({
            status: 'success',
            message: 'User created successfully',
            user: newUser,
          });
          return;
        } catch(error: any) {
          console.error('[create-user] error:', error?.message || error);
          res.status(500).json({
            status: 'error',
            message: `Failed to create user: ${error?.message || 'Internal error'}`,
          });
          return;
        }
      }
    );
  }
  //<========== END CREATE USER =========>

  //<=========== UPDATE USER ==============>
  private updateUser(): void {
    // 1) Store uploads in memory (we’ll convert to .webp and write ourselves)
    const storage = multer.memoryStorage();

    // 2) Strict file types + size limit
    const allowedTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/jpg',
      'image/x-icon',
      'image/vnd.microsoft.icon',
      'image/ico',
    ]);

    const upload = multer({
      storage,
      limits: {fileSize: 5 * 1024 * 1024}, // 5MB cap; tune as you wish
      fileFilter: (_req, file, cb) => {
        if(allowedTypes.has(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files are allowed'));
      },
    });

    this.router.put(
      '/user-update/:username',
      upload.fields([{name: 'userimage', maxCount: 1}]),
      async (req: Request<{username: string}>, res: Response, _next: NextFunction): Promise<void> => {
        try {
          // 3) Pull the username from URL and validate quickly
          const username = String(req.params.username || '').trim();
          if(!username) {res.status(400).json({status: 'error', message: 'Invalid username'}); return;}
          if(!this.isSafeSegment(username)) {
            res.status(400).json({status: 'error', message: 'Invalid username format'});
            return;
          }

          // 4) Fetch the user once (we’ll reuse it for defaults)
          const user = await UserModel.findOne({username});
          if(!user) {res.status(404).json({status: 'error', message: 'User not found'}); return;}

          // 5) Pull optional image file (multer format)
          const files = req.files as Record<string, Express.Multer.File[] | undefined>;
          const image = files?.userimage?.[0];

          // 6) Compute a public URL base (served by express.static('/public'))
          const baseUrl = `${req.protocol}://${req.get('host')}`;

          // 7) If an image was uploaded, convert → .webp and place at:
          //    /public/uploads/users/<username>/image.webp
          let imageUrl = user.image; // default to existing
          if(image) {
            const imagePath = path.join(this.DEFAULT_PATH, username, 'image.webp');
            // Ensure the directory exists (IMPORTANT: use dirname, not the file path)
            await fse.ensureDir(path.dirname(imagePath));

            // Remove old file if present (safe & optional)
            await fse.remove(imagePath).catch(() => { /* ignore */});

            // Convert the new image to webp at quality 80
            await sharp(image.buffer).webp({quality: 80}).toFile(imagePath);

            // Build the new public URL
            imageUrl = `${baseUrl}/${this.DEFAULT_URL}/${encodeURIComponent(username)}/image.webp`;
          }

          // 8) Pull new values from body (they may be missing)
          const body = req.body as Record<string, any>;

          // 9) Handle potential email change (oldEmail vs email)
          const oldEmail = String(body.oldEmail ?? user.email ?? '').trim();
          const newEmail = String(body.email ?? user.email ?? '').trim();
          const emailChanged = oldEmail && newEmail && oldEmail !== newEmail;

          // 10) If email changed, read verification payloads safely
          let verifyToken = this.parseJSON<{token?: string; expires?: string}>(body.otpToken, {});
          let otpValidTimeJson = this.parseJSON<{otpValidTime?: number}>(body.otpValidTime, {});
          // normalize expires date
          const tokenExpires =
            verifyToken.expires ? new Date(verifyToken.expires) : undefined;

          // 11) Optional password change: hash only if provided and non-empty
          const pwRaw = typeof body.password === 'string' ? body.password.trim() : '';
          let hashedPassword: string | undefined;
          if(pwRaw) {
            hashedPassword = await this.hashPassword(pwRaw);
          }

          // 12) Access object (if provided as JSON string)
          const access = this.parseJSON<any>(body.access, user.access);

          // 13) Prepare update doc. We only include properties that were actually provided,
          //     so we don’t overwrite existing fields with undefined.
          //     For primitives we check `in body` rather than truthiness.
          const updates: Record<string, any> = {
            updatedAt: new Date(),
          };

          const setField = (key: string, val: unknown) => {updates[key] = val;};

          if('name' in body) setField('name', String(body.name ?? '').trim());
          // never change username here intentionally — it’s your identity key
          setField('username', username); // keep the same username

          if('email' in body) setField('email', newEmail);

          if('dateOfBirth' in body) setField('dateOfBirth', body.dateOfBirth ?? null);
          if('age' in body) setField('age', body.age ?? null);
          if('gender' in body) setField('gender', body.gender ?? null);
          if('bio' in body) setField('bio', String(body.bio ?? '').trim());
          if('phoneNumber' in body) setField('phoneNumber', String(body.phoneNumber ?? '').trim());

          // image: always update to new URL if changed; otherwise keep existing
          setField('image', imageUrl);

          if('role' in body) setField('role', String(body.role ?? '').trim());

          // isActive: accept "true"/"false" or boolean
          if('isActive' in body) {
            const raw = body.isActive;
            const boolVal = typeof raw === 'boolean' ? raw : String(raw).trim().toLowerCase() === 'true';
            setField('isActive', boolVal);
          }

          // address (merge, do not nuke the object entirely if only some fields sent)
          const addrUpdate: Record<string, any> = {};
          const addrKeys = ['street', 'houseNumber', 'city', 'postcode', 'country', 'stateOrProvince'] as const;
          for(const k of addrKeys) {
            if(k in body) addrUpdate[k] = String(body[k] ?? '').trim();
          }
          if(Object.keys(addrUpdate).length > 0) setField('address', {...(user.address || {}), ...addrUpdate});

          // access (object)
          if('access' in body) setField('access', access);

          if('creator' in body) setField('creator', String(body.creator ?? '').trim());
          if('updator' in body) setField('updator', String(body.updator ?? '').trim());

          // Password (only if provided)
          if(hashedPassword) setField('password', hashedPassword);

          // If email changed, update verification-related fields
          if(emailChanged) {
            setField('otpToken', verifyToken?.token);
            if(typeof otpValidTimeJson?.otpValidTime === 'number') {
              setField('otpValidTime', otpValidTimeJson.otpValidTime);
            }
            setField('emailVerificationToken', verifyToken?.token);
            setField('emailVerificationTokenExpires', tokenExpires);
          }

          // 14) Perform the update
          const updatedUser = await UserModel.findOneAndUpdate(
            {username},
            {$set: updates},
            {new: true, upsert: false}
          );

          if(!updatedUser) {
            res.status(404).json({status: 'error', message: 'User not found or update failed'});
            return;
          }

          // 15) Notify admins/operators/managers that a user was updated
          const notificationService = new NotificationService();
          const io = req.app.get('io') as import('socket.io').Server;

          await notificationService.createNotification(
            {
              title: 'Update User',
              body: `User ${updatedUser.name || updatedUser.username} has been updated.`,
              type: 'update',
              severity: 'info',
              audience: {mode: 'role', roles: ['admin', 'manager', 'operator']},
              channels: ['inapp', 'email'],
              metadata: {
                username: updatedUser.username,
                email: updatedUser.email,
                phoneNumber: updatedUser.phoneNumber,
                image: updatedUser.image,
                role: updatedUser.role,
                updatedAt: new Date(),
                updatedBy: (typeof body.updator === 'string' ? body.updator.trim() : undefined) || 'system',
                // include only “diff-like” info if you want; here we include the fields we set
                appliedUpdates: updates,
              },
            },
            (rooms, payload) => rooms.forEach((room) => io.to(room).emit('notification.new', payload))
          );

          // 16) Respond OK
          res.status(200).json({
            status: 'success',
            message: 'User updated successfully',
            user: updatedUser,
          });
          return;
        } catch(error: any) {
          console.error('[user-update] error:', error?.message || error);
          res.status(500).json({
            status: 'error',
            message: error?.message || 'Internal server error',
          });
          return;
        }
      }
    );
  }
  //<=========== END UPDATE USER ==============>

  //<========= FIND USER BY USERNAME ==========>

  private findUserByUsername() {
    this.router.get(
      "/user-username/:username",
      async (req: Request<{username: string}>, res: Response) => {
        const username = req.params.username;
        const user = await UserModel.findOne({username: username});
        try {
          if(!user) {
            res.status(200).json({status: "false"});
          } else {
            res.status(200).json({status: "true", user: user});
          }
        } catch(error) {
          console.error("Error in updateUser:", error);
          res
            .status(500)
            .json({status: "error", message: "Error: server side error..."});
        }
      }
    );
  }

  //<======== Before inserting user input into a regex, escape it: ===========>

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  //<======== End Before inserting user input into a regex, escape it: ===========>

  //<======== FIND THE USER BY EMAIL ===========>

  private findUserByEmail() {
    this.router.get(
      "/user-email/:email",
      async (req: Request<{email: string}>, res: Response) => {
        try {
          const rawEmail = req.params.email;
          const email = decodeURIComponent(rawEmail ?? "").trim();

          // Simple email validation
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if(!emailRegex.test(email)) {
            res
              .status(400)
              .json({status: "error", message: "Invalid email format"});
          }

          const user = await UserModel.findOne({
            email: {$regex: `^${this.escapeRegex(email)}$`, $options: "i"},
          });

          if(user) {
            res.status(200).json({status: "true"}); // Email exists
          } else {
            res.status(200).json({status: "false"}); // Email does not exist
          }
        } catch(error) {
          console.error("Error in findUserByEmail:", error);
          res
            .status(500)
            .json({status: "error", message: "Server error occurred"});
        }
      }
    );
  }

  //<========== FIND THE USER BY PHONE NUMBER ============>

  private findUserByPhone() {
    this.router.get(
      "/user-phone/:phone",
      async (req: Request<{phone: string}>, res: Response): Promise<any> => {
        try {
          const phoneNumber = req.params.phone.trim();

          // Simple phone validation
          const phoneRegex = /^(?:\+?[1-9]\d{1,3}|0)[\d\s\-()]{7,20}$/;
          if(!phoneRegex.test(phoneNumber)) {
            return res.status(400).json({
              status: "error",
              message: "Invalid phone number format",
              data: phoneNumber
            });
          }

          const user = await UserModel.findOne({
            phoneNumber: {
              $regex: `^${this.escapeRegex(phoneNumber)}$`,
              $options: "i",
            },
          });

          if(user) {
            return res.status(200).json({
              status: "success",
              message: "Phone number exists!",
              data: user,
            });
          } else {
            return res.status(200).json({
              status: "error",
              message: "Phone number does not exist!",
              data: null,
            });
          }
        } catch(error) {
          console.error("Error in findUserByPhone:", error);
          return res
            .status(500)
            .json({status: "error", message: "Server error occurred"});
        }
      }
    );
  }

  //<============= GENERATE A TOKEN =============>

  private generateToken() {
    this.router.post(
      "/generate-token",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const {username} = req.body;
          if(username) {
            const token = crypto.randomBytes(32).toString("hex");
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min TTL
            const data = {
              token,
              username,
              type: "view",
              expiresAt,
            };
            const saveToken = await TokenMap.create(data);
            if(saveToken) {
              res.status(201).json({
                status: "success",
                message: "Token generated successfully",
                token: saveToken.token,
              });
            } else {
              throw new Error("Failed to generate token");
            }
          } else {
            throw new Error("Invalid username");
          }
        } catch(error) {
          console.log(error);
          res.status(500).json({
            status: "error",
            message: "Server error occurred: " + error,
          });
        }
      }
    );
  }

  //<============= END GENERATE A TOKEN =============>

  //<============= GET USER BY TOKEN =============>

  private getUserByToken() {
    this.router.get(
      "/user-token/:token",
      async (
        req: Request<{token: string}>,
        res: Response,
        next: NextFunction
      ) => {
        try {
          const token = req.params.token;
          if(token) {
            const data = await TokenMap.findOne({token});
            if(data) {
              const user = await UserModel.findOne({username: data.username});
              if(user) {
                res.status(200).json({
                  status: "success",
                  message: "User found",
                  user: user,
                });
              } else {
                throw new Error("User not found");
              }
            } else {
              throw new Error("Token not found");
            }
          }
        } catch(error) {
          console.log(error);
          res.status(500).json({
            status: "error",
            message: "Server error occurred: " + error,
          });
        }
      }
    );
  }

  //<============= END GET USER BY TOKEN =============>
  //<============= USER DOCUMENT UPLOAD =============>
  private uploadDocument(): void {
    // Allow common office docs, PDFs, text, CSV/TSV, ODF, and images
    const allowedTypes = new Set<string>([
      // Word
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
      'application/rtf',

      // Excel
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
      'text/csv',
      'text/tab-separated-values',

      // PowerPoint
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.presentationml.template',

      // OpenDocument
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',

      // PDF & plain text
      'application/pdf',
      'text/plain',

      // Images
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/jpg',
      'image/svg+xml',
      'image/x-icon',
      'image/vnd.microsoft.icon',
    ]);

    // Disk storage so large docs don’t sit in memory; define where & how to name
    const storage = multer.diskStorage({
      destination: async (req, file, cb) => {
        try {
          // Username is defined in route params
          const username = String(req.params.username || '').trim();

          // Validate presence + restrict characters (avoid weird folder names)
          if(!username) return cb(new Error('Username is required in URL.'), '');
          if(!this.isSafeSegment(username)) return cb(new Error('Invalid username format.'), '');

          // Build absolute path: /public/uploads/users/<username>/documents
          // NOTE: DEFAULT_PATH is already absolute (…/public/uploads/users/)
          const uploadPath = path.join(this.DEFAULT_PATH, username, 'documents');

          // Ensure folder exists
          await fse.ensureDir(uploadPath);

          // Hand the path back to multer
          cb(null, uploadPath);
        } catch(e: any) {
          cb(e instanceof Error ? e : new Error(String(e)), '');
        }
      },
      filename: (_req, file, cb) => {
        // Make a safe filename: replace spaces, strip path-like bits, keep extension
        const original = path.basename(file.originalname).replace(/\s+/g, '_');
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${unique}-${original}`);
      },
    });

    // Multer instance with file type checks + size limits
    const upload = multer({
      storage,
      limits: {
        fileSize: 20 * 1024 * 1024, // 20MB per file; adjust to your needs
        files: 10,                   // limit number of files per request
      },
      fileFilter: (_req, file, cb) => {
        if(allowedTypes.has(file.mimetype)) cb(null, true);
        else cb(new Error(`File type not allowed: ${file.mimetype}`));
      },
    });

    // Route: POST /user-document-upload/:username
    this.router.post(
      '/user-document-upload/:username',
      upload.array('files', 10), // field name "files" on the form; up to 10 files
      async (req: Request<{username: string}>, res: Response): Promise<any> => {
        try {
          // 1) Ensure files were uploaded
          const files = req.files as Express.Multer.File[] | undefined;
          if(!files || files.length === 0) {
            return res.status(400).json({status: 'error', message: 'No files uploaded.'});
          }

          // 2) Use the username from the URL (not the body)
          const username = String(req.params.username || '').trim();
          if(!username) return res.status(400).json({status: 'error', message: 'Username is required.'});
          if(!this.isSafeSegment(username)) {
            return res.status(400).json({status: 'error', message: 'Invalid username format.'});
          }

          // 3) (Optional) Validate the user actually exists in DB
          const userExists = await UserModel.exists({username});
          if(!userExists) {
            // Optionally: clean up uploaded files if the user doesn't exist
            await Promise.all(files.map(f => fse.remove(f.path).catch(() => {})));
            return res.status(404).json({status: 'error', message: 'User not found.'});
          }

          // 4) Who uploaded? (optional meta)
          const uploader = String((req.body?.uploader ?? '')).trim() || 'system';

          // 5) Build public URLs pointing to /uploads/users/<username>/documents/<file>
          const baseUrl = `${req.protocol}://${req.get('host')}`;

          const savedFiles = files.map((file) => ({
            originalName: file.originalname,
            storedName: file.filename,
            mimeType: file.mimetype,
            size: file.size,
            // WARNING: file.path is absolute and should not be sent to the client if you’re concerned about disclosure.
            // Keep it for internal use only; comment out if you don’t want to expose it.
            path: file.path,
            extension: path.extname(file.originalname),
            download: `${username}/documents/${file.filename}`, // your relative pattern (if you need it internally)
            URL: `${baseUrl}/${this.DEFAULT_URL}/${encodeURIComponent(username)}/documents/${encodeURIComponent(file.filename)}`,
            uploader,
            uploadedAt: new Date(),
          }));

          // 6) Upsert UserDocument record for this username
          //    If you use a schema like: { username: string, files: FileMeta[] }
          const doc = await UserDocument.findOneAndUpdate(
            {username},
            {$push: {files: {$each: savedFiles}}},
            {upsert: true, new: true}
          );

          if(!doc) {
            // Super-rare: findOneAndUpdate could return null only on unexpected errors
            return res.status(500).json({status: 'error', message: 'Failed to save files.'});
          }

          // 7) All good
          return res.status(200).json({
            status: 'success',
            message: 'Files uploaded and saved successfully.',
            fileCount: files.length,
            uploadedFiles: savedFiles.map(f => ({
              originalName: f.originalName,
              storedName: f.storedName,
              mimeType: f.mimeType,
              size: f.size,
              extension: f.extension,
              URL: f.URL,
              uploader: f.uploader,
              uploadedAt: f.uploadedAt,
            })),
          });
        } catch(error: any) {
          // If multer threw a fileFilter/storage error, it will land here
          console.error('[user-document-upload] error:', error?.message || error);
          return res.status(500).json({
            status: 'error',
            message: error?.message || 'Server error',
          });
        }
      }
    );
  }
  //<============= END USER DOCUMENT UPLOAD =============>

  //<============= GET USER DOCUMENTS =============>
  private getUserDocuments() {
    this.router.get(
      "/uploads/:username/documents",
      async (req: Request<{username: string}>, res: Response) => {
        try {
          const username = req.params.username;
          if(!username) throw new Error("Username is required.");
          const user = await UserDocument.findOne({username}).sort({
            updatedAt: -1,
          });
          if(user) {
            res.status(200).json({
              status: "success",
              message: "Files retrieved successfully.",
              data: user.files,
            });
          } else {
            throw new Error("User not found");
          }
        } catch(error) {
          console.error("Upload error:", error);
          res.status(500).json({
            status: "error",
            message: "Server error: " + error,
          });
        }
      }
    );
  }
  //<============= END GET USER DOCUMENTS =============>
  //<============= GET USER DATA BY USERNAME =============>
  private getUserDataByUsername() {
    this.router.get(
      "/user-data/:username",
      async (req: Request<{username: string}>, res: Response) => {
        try {
          const username = req.params.username;
          const user = await UserModel.findOne(
            {username: username},
            {password: 0}
          );
          if(!user) {
            throw new Error("User not founded!");
          } else {
            res.status(200).json({
              status: "success",
              message: "User data founded",
              data: user,
            });
          }
        } catch(error) {
          res.status(500).json({status: "error", message: error});
        }
      }
    );
  }
  //<============= END GET USER DATA BY USERNAME =============>

  //<============= DELETE USER BY USERNAME =============>
  private deleteUserByUsername() {
    this.router.delete(
      '/user-delete/:username/:deletedBy',
      async (req: Request<{username: string; deletedBy: string}>, res: Response): Promise<void> => {
        try {
          // 1) Collect inputs from params/body/query (first non-empty wins)
          const username =
            req.params.username?.trim() ||
            req.body?.username?.trim() ||
            (req.query?.username as string | undefined)?.trim();

          const deletedBy =
            req.params.deletedBy?.trim() ||
            req.body?.deletedBy?.trim() ||
            (req.query?.deletedBy as string | undefined)?.trim();

          if(!username) throw new Error('Username is required');
          if(!deletedBy) throw new Error('Deletor is required');

          // 2) Path traversal safety
          if(!this.isSafeSegment(username)) {
            res.status(400).json({status: 'error', message: 'Invalid username format'});
            return;
          }

          // 3) Build URLs for previewing "deleted" image (optional)
          //    Note: trust proxy must be true for correct protocol behind proxies.
          const baseUrl = `${req.protocol}://${req.get('host')}`;

          // 4) Look up the user first (so we can snapshot data.json)
          const userDoc = await UserModel.findOne({username}).lean();

          // 5) Compute all important paths — IMPORTANT: do NOT prepend __dirname again;
          //    your class constants are already absolute.
          const recycleUserDir = path.join(this.RECYCLE_PATH, username);                  // /public/recyclebin/users/<username>/
          const userImagePath = path.join(this.DEFAULT_PATH, username, 'image.webp');    // /public/uploads/users/<username>/image.webp
          const userDocsPath = path.join(this.DEFAULT_PATH, username, 'documents');     // /public/uploads/users/<username>/documents/
          const deletedCopyDir = path.join(this.DEFAULT_PATH, 'deleted', username);       // /public/uploads/users/deleted/<username>/
          const deletedCopyImage = path.join(deletedCopyDir, 'image.webp');                 // /public/uploads/users/deleted/<username>/image.webp
          const deletedImageURL = `${baseUrl}/${this.DEFAULT_URL}/deleted/${encodeURIComponent(username)}/image.webp`;

          // 6) Make sure recyclebin dir exists
          await fse.ensureDir(recycleUserDir);

          // 7) Write data.json snapshot into recyclebin (if we found the user)
          if(userDoc) {
            const userJsonPath = path.join(recycleUserDir, 'data.json');
            await fse.writeJson(userJsonPath, userDoc, {spaces: 2});
          }

          // 8) Copy a "deleted preview" of image into /uploads/users/deleted/<username>/image.webp (optional UX)
          //    This gives admins an easy place to quickly preview what was deleted.
          if(await fse.pathExists(userImagePath)) {
            await fse.ensureDir(deletedCopyDir);
            await fse.copy(userImagePath, deletedCopyImage, {overwrite: true});
          }

          // 9) Move/copy user assets into recyclebin, preserving structure
          //    - We COPY first (safer), then remove the original to avoid data loss on mid-operation crash.
          //    image.webp -> /recyclebin/users/<username>/image.webp
          if(await fse.pathExists(userImagePath)) {
            await fse.copy(userImagePath, path.join(recycleUserDir, 'image.webp'), {overwrite: true});
            await fse.remove(userImagePath);
          }

          //    documents/ -> /recyclebin/users/<username>/documents
          if(await fse.pathExists(userDocsPath)) {
            await fse.copy(userDocsPath, path.join(recycleUserDir, 'documents'), {overwrite: true});
            await fse.remove(userDocsPath);
          }

          // 10) Clear relationships referencing this user (example)
          await PropertyModel.updateMany({owner: username}, {$unset: {owner: 1}});
          await PropertyModel.updateMany({'addedBy.username': username}, {$unset: {addedBy: {} as any}});

          // 11) Emit a notification for admins/operators/managers
          if(userDoc) {
            const notificationService = new NotificationService();
            const io = req.app.get('io') as import('socket.io').Server;

            await notificationService.createNotification(
              {
                title: 'Delete User',
                body: `User ${userDoc.name ?? username} has been deleted.`,
                type: 'delete',
                severity: 'warning',
                audience: {
                  mode: 'role',
                  roles: ['admin', 'manager', 'operator'], // broadcast to back-office staff
                },
                channels: ['inapp', 'email'],
                metadata: {
                  username,
                  userId: String(userDoc._id ?? ''),
                  deletedBy,
                  deletedAt: new Date().toISOString(),
                  recyclebinUrl: `${this.RECYCLE_URL}/${encodeURIComponent(username)}/`, // relative web url (blocked to public, but informative metadata)
                  deletedImageURL,
                },
              },
              (rooms, payload) => {
                rooms.forEach((r) => io.to(r).emit('notification.new', payload));
              }
            );
          }

          // 12) Finally remove the user document from DB
          const deleted = await UserModel.findOneAndDelete({username}).lean();
          if(!deleted) {
            // If this happens, you still have a snapshot + media in recyclebin for safety
            res.status(404).json({status: 'error', message: 'User not found'});
            return;
          }

          // 13) Return success
          res.status(200).json({
            status: 'success',
            message: 'User deleted successfully',
            data: {
              username,
              recyclebin: path.join(this.RECYCLE_URL, username, '/'),  // relative web path (blocked by your middleware)
              deletedImageURL,
            },
          });
          return;
        } catch(err: any) {
          console.error('[user-delete] error:', err?.message || err);
          res.status(500).json({status: 'error', message: err?.message || 'Internal error'});
          return;
        }
      }
    );
  }
  //<============= END DELETE USER BY USERNAME =============>
}
