import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import multer from "multer";
import sharp from "sharp";
import { ITenant, TenantModel } from "../models/tenant.model";

dotenv.config();

export default class Tenant {
  private router: express.Router;

  constructor() {
    this.router = express.Router();
    this.insertTenant();
    this.getAllTenants();
    this.deleteTenant();
  }

  get route(): Router {
    return this.router;
  }

  private insertTenant() {
    const upload = multer();
    this.router.post(
      "/insertTenant",
      upload.none(),
      async (req: Request, res: Response) => {
        try {
          const username = req.body.username;

          if (!username) {
            throw new Error("Username required!");
          }
          if (!req.body.name) {
            throw new Error("Name required!");
          }
          if (!req.body.image) {
            throw new Error("Image required!");
          }
          if (!req.body.phoneNumber) {
            throw new Error("Phone number required!");
          }
          if (!req.body.email) {
            throw new Error("Email required!");
          }
          if (!req.body.gender) {
            throw new Error("Gender required!");
          }
          if (!req.body.addedBy) {
            throw new Error("Added by required!");
          }

          const recyclebi = path.join(
            __dirname,
            `../../public/recyclebin/tenants/${username}/`
          );

          if (fs.existsSync(recyclebi)) {
            fs.promises.rm(recyclebi, { recursive: true });
          }

          const data = {
            username: req.body.username,
            image: req.body.image,
            name: req.body.name,
            contactNumber: req.body.phoneNumber,
            email: req.body.email,
            gender: req.body.gender,
            addedBy: req.body.addedBy,
          };

          const tenant: ITenant = new TenantModel(data);
          await tenant.save();

          if (tenant) {
            res.status(200).json({
              status: "success",
              message: "Tenant added successfully",
              data: tenant,
            });
          } else {
            throw new Error("Failed to add tenant!");
          }
        } catch (error) {
          if (error) {
            console.log(error);
            res
              .status(500)
              .json({ status: "error", message: "Error: " + error });
          }
        }
      }
    );
  }

  private getAllTenants() {
    this.router.get("/get-all-tenants", async (req: Request, res: Response) => {
      try {
        const tenants = await TenantModel.find();
        if (tenants) {
          res.status(200).json({
            status: "success",
            message: "Tenants fetched successfully",
            data: tenants,
          });
        } else {
          throw new Error("No tenants found");
        }
      } catch (error) {
        if (error) {
          console.log(error);
          res.status(500).json({ status: "error", message: "Error: " + error });
        }
      }
    });
  }

  private deleteTenant() {
    this.router.delete(
      "/delete-tenant/:username",
      async (req: Request<{ username: string }>, res: Response) => {
        try {
          const { username } = req.params;
          if (!username) {
            throw new Error("Username required!");
          }

          const userData = await TenantModel.findOne({ username });

          const recyclebin = path.join(
            __dirname,
            `../../public/recyclebin/tenants/${username}/`
          );

          await fs.promises.mkdir(recyclebin, { recursive: true });

          const fileSavePath = path.join(
            __dirname,
            `../../public/recyclebin/tenants/${username}/userData.json`
          );

          await fs.promises.writeFile(fileSavePath, JSON.stringify(userData));

          if (userData) {
            const tenant = await TenantModel.findOneAndDelete({ username });
            if (tenant) {
              res.status(200).json({
                status: "success",
                message: "Tenant deleted successfully",
              });
            } else {
              throw new Error("Tenant not found!");
            }
          } else {
            throw new Error("Tenant not found!");
          }
        } catch (error) {
          if (error) {
            console.log("Error: ", error);
            res.status(500).json({
              status: "error",
              message: "Error deleting tenant: " + error,
            });
          }
        }
      }
    );
  }
}
