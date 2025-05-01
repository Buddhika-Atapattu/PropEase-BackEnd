import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import * as path from "path";
import * as fs from "fs";
import { UserModel, IUser } from "../models/user.model";
import * as Argon2 from "argon2";

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

export interface NewUser extends Document {
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

export default class User {
  private router: Router;
  private users: IUser[] = [];

  constructor() {
    this.router = Router();
    this.createUser();
    this.getAllUsers();
    this.getUserData();
    // this.insertDummyUser(); // Insert dummy user immediately when server starts
  }

  private async hashPassword(password: string): Promise<string> {
    return await Argon2.hash(password);
  }

  private async getUserData(): Promise<void> {
    this.router.post(
      "/verify-user",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          console.log(req.body);
          const user: IUser | null = await UserModel.findOne({
            username: req.body.username,
          });

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
    return Promise.resolve();
  }

  // private async insertDummyUser() {
  //   try {
  //     // Check if the dummy user already exists in the database
  //     const existingUser = await UserModel.findOne({ username: "agent" });
  //     if (existingUser) {
  //       console.log("Dummy user already exists:", existingUser);
  //       return; // Exit early if the user already exists
  //     }

  //     // If the user does not exist, save the dummy user
  //     const savedUser = await NewAgent.save();
  //     if (savedUser) {
  //       console.log("Dummy user inserted:", savedUser);
  //     } else {
  //       console.log("Failed to insert dummy user");
  //     }
  //   } catch (error) {
  //     console.error("Error inserting dummy user:", error);
  //   }
  // }

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
        const users = await UserModel.find();
        res.json(users);
      } catch (error) {
        res
          .status(500)
          .json({ error: "Failed to fetch users", details: error });
      }
    });
  }

  get route(): Router {
    return this.router;
  }
}
