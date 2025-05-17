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
import { UserDocument } from "../models/file-upload.model";
import { UserModel } from "../models/user.model";
import fs from "fs";
import path from "path";

dotenv.config();

export default class Tracking {
  private router: express.Router;
  constructor() {
    this.router = express.Router();
    this.trackLoggedUserLogin();
    this.getLoggedUserTracking();
    this.getAllUserLoginCounts();
    this.getUserFileActivity();
    this.getCreatedUsersBasedOnCreator();
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
              status: "error",
              message: "Invalid date format",
            });
          }

          const userLogDir = path.join(
            __dirname,
            `../../public/logs/${username}`
          );
          const logPath = path.join(userLogDir, `user-login.log`);
          const logEntry = `[User: ${username} | IP: ${normalizedIp} | Date: ${parsedDate.toISOString()}]\n`;

          // Ensure the directory exists
          fs.mkdir(userLogDir, { recursive: true }, (dirErr) => {
            if (dirErr) {
              return res.status(500).json({
                status: "error",
                message: "Failed to create log directory",
              });
            }

            // Append to log file
            fs.appendFile(logPath, logEntry, (writeErr) => {
              if (writeErr) {
                return res.status(500).json({
                  status: "error",
                  message: writeErr.message,
                });
              }

              return res.status(200).json({
                status: "success",
                message: "User login tracked successfully",
              });
            });
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
      async (req: Request, res: Response) => {
        try {
          const { username, start, limit } = req.params;
          const { startDate, endDate } = req.query;

          if (!username || !start || !limit) {
            throw new Error("Parameter data is missing!");
          }

          const safeStart = Math.max(0, parseInt(start));
          const safeLimit = Math.max(1, parseInt(limit));
          const startDt = startDate ? new Date(startDate as string) : null;
          const endDt = endDate ? new Date(endDate as string) : null;
          if (endDt) endDt.setHours(23, 59, 59, 999);

          const logsRoot = path.join(__dirname, "../../public/logs");

          // Function to parse a user's log file
          const parseUserLogs = (username: string) => {
            const filePath = path.join(logsRoot, username, "user-login.log");
            if (!fs.existsSync(filePath)) return [];

            const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
            return lines
              .map((line) => {
                const parts = line.match(
                  /\[User: (.*?) \| IP: (.*?) \| Date: (.*?)\]/
                );
                if (!parts || parts.length < 4) return null;
                const date = new Date(parts[3]);
                return { username: parts[1], ip: parts[2], date };
              })
              .filter((entry) => {
                if (!entry) return false;
                if (startDt && entry.date < startDt) return false;
                if (endDt && entry.date > endDt) return false;
                return true;
              }) as { username: string; ip: string; date: Date }[];
          };

          // 1. User-specific tracking
          const userLogs = parseUserLogs(username);
          const userTotalCount = userLogs.length;
          const userPagedData = userLogs
            .sort((a, b) => b.date.getTime() - a.date.getTime())
            .slice(safeStart, safeStart + safeLimit);

          const userTrackingData = {
            username,
            totalCount: userTotalCount,
            data: userPagedData,
          };

          // 2. All users' login counts
          const userDirs = fs
            .readdirSync(logsRoot, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => dirent.name);

          const allUsersLoginCounts = userDirs
            .map((user) => {
              const entries = parseUserLogs(user);
              return { username: user, loginCount: entries.length };
            })
            .sort((a, b) => b.loginCount - a.loginCount);

          // 3. Total login count
          const totalLoginCount = allUsersLoginCounts.reduce(
            (sum, u) => sum + u.loginCount,
            0
          );

          // Send response
          res.status(200).json({
            status: "success",
            message: "Tracking and summary retrieved successfully",
            data: {
              userTrackingData,
              allUsersLoginCounts,
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
      async (req: Request, res: Response) => {
        try {
          const { startDate, endDate } = req.query;
          const start = startDate ? new Date(startDate as string) : null;
          const end = endDate ? new Date(endDate as string) : null;
          if (end) end.setHours(23, 59, 59, 999);

          const logsRoot = path.join(__dirname, "../../public/logs");

          // Helper: read and filter a user's login log
          const readUserLog = (username: string) => {
            const filePath = path.join(logsRoot, username, "user-login.log");
            if (!fs.existsSync(filePath)) return [];

            const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
            return lines
              .map((line) => {
                const match = line.match(
                  /\[User: (.*?) \| IP: (.*?) \| Date: (.*?)\]/
                );
                if (!match) return null;
                const date = new Date(match[3]);
                if (start && date < start) return null;
                if (end && date > end) return null;
                return { username: match[1], date };
              })
              .filter(Boolean) as { username: string; date: Date }[];
          };

          // Loop through all user directories
          const userDirs = fs
            .readdirSync(logsRoot, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => dirent.name);

          const users: { username: string; loginCount: number }[] = [];
          let totalLoginCount = 0;

          for (const user of userDirs) {
            const entries = readUserLog(user);
            if (entries.length > 0) {
              users.push({ username: user, loginCount: entries.length });
              totalLoginCount += entries.length;
            }
          }

          res.status(200).json({
            status: "success",
            message: "All user login counts retrieved successfully",
            data: {
              users,
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

  private getUserFileActivity() {
    this.router.get(
      "/user-file-management-activity/:username/:start/:limit",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { username, start, limit } = req.params;
          const { startDate, endDate } = req.query;

          const safeStart = Math.max(0, parseInt(start));
          const safeLimit = Math.min(100, parseInt(limit));

          const dateFilter: any = {};
          if (startDate) dateFilter.$gte = new Date(startDate as string);
          if (endDate) dateFilter.$lte = new Date(endDate as string);

          // Shared match criteria
          const matchStage: any = { "files.uploader": username };
          if (startDate || endDate) {
            matchStage["files.uploadDate"] = dateFilter;
          }

          // Aggregation using $facet
          const results = await UserDocument.aggregate([
            { $unwind: "$files" },
            { $match: matchStage },
            {
              $facet: {
                totalCount: [{ $count: "count" }],
                paginatedData: [
                  { $sort: { "files.uploadDate": -1 } },
                  { $skip: safeStart },
                  { $limit: safeLimit },
                  {
                    $project: {
                      _id: 0,
                      username: 1,
                      originalName: "$files.originalName",
                      storedName: "$files.storedName",
                      mimeType: "$files.mimeType",
                      size: "$files.size",
                      path: "$files.path",
                      URL: "$files.URL",
                      extension: "$files.extension",
                      download: "$files.download",
                      uploader: "$files.uploader",
                      uploadDate: "$files.uploadDate",
                    },
                  },
                ],
              },
            },
          ]);

          const total = results[0]?.totalCount[0]?.count || 0;
          const data = results[0]?.paginatedData || [];

          res.status(200).json({
            status: "success",
            message: data.length
              ? "User file activity retrieved successfully"
              : "No matching records found",
            data: {
              totalCount: total,
              data: data,
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

  private getCreatedUsersBasedOnCreator() {
    this.router.get(
      "/get-created-users-based-on-creator/:username/:start/:limit",
      async (req: Request, res: Response) => {
        try {
          const { username, start, limit } = req.params;
          const { startDate, endDate } = req.query;

          // Validate and sanitize input
          if (!username) {
            throw new Error("Username cannot be empty");
          }

          const safeStart = Math.max(0, parseInt(start));
          const safeLimit = Math.min(100, parseInt(limit));

          // Build date filter
          const dateFilter: any = {};
          if (startDate) dateFilter.$gte = new Date(startDate as string);
          if (endDate) {
            const end = new Date(endDate as string);
            end.setHours(23, 59, 59, 999);
            dateFilter.$lte = end;
          }

          // Build match stage
          const matchStage: any = { creator: username };
          if (startDate || endDate) {
            matchStage.createdAt = dateFilter;
          }

          // Aggregate with pagination and count
          const results = await UserModel.aggregate([
            { $match: matchStage },
            {
              $facet: {
                totalCount: [{ $count: "count" }],
                paginatedData: [
                  { $sort: { createdAt: -1 } },
                  { $skip: safeStart },
                  { $limit: safeLimit },
                  {
                    $project: {
                      _id: 0,
                      name: 1,
                      username: 1,
                      email: 1,
                      dateOfBirth: 1,
                      age: 1,
                      gender: 1,
                      image: 1,
                      phoneNumber: 1,
                      role: 1,
                      isActive: 1,
                      creator: 1,
                      createdAt: 1,
                      updatedAt: 1,
                    },
                  },
                ],
              },
            },
          ]);

          const total = results[0]?.totalCount[0]?.count || 0;
          const data = results[0]?.paginatedData || [];

          res.status(200).json({
            status: "success",
            message: data.length
              ? "Users retrieved successfully"
              : "No matching records found",
            data: {
              totalCount: total,
              data: data,
            },
          });
        } catch (error) {
          console.error("Error:", error);
          res.status(500).json({
            status: "error",
            message: "Internal Server Error: " + (error as Error).message,
          });
        }
      }
    );
  }
}
