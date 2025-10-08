import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import * as path from "path";
import * as fs from "fs-extra";

import {UserModel, IUser} from "../models/user.model";
import * as Argon2 from "argon2";
import multer from "multer";
import sharp from "sharp";
import os from "os";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import twilio from "twilio";
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
import {NotificationService} from '../services/notification.service';

dotenv.config();

export default class UserRoute {
  private router: express.Router;
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

  //<====== VERIFY THE LOGIN USER ============>

  private getUserData() {
    this.router.post(
      "/verify-user",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const user: IUser | null = await UserModel.findOne({
            username: req.body.username,
          });

          if(user !== null) {
            const isPasswordValid = await Argon2.verify(
              user.password,
              req.body.password
            );
            if(isPasswordValid) {
              const plainUser = user.toObject ? user.toObject() : user; // fallback if toObject() doesn't exist
              const {password, ...userWithoutPassword} = plainUser;
              const respondData: MSG = {
                status: 'success',
                message: 'User verified successfully!',
                data: userWithoutPassword
              }
              res.status(200).json(respondData);
            } else {
              res.status(401).json({error: "Invalid password"});
            }
          } else {
            res.status(401).json({error: "Invalid username"});
          }
        } catch(error) {
          res
            .status(500)
            .json({error: "Error getting user data", details: error});
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
          user.emailVerificationToken = undefined;
          user.emailVerificationTokenExpires = undefined;
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

  private async verifyPhoneNumber(to: string, otp: string) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_ACCOUNT_AUTH_TOKEN;
    const twilioPhone = process.env.TWILIO_ACCOUNT_PHONE_NUMBER;

    const client = twilio(accountSid, authToken);
    return client.messages.create({
      body: `Your verification code is: ${otp}`,
      from: twilioPhone,
      to,
    });
  }

  private generateOTP(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  //<========== END PHONE NUMBER VERIFICATION ==========>

  //<========== CREATE USER ==========>
  private createUser(): void {
    const storage = multer.memoryStorage();
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/jpg",
      "image/ico",
    ];

    const upload = multer({
      storage,
      fileFilter: (req, file, cb) => {
        if(allowedTypes.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error("Only image files are allowed"));
        }
      },
    });
    this.router.post(
      "/create-user",
      upload.fields([{name: "userimage", maxCount: 1}]),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const files = req.files as {
            [fieldname: string]: Express.Multer.File[];
          };

          const image = files?.userimage?.[0];
          const username = req.body.username;

          const io = req.app.get('io');

          if(!username) throw new Error("Invalid username");

          if(image) {
            // Create user-specific directory
            const userDir = path.join(
              __dirname,
              "../../public/users",
              username
            );

            //Define the image path
            const imagePath = path.join(userDir, "image.webp");
            fs.mkdirSync(userDir, {recursive: true});

            // Convert and save image as .webp
            const imagetoWebp = await sharp(image.buffer)
              .webp({quality: 80})
              .toFile(imagePath);

            //Checking the image is converted and stored
            if(imagetoWebp) {
              //Define the local Variables
              const host = req.get("host");
              const protocol = req.protocol;
              const baseUrl = `${protocol}://${host}`;
              const verifyEmail = JSON.parse(req.body.verifyEmail);
              const token = verifyEmail.token;
              const verifyDate = new Date(verifyEmail.expires);
              const otp = this.generateOTP();
              const otpValidTimeJson = JSON.parse(req.body.otpValidTime);
              const otpValidTime = otpValidTimeJson.otpValidTime;
              const email = req.body.email.trim();
              const phone = req.body.phoneNumber.trim();
              const publicPath = `${baseUrl}/users/${username}/image.webp`;
              const pass = req.body.userPassword.trim();
              if(!pass) throw new Error("Password is required");

              //Hashing the password
              const password = await this.hashPassword(pass);
              const access = JSON.parse(req.body.access);

              //Calling the method to verify the email
              if(email) {
                const sendEmail = await this.sendVerificationEmail(
                  email,
                  token
                );
                if(!sendEmail) {
                  throw new Error("Failed to send email");
                }
              } else {
                throw new Error("Email is required");
              }

              //Calling the method to verify the phone number *USE THIS ONLY FOR THE PRODUCTION*
              // if (phone) {
              //   const sendPhone = await this.verifyPhoneNumber(phone, otp);
              //   if (!sendPhone) {
              //     throw new Error("Failed to send phone number");
              //   }
              // } else {
              //   throw new Error("Contact number is required");
              // }

              if(!phone) throw new Error("Contact number is required");

              const newUser = new UserModel({
                name: req.body.name,
                username: req.body.username,
                email: req.body.email,
                dateOfBirth: req.body.dateOfBirth,
                age: req.body.age,
                gender: req.body.gender,
                bio: req.body.bio,
                phoneNumber: phone,
                image: publicPath,
                role: req.body.role,
                isActive: req.body.isActive,
                address: {
                  street: req.body.street,
                  houseNumber: req.body.houseNumber,
                  city: req.body.city,
                  postcode: req.body.postcode,
                  country: req.body.country,
                  stateOrProvince: req.body.stateOrProvince,
                },
                access: access,
                password: password,
                otpToken: otp,
                otpValidTime: otpValidTime,
                emailVerificationToken: token,
                emailVerificationTokenExpires: verifyDate,
                creator: req.body.creator,
                createdAt: new Date(),
                updatedAt: new Date(),
              });
              const save = await newUser.save();
              if(save) {
                // Notify all admins about the new property added
                const admins = await UserModel.find({role: {$regex: /^admin$/i}}, {_id: 1}).lean() as unknown as Array<{_id: import("mongoose").Types.ObjectId}>;
                const adminIds = admins.map(admin => admin._id);
                await NotificationService.createAndSend(io, {
                  type: 'USER_CREATED',
                  title: 'New User Created',
                  body: `New User Created: "${req.body.name}".`,
                  meta: {username: req.body.username, email: req.body.email, role: req.body.role},
                  recipients: adminIds,
                  roles: ['admin']
                });
                res.status(201).json({
                  status: "success",
                  message: "User created successfully",
                  user: newUser,
                });
              } else {
                throw new Error("Failed to create user");
              }
            } else {
              throw new Error("Failed to convert image");
            }
          } else {
            throw new Error("Image is required");
          }
        } catch(error) {
          console.error("User creation error:", error);
          res.status(500).json({
            status: "error",
            message: "Failed to create user: " + error,
          });
        }
      }
    );
  }

  //<=========== UPDATE USER ==============>
  private updateUser(): void {
    const storage = multer.memoryStorage();

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/jpg",
      "image/ico",
    ];

    const upload = multer({
      storage,
      fileFilter: (req, file, cb) => {
        if(allowedTypes.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error("Only image files are allowed"));
        }
      },
    });

    this.router.put(
      "/user-update/:username",
      upload.fields([{name: "userimage", maxCount: 1}]),
      async (req: Request<{username: string}>, res: Response) => {
        try {
          const username = req.params.username?.trim();

          if(!username) throw new Error("Invalid username");

          const isUserExist = await UserModel.findOne({username});

          if(!isUserExist) {
            throw new Error("User not found");
          }

          const files = req.files as {
            [fieldname: string]: Express.Multer.File[];
          };

          const image = files?.userimage?.[0];

          const host = req.get("host");
          const protocol = req.protocol;
          let imageUrl: string;

          if(image) {
            const userDir = path.join(
              __dirname,
              `../../public/users/${username}`
            );
            const imagePath = path.join(userDir, "image.webp");

            if(fs.existsSync(userDir)) {
              fs.rmSync(userDir, {recursive: true, force: true});
            }

            fs.mkdirSync(userDir, {recursive: true});

            await sharp(image.buffer).webp({quality: 80}).toFile(imagePath);

            imageUrl = `${protocol}://${host}/users/${username}/image.webp`;
          } else {
            imageUrl = req.body.userimage?.trim();
          }

          // Compare old and new email
          const oldEmail = req.body.oldEmail?.trim();
          const newEmail = req.body.email?.trim();

          let verifyToken: {token?: string; expires?: string} = {};
          let otpValidTimeJson: {otpValidTime?: string} = {};

          if(oldEmail !== newEmail) {
            try {
              verifyToken = JSON.parse(req.body.otpToken || "{}");
              otpValidTimeJson = JSON.parse(req.body.otpValidTime || "{}");
            } catch {
              verifyToken = {};
              otpValidTimeJson = {};
            }
          }

          const pw = req.body.password.trim();

          const access = JSON.parse(req.body.access || "{}");

          const data: any = {
            name: req.body.name?.trim(),
            username: username.trim(),
            email: newEmail,
            dateOfBirth: req.body.dateOfBirth?.trim(),
            age: req.body.age?.trim(),
            gender: req.body.gender?.trim(),
            bio: req.body.bio?.trim(),
            phoneNumber: req.body.phoneNumber?.trim(),
            image: imageUrl,
            role: req.body.role?.trim(),
            isActive: req.body.isActive?.trim(),
            address: {
              street: req.body.street?.trim(),
              houseNumber: req.body.houseNumber?.trim(),
              city: req.body.city?.trim(),
              postcode: req.body.postcode?.trim(),
              country: req.body.country?.trim(),
              stateOrProvince: req.body.stateOrProvince?.trim(),
            },
            access,
            creator: req.body.creator?.trim(),
            updator: req.body.updator?.trim(),
            updatedAt: new Date(),
          };

          if(pw) {
            data.password = await this.hashPassword(pw);
          }


          // Append token & time if email was changed
          if(oldEmail !== newEmail) {
            Object.assign(data, {
              otpToken: verifyToken?.token,
              otpValidTime: otpValidTimeJson?.otpValidTime,
              emailVerificationToken: verifyToken?.token,
              emailVerificationTokenExpires: verifyToken?.expires
                ? new Date(verifyToken.expires)
                : undefined,
            });
          }

          const updatedUser = await UserModel.findOneAndUpdate(
            {username},
            data,
            {new: true, upsert: false}
          );

          if(!updatedUser) {
            throw new Error("User not found or update failed");
          }

          res.status(200).json({
            status: "success",
            message: "User updated successfully",
            user: updatedUser,
          });
        } catch(error: any) {
          console.error("User update error:", error.message);
          res.status(500).json({
            status: "error",
            message: error.message || "Internal server error",
          });
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
  private uploadDocument() {
    const allowedTypes = [
      // Word Documents
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/rtf",

      // Excel Documents
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "text/csv",
      "text/tab-separated-values",

      // PowerPoint Documents
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.template",

      // OpenDocument Formats
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",

      // PDF
      "application/pdf",

      // Plain Text
      "text/plain",

      // Common Image Types
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/jpg",
      "image/ico",
      "image/svg+xml",
    ];

    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const username = req.params.username;

        if(!username)
          return cb(new Error("Username is required in form data."), "");

        const uploadPath = path.join(
          __dirname,
          `../../public/uploads/${username}/documents`
        );
        fs.mkdirSync(uploadPath, {recursive: true});
        cb(null, uploadPath);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const sanitized = file.originalname.replace(/\s+/g, "_");
        cb(null, `${uniqueSuffix}-${sanitized}`);
      },
    });

    const upload = multer({
      storage,
      fileFilter: (req, file, cb) => {
        if(allowedTypes.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error(`File type not allowed: ${file.mimetype}`));
        }
      },
    });

    this.router.post(
      "/user-document-upload/:username",
      upload.array("files", 10),
      async (req: Request<{username: string}>, res: Response) => {
        try {
          if(req.files) {
            console.log(req.body);
            const username = req.body.username;
            if(!username) throw new Error("Username is required.");

            const uploader = req.body.uploader;
            if(!uploader) throw new Error("Uploader is required.");

            const files = req.files as Express.Multer.File[];
            if(!files || files.length === 0) {
              throw new Error("No files uploaded.");
            }

            const savedFiles = files.map((file) => ({
              originalName: file.originalname,
              storedName: file.filename,
              mimeType: file.mimetype,
              size: file.size,
              path: file.path,
              extension: path.extname(file.originalname),
              download: `${username}/documents/${file.filename}`,
              URL: `${req.protocol}://${req.get(
                "host"
              )}/uploads/${username}/documents/${file.filename}`,
              uploader: uploader,
            }));

            // Check if username exists in DB
            let doc = await UserDocument.findOne({username});

            if(doc) {
              // Append new files
              doc.files.push(...savedFiles);
            } else {
              // Create new document
              doc = new UserDocument({
                username,
                files: savedFiles,
              });
            }

            const save = await doc.save();
            if(save) {
              res.status(200).json({
                status: "success",
                message: "Files uploaded and saved successfully.",
                fileCount: files.length,
                uploadedFiles: savedFiles,
              });
            } else {
              throw new Error("Failed to save files.");
            }
          } else {
            throw new Error("Files are required.");
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
      "/user-delete/:username",
      async (req: Request<{username: string}>, res: Response) => {
        try {
          const username = req.params.username?.trim();
          if(!username) {
            throw new Error("Username is required");
          }
          const user = await UserModel.findOne({username});

          const recycalBinPath = path.join(
            __dirname,
            `../../public/recyclebin/users/${username}/`
          );

          const userImage = path.join(
            __dirname,
            `../../public/users/${username}/`
          );

          const userFiles = path.join(
            __dirname,
            `../../public/uploads/${username}/`
          );

          await fs.mkdir(recycalBinPath, {recursive: true});

          // Save user data as JSON in recycle bin if user exists
          if(user) {
            const userJsonPath = path.join(recycalBinPath, "user.json");
            fs.writeFileSync(
              userJsonPath,
              JSON.stringify(user.toObject ? user.toObject() : user, null, 2),
              "utf-8"
            );
          }

          if(fs.existsSync(userImage)) {
            await fs.copy(userImage, path.join(recycalBinPath, "user-image"));
            fs.rmSync(userImage, {recursive: true});
          }

          if(fs.existsSync(userFiles)) {
            await fs.copy(
              userFiles,
              path.join(recycalBinPath, "user-documents")
            );
            fs.rmSync(userFiles, {recursive: true});
          }

          // Update owner and addedBy references
          await PropertyModel.updateMany(
            {owner: username},
            {$unset: {owner: 1}}
          );
          await PropertyModel.updateMany(
            {"addedBy.username": username},
            {$unset: {addedBy: {}}}
          );

          // Delete user
          const deleteUser = await UserModel.findOneAndDelete({username});

          if(deleteUser) {
            res.status(200).json({
              status: "success",
              message: "User deleted successfully",
            });
          } else {
            throw new Error("User not found");
          }
        } catch(error) {
          if(error instanceof Error) {
            console.error(error.message);
            res.status(500).json({status: "error", message: error.message});
          }
        }
      }
    );
  }
  //<============= END DELETE USER BY USERNAME =============>
}
