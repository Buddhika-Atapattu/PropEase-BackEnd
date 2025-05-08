import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import * as path from "path";
import * as fs from "fs-extra";
import { UserModel, IUser } from "../models/user.model";
import * as Argon2 from "argon2";
import multer from "multer";
import sharp from "sharp";
import os from "os";

export interface Address {
  street: string;
  houseNumber: string;
  city: string;
  postcode: string;
  country?: string;
  stateOrProvince?: string;
}

export interface Roles {
  role: "admin" | "agent" | "tenant" | "operator" | "developer" | "user";
}

export interface NewUser {
  firstName: string;
  middleName?: string;
  lastName: string;
  username: string;
  email: string;
  password: string;
  age: number;
  image?: string | File;
  phoneNumber?: string;
  role: Roles;
  address: Address;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NewAgent = new UserModel({
  firstName: "Gamin",
  middleName: "",
  lastName: "Atapattu",
  username: "agent",
  email: "agent@example.com",
  password: "gamini1234",
  age: 28,
  image:
    "https://images.unsplash.com/photo-1560250097-0b93528c311a?w=600&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8MTF8fHVzZXJ8ZW58MHx8MHx8fDA%3D",
  phoneNumber: "+94771234568",
  role: { role: "agent" },
  address: {
    street: "Maple Street",
    houseNumber: "42B",
    city: "New York",
    postcode: "10001",
    country: "USA",
    stateOrProvince: "NY",
  },
  isActive: true,
});

export default class UserRoute {
  private router: express.Router;
  constructor() {
    this.router = express.Router();
    this.createUser();
    this.getAllUsers();
    this.getUserData();
    this.updateUser();
  }

  get route(): Router {
    return this.router;
  }

  private async hashPassword(password: string): Promise<string> {
    return await Argon2.hash(password);
  }

  private getUserData() {
    this.router.post(
      "/verify-user",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          console.log(req.body);
          const user: IUser | null = await UserModel.findOne({
            username: req.body.username,
          });

          console.log(user);

          if (user !== null) {
            const isPasswordValid = await Argon2.verify(
              user.password,
              req.body.password
            );
            if (isPasswordValid) {
              const plainUser = user.toObject ? user.toObject() : user; // fallback if toObject() doesn't exist
              const { password, ...userWithoutPassword } = plainUser;
              res.status(200).json(userWithoutPassword);
            } else {
              res.status(401).json({ error: "Invalid password" });
            }
          } else {
            res.status(401).json({ error: "Invalid username" });
          }
        } catch (error) {
          res
            .status(500)
            .json({ error: "Error getting user data", details: error });
          next(error);
        }
      }
    );
  }

  private createUser(): Promise<void> {
    this.router.post(
      "/create-user",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const newUser: IUser = new UserModel(req.body);
          const existingUser = await UserModel.findOne({
            username: req.body.username,
          });
          if (existingUser) {
            console.log("User already exists:", existingUser);
            return; // Exit early if the user already exists
          } else {
            const savedUser = await newUser.save();
            console.log(req.body);
            res.status(201).json(savedUser);
          }
        } catch (error) {
          res
            .status(500)
            .json({ error: "Failed to create user", details: error });
          next(error);
        }
      }
    );
    return Promise.resolve();
  }

  private getAllUsers() {
    this.router.get("/users", async (req: Request, res: Response) => {
      try {
        const users = await UserModel.find({});
        if (users.length === 0) {
          throw new Error("No users found");
        } else {
          res.status(201).json(users);
        }
      } catch (error) {
        res.status(500).json({ error: `Failed to fetch users: ${error}` });
      }
    });
  }

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
        if (allowedTypes.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error("Only image files are allowed"));
        }
      },
    });

    this.router.put(
      "/user-update/:username",
      upload.fields([{ name: "userimage", maxCount: 1 }]),
      async (
        req: Request<{ username: string }>,
        res: Response,
        next: NextFunction
      ) => {
        try {
          const username = req.params.username;
          if (!username) throw new Error("Invalid username");

          const files = req.files as {
            [fieldname: string]: Express.Multer.File[];
          };

          const image = files?.userimage?.[0];
          if (image) {
            // Create user-specific directory
            const userDir = path.join(
              __dirname,
              "../../public/users",
              username
            );
            const imagePath = path.join(userDir, "image.webp");

            fs.mkdirSync(userDir, { recursive: true });

            // Convert and save image as .webp
            const imagetoWebp = await sharp(image.buffer)
              .webp({ quality: 80 })
              .toFile(imagePath);
            if (imagetoWebp) {
              const host = req.get("host");
              const protocol = req.protocol;
              const baseUrl = `${protocol}://${host}`;
              console.log(baseUrl);
              const publicPath = `${baseUrl}/users/${username}/image.webp`;

              const updatedUser = await UserModel.findOneAndUpdate(
                { username }, // filter
                {
                  $set: {
                    firstName: req.body.firstname,
                    middleName: req.body.middlename,
                    lastName: req.body.lastname,
                    email: req.body.email,
                    age: req.body.age,
                    image: publicPath,
                    phoneNumber: req.body.phone,
                    role: { role: req.body.role },
                    address: {
                      street: req.body.street,
                      houseNumber: req.body.houseNumber,
                      city: req.body.city,
                      postcode: req.body.postcode,
                      country: req.body.country,
                      stateOrProvince: req.body.stateOrProvince,
                    },
                    isActive: req.body.isActive,
                    updatedAt: req.body.updatedAt,
                    dateOfBirth: req.body.dateOfBirth,
                  },
                },
                {
                  new: true, // Return the updated user
                  upsert: false, // Don't insert if the user doesn't exist
                }
              );

              if (!updatedUser) throw new Error("User not found in DB");

              res.status(200).json({
                status: "success",
                message: `Image saved and user updated for ${username}`,
                user: updatedUser,
              });
            } else {
              throw new Error("Failed to convert image");
            }
          } else {
            const updatedUser = await UserModel.findOneAndUpdate(
              { username }, // filter
              {
                $set: {
                  firstName: req.body.firstname,
                  middleName: req.body.middlename,
                  lastName: req.body.lastname,
                  email: req.body.email,
                  age: req.body.age,
                  phoneNumber: req.body.phone,
                  role: { role: req.body.role },
                  address: {
                    street: req.body.street,
                    houseNumber: req.body.houseNumber,
                    city: req.body.city,
                    postcode: req.body.postcode,
                    country: req.body.country,
                    stateOrProvince: req.body.stateOrProvince,
                  },
                  isActive: req.body.isActive,
                  updatedAt: req.body.updatedAt,
                  dateOfBirth: req.body.dateOfBirth,
                },
              },
              {
                new: true, // Return the updated user
                upsert: false, // Don't insert if the user doesn't exist
              }
            );

            if (!updatedUser) throw new Error("User not found in DB");

            res.status(200).json({
              status: "success",
              message: `User updated for ${username} without image`,
              user: updatedUser,
            });
          }
        } catch (error) {
          console.error("Error in updateUser:", error);
          res
            .status(500)
            .json({ status: "error", message: "Error: server side error..." });
        }
      }
    );
  }
}
