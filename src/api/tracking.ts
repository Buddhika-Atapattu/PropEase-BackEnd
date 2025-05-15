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
    this.getAllUserLoginCounts();
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

          if (!username || !start || !limit) {
            throw new Error("Parameter data is missing!");
          }

          const safeStart = Math.max(0, parseInt(start));
          const safeLimit = Math.max(1, parseInt(limit));

          const dateFilter: any = {};
          if (startDate) dateFilter.$gte = new Date(startDate as string);
          if (endDate) {
            const end = new Date(endDate as string);
            end.setHours(23, 59, 59, 999); // include full end day
            dateFilter.$lte = end;
          }

          const matchDate =
            startDate || endDate
              ? [{ $match: { "data.date": dateFilter } }]
              : [];

          // Aggregate specific user data
          const userTrackingPipeline: import("mongoose").PipelineStage[] = [
            { $match: { username } },
            { $unwind: { path: "$data" } },
            ...matchDate,
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
                data: { $slice: ["$data", safeStart, safeLimit] },
              },
            },
          ];

          // Aggregate all users' total login counts
          const allUsersLoginPipeline: import("mongoose").PipelineStage[] = [
            { $unwind: { path: "$data" } },
            ...matchDate,
            {
              $group: {
                _id: "$username",
                username: { $first: "$username" },
                loginCount: { $sum: 1 },
              },
            },
            { $sort: { loginCount: -1 } },
          ];

          // Total login count of all users (optional)
          const totalCountPipeline: import("mongoose").PipelineStage[] = [
            { $unwind: { path: "$data" } },
            ...matchDate,
            {
              $group: {
                _id: null,
                totalLoginCount: { $sum: 1 },
              },
            },
          ];

          //  Execute in parallel
          const [userTracking, allUsersLogin, totalLoginResult] =
            await Promise.all([
              TrackingLoggedUserModel.aggregate(userTrackingPipeline),
              TrackingLoggedUserModel.aggregate(allUsersLoginPipeline),
              TrackingLoggedUserModel.aggregate(totalCountPipeline),
            ]);

          if (!userTracking || userTracking.length === 0) {
            throw new Error("No tracking data found");
          }

          const totalLoginCount = totalLoginResult[0]?.totalLoginCount || 0;

          res.status(200).json({
            status: "success",
            message: "Tracking and summary retrieved successfully",
            data: {
              userTrackingData: userTracking[0],
              allUsersLoginCounts: allUsersLogin,
              totalLoginCount,
            },
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

  //<============= GET ALL USER COUNT WITH LOGIN DATA COUNT ===============>
  private getAllUserLoginCounts() {
    this.router.get(
      "/get-all-users-login-counts",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { startDate, endDate } = req.query;

          const dateFilter: any = {};
          if (startDate) dateFilter.$gte = new Date(startDate as string);
          if (endDate) dateFilter.$lte = new Date(endDate as string);

          const matchStage: any = {};
          if (startDate || endDate) {
            matchStage["data.date"] = dateFilter;
          }

          const result = await TrackingLoggedUserModel.aggregate([
            { $unwind: "$data" },
            ...(Object.keys(matchStage).length > 0
              ? [{ $match: matchStage }]
              : []),
            {
              $group: {
                _id: "$username",
                username: { $first: "$username" },
                loginCount: { $sum: 1 },
              },
            },
            {
              $group: {
                _id: null,
                users: {
                  $push: {
                    username: "$username",
                    loginCount: "$loginCount",
                  },
                },
                totalLoginCount: { $sum: "$loginCount" },
              },
            },
            {
              $project: {
                _id: 0,
                users: 1,
                totalLoginCount: 1,
              },
            },
          ]);

          if (!result || result.length === 0) {
            throw new Error("No user login data found");
          }

          res.status(200).json({
            status: "success",
            message: "All user login counts retrieved successfully",
            data: result[0],
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
