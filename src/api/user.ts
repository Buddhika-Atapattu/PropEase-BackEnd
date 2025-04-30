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

const dummyUser = new UserModel({
  firstName: "Buddhika",
  middleName: "Lahiru",
  lastName: "Atapattu",
  username: "admin",
  email: "alice@example.com",
  password: "admin1234",
  age: 28,
  image:
    "https://images.unsplash.com/photo-1633332755192-727a05c4013d?w=600&auto=format&fit=crop&q=60",
  phoneNumber: "+94771234567",
  role: { role: "admin" },
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
    // this.insertDummyUser(); // Insert dummy user immediately when server starts
  }

  // private async insertDummyUser() {
  //   try {
  //     const savedUser = await dummyUser.save();
  //     console.log("Dummy user inserted:", savedUser);
  //   } catch (error) {
  //     console.error("Failed to insert dummy user:", error);
  //   }
  // }

  private createUser() {
    this.router.post("/create-user", async (req: Request, res: Response) => {
      try {
        const newUser: IUser = new UserModel(req.body);
        const savedUser = await newUser.save();
        console.log(req.body);
        res.status(201).json(savedUser);
      } catch (error) {
        res
          .status(500)
          .json({ error: "Failed to create user", details: error });
      }
    });
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
