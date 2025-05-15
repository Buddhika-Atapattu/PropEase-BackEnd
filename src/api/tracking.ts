import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import {
  TrackingLoggedUserModel,
  LoggedUserTracking,
  LoggedUserActivities,
  LoggedUserActivitiesModel,
} from "../models/tracking.model";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

export default class Tracking {
  private router: express.Router;
  constructor() {
    this.router = express.Router();
    this.trackLoggedUserLogin();
    this.getLoggedUserTracking();
  }

  get route(): Router {
    return this.router;
  }

  private trackLoggedUserLogin() {
    this.router.post(
      "/track-logged-user-login",
      async (req: Request, res: Response, next: NextFunction): Promise<any> => {
        try {
          const ip =
            req.headers["x-forwarded-for"]?.toString().split(",")[0] ||
            req.socket.remoteAddress;
          const normalizedIp =
            ip === "::1" || ip === "127.0.0.1" ? "localhost" : ip;

          const { username, date } = req.body;

          if (!username || typeof username !== "string") {
            return res.status(400).json({
              status: "fail",
              message: "Invalid or missing username",
            });
          }

          const parsedDate = date ? new Date(date) : new Date();
          if (isNaN(parsedDate.getTime())) {
            return res.status(400).json({
              status: "erro",
              message: "Invalid date format",
            });
          }

          const update = await TrackingLoggedUserModel.findOneAndUpdate(
            { username },
            {
              $push: {
                data: {
                  ip_address: normalizedIp,
                  date: parsedDate,
                },
              },
            },
            { new: true, upsert: true } // upsert creates new doc if not found
          );

          return res.status(200).json({
            status: "success",
            message: "User tracking updated or created",
            data: update,
          });
        } catch (error) {
          console.error("Error:", error);
          return res.status(500).json({
            status: "error",
            message: "Internal Server Error: " + error,
          });
        }
      }
    );
  }

  private getLoggedUserTracking() {
    this.router.get(
      "/get-logged-user-tracking/:username/:start/:limit",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { username, start, limit } = req.params;
          const { startDate, endDate } = req.query;

          // Validate presence
          if (!username || !start || !limit) {
            throw new Error("Parameter data is missing!");
          }

          // Safe numeric conversion
          const safeStart = Math.max(0, parseInt(start));
          const safeLimit = Math.max(1, parseInt(limit));

          // Build date filter if applicable
          const dateFilter: any = {};
          if (startDate) dateFilter.$gte = new Date(startDate as string);
          if (endDate) dateFilter.$lte = new Date(endDate as string);

          // Aggregate pipeline
          const tracking = await TrackingLoggedUserModel.aggregate([
            { $match: { username } },
            { $unwind: "$data" },
            {
              $match: {
                ...(startDate || endDate ? { "data.date": dateFilter } : {}),
              },
            },
            { $sort: { "data.date": -1 } },
            {
              $group: {
                _id: "$username",
                username: { $first: "$username" },
                totalCount: { $sum: 1 },
                data: { $push: "$data" },
              },
            },
            {
              $project: {
                username: 1,
                totalCount: 1,
                data: {
                  $slice: ["$data", safeStart, safeLimit],
                },
              },
            },
          ]);

          if (!tracking || tracking.length === 0)
            throw new Error("No tracking data found");

          res.status(200).json({
            status: "success",
            message: "Tracking retrieved successfully",
            data: tracking[0],
          });
        } catch (error) {
          console.error("Error:", error);
          res.status(500).json({
            status: "error",
            message: "Internal Server Error: " + error,
          });
        }
      }
    );
  }
}
