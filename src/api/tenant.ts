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
import {ITenant, TenantModel} from "../models/tenant.model";
import {LeaseModel, LeaseType} from "../models/lease.model";
import Lease from "./lease";
import NotificationService from '../services/notification.service';
import {UserModel} from "../models/user.model";

dotenv.config();

export default class Tenant {
  private router: express.Router;

  constructor () {
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

          if(!username) {
            throw new Error("Username required!");
          }
          if(!req.body.name) {
            throw new Error("Name required!");
          }
          if(!req.body.image) {
            throw new Error("Image required!");
          }
          if(!req.body.phoneNumber) {
            throw new Error("Phone number required!");
          }
          if(!req.body.email) {
            throw new Error("Email required!");
          }
          if(!req.body.gender) {
            throw new Error("Gender required!");
          }
          if(!req.body.addedBy) {
            throw new Error("Added by required!");
          }

          const recyclebi = path.join(
            __dirname,
            `../../public/recyclebin/tenants/${username}/`
          );

          if(fs.existsSync(recyclebi)) {
            fs.promises.rm(recyclebi, {recursive: true});
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

          if(tenant) {
            // Notification for new tenant added
            const notificationService = new NotificationService();
            const io = req.app.get('io'); // Get Socket.IO instance from app
            await notificationService.createNotification(
              {
                title: 'New Tenant',
                body: `A new tenant named ${tenant.name} has been added.`,
                type: 'create',          // OK (your entity allows custom strings)
                severity: 'info',
                audience: {mode: 'role', roles: ['admin', 'agent', 'manager', 'operator'], usernames: [tenant.username]}, // notify all admins and agents
                channels: ['inapp', 'email'], // keep if you'll email later; harmless otherwise
                metadata: {tenantData: data, addedDate: new Date().toISOString(), addedBy: tenant.addedBy},
                // DO NOT send createdAt here; NotificationService sets it
              },
              // Real-time emit callback: send to each audience room
              (rooms, payload) => {
                rooms.forEach((room) => {
                  io.to(room).emit('notification.new', payload);
                });
              }
            );

            // Respond with success
            res.status(200).json({
              status: "success",
              message: "Tenant added successfully",
              data: tenant,
            });
          } else {
            throw new Error("Failed to add tenant!");
          }
        } catch(error) {
          if(error) {
            console.log(error);
            res
              .status(500)
              .json({status: "error", message: "Error: " + error});
          }
        }
      }
    );
  }

  private getAllTenants() {
    this.router.get("/get-all-tenants", async (req: Request, res: Response) => {
      try {
        const tenants = await TenantModel.find();
        if(tenants) {
          res.status(200).json({
            status: "success",
            message: "Tenants fetched successfully",
            data: tenants,
          });
        } else {
          throw new Error("No tenants found");
        }
      } catch(error) {
        if(error) {
          console.log(error);
          res.status(500).json({status: "error", message: "Error: " + error});
        }
      }
    });
  }

  private deleteTenant() {
    this.router.delete(
      "/delete-tenant/:username/:deletor",
      async (req: Request<{username: string, deletor: string}>, res: Response) => {
        try {
          const {username, deletor} = req.params;
          if(!username) throw new Error("Username required!");
          if(!deletor) throw new Error("Deletor required!");


          const userData = await TenantModel.findOne({username});
          if(!userData) throw new Error("Tenant not found!");

          const deletorData = await UserModel.findOne({username: deletor});
          if(!deletorData) throw new Error("Deletor not found!");

          const leases = await LeaseModel.find({
            "tenantInformation.tenantUsername": username,
          });

          const today = new Date().toISOString().split("T")[0];
          const insertUserData = {today, data: userData};

          const recyclebin = path.join(__dirname, `../../public/recyclebin/tenants/${username}`);
          const userDataPath = path.join(recyclebin, "userData.json");
          await fs.promises.mkdir(recyclebin, {recursive: true});

          // Save userData
          if(fs.existsSync(userDataPath)) {
            const existingData = JSON.parse(await fs.promises.readFile(userDataPath, "utf-8"));
            existingData.push(insertUserData);
            await fs.promises.writeFile(userDataPath, JSON.stringify(existingData, null, 2));
          } else {
            await fs.promises.writeFile(userDataPath, JSON.stringify([insertUserData], null, 2));
          }

          if(leases.length > 0) {
            const leaseRecyclebin = path.join(recyclebin, "leases");
            await fs.promises.mkdir(leaseRecyclebin, {recursive: true});

            const leaseSavePath = path.join(leaseRecyclebin, "leasesDB.json");

            // Save lease data
            if(fs.existsSync(leaseSavePath)) {
              const existingLeases = JSON.parse(await fs.promises.readFile(leaseSavePath, "utf-8"));
              const merged = Array.isArray(existingLeases) ? [...existingLeases, ...leases] : leases;
              await fs.promises.writeFile(leaseSavePath, JSON.stringify(merged, null, 2));
            } else {
              await fs.promises.writeFile(leaseSavePath, JSON.stringify(leases, null, 2));
            }

            for(const lease of leases) {
              const leaseID = lease.leaseID;

              const currentRoot = path.join(__dirname, `../../public/lease/${leaseID}`);
              const destRoot = path.join(leaseRecyclebin, `${today}_${leaseID}`);

              const pathsToMove = [
                {
                  from: path.join(currentRoot, `agreement-data/${leaseID}.json`),
                  to: path.join(destRoot, `agreement-data/${today}_${leaseID}.json`)
                },
                {
                  from: path.join(currentRoot, `documents`),
                  to: path.join(destRoot, `${today}_documents`)
                },
                {
                  from: path.join(currentRoot, `signatures/landlord`),
                  to: path.join(destRoot, `${today}_signatures/landlord`)
                },
                {
                  from: path.join(currentRoot, `signatures/tenant`),
                  to: path.join(destRoot, `${today}_signatures/tenant`)
                }
              ];

              for(const {from, to} of pathsToMove) {
                if(fs.existsSync(from)) {
                  await fs.promises.mkdir(path.dirname(to), {recursive: true});
                  try {
                    await fs.promises.rename(from, to);
                  } catch(e) {
                    console.warn(`Failed to move from ${from} to ${to}:`, e);
                  }
                } else {
                  console.warn(`Skipped move: Source path does not exist → ${from}`);
                }
              }
            }

            const deleteResult = await LeaseModel.deleteMany({
              "tenantInformation.tenantUsername": username,
            });

            if(deleteResult.deletedCount === 0) {
              throw new Error("Failed to delete leases from database!");
            }
          }

          const organisedMedataData: any = {
            deletor: deletorData,
            deletedDataPath: recyclebin,
            deletedDate: new Date().toISOString(),
            deletedTenantData: userDataPath,
            deletedLeasesData: leases.length > 0 ? path.join(recyclebin, "leases", "leasesDB.json") : null,
          }

          // Finally, delete the tenant 
          // Notification for tenant deletion
          const notificationService = new NotificationService();
          const io = req.app.get('io'); // Get Socket.IO instance from app  
          await notificationService.createNotification(
            {
              title: 'Delete Tenant',
              body: `Tenant ${username} has been deleted.`,
              type: 'delete',          // OK (your entity allows custom strings)
              severity: 'warning',
              audience: {mode: 'role', roles: ['admin', 'agent', 'manager', 'operator']}, // notify all admins
              channels: ['inapp', 'email'], // keep if you'll email later; harmless otherwise
              metadata: {data: organisedMedataData},
              // DO NOT send createdAt here; NotificationService sets it  
            },
            // Real-time emit callback: send to each audience room
            (rooms, payload) => {
              rooms.forEach((room) => {
                io.to(room).emit('notification.new', payload);
              });
            }
          );


          await TenantModel.findOneAndDelete({username});


          res.status(200).json({
            status: "success",
            message: "Tenant and all related lease records have been successfully removed.",
          });
        } catch(error) {
          console.error("Error deleting tenant:", error);
          let message = "Unexpected error occurred during tenant deletion.";
          if(error instanceof Error) message = error.message;
          else if(typeof error === "string") message = error;

          res.status(500).json({
            status: "error",
            message,
          });
        }
      }
    );
  }
}
