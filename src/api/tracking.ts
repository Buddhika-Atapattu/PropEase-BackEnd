import express, {Express, Request, Response, NextFunction, Router} from "express";
import {
  TrackingLoggedUserModel,
  LoggedUserTracking,
  LoggedUserActivities,
  LoggedUserActivitiesModel,
} from "../models/tracking.model";
import crypto from "crypto";
import dotenv from "dotenv";
import {UserDocument} from "../models/file-upload.model";
import {UserModel} from "../models/user.model";
import fs from "fs";
import path from "path";

dotenv.config();

/* -----------------------------------------------------------------------------
 * Helpers (strict-safe parsing & date utilities)
 * -------------------------------------------------------------------------- */

/** Parse a possibly-undefined string into an integer with default & clamping. */
function toInt(v: string | undefined, def = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number.parseInt(v ?? "", 10);
  if(Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Parse a date string into a Date; returns null if invalid or undefined. */
function toDate(v: unknown): Date | null {
  if(typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Get end-of-day (23:59:59.999) for a Date; returns null if input null. */
function endOfDay(d: Date | null): Date | null {
  if(!d) return null;
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

/** Normalize IPv6 localhost & loopback to 'localhost'. */
function normalizeIp(ip: string | undefined | null): string {
  if(!ip) return "unknown";
  const trimmed = ip.trim();
  return trimmed === "::1" || trimmed === "127.0.0.1" ? "localhost" : trimmed;
}

export default class Tracking {
  private router: express.Router;

  constructor () {
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

  /* -----------------------------------------------------------------------------
   * POST /track-logged-user-login
   * Writes per-user login entries into public/logs/<username>/user-login.log
   * -------------------------------------------------------------------------- */
  private trackLoggedUserLogin() {
    this.router.post(
      "/track-logged-user-login",
      async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
        try {
          const ipHeader = req.headers["x-forwarded-for"]?.toString().split(",")[0];
          const ip = normalizeIp(ipHeader ?? req.socket.remoteAddress ?? undefined);

          const {username, date} = req.body as {username?: unknown; date?: unknown};

          if(!username || typeof username !== "string" || !username.trim()) {
            res.status(400).json({status: "fail", message: "Invalid or missing username"});
            return;
          }

          const parsedDate = typeof date === "string" ? toDate(date) : new Date();
          if(parsedDate === null) {
            res.status(400).json({status: "error", message: "Invalid date format"});
            return;
          }

          const userLogDir = path.join(__dirname, `../../public/logs/${username}`);
          const logPath = path.join(userLogDir, `user-login.log`);
          const logEntry = `[User: ${username} | IP: ${ip} | Date: ${parsedDate.toISOString()}]\n`;

          // Ensure the directory exists then append
          fs.mkdir(userLogDir, {recursive: true}, (dirErr) => {
            if(dirErr) {
              res.status(500).json({status: "error", message: "Failed to create log directory"});
              return;
            }

            fs.appendFile(logPath, logEntry, (writeErr) => {
              if(writeErr) {
                res.status(500).json({status: "error", message: writeErr.message});
                return;
              }

              res.status(200).json({
                status: "success",
                message: "User login tracked successfully",
              });
            });
          });
        } catch(error) {
          console.error("Error:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  /* -----------------------------------------------------------------------------
   * GET /get-logged-user-tracking/:username/:start/:limit
   * Returns paged login entries for a user + per-user counts for all users.
   * Query: ?startDate=ISO&endDate=ISO
   * -------------------------------------------------------------------------- */
  private getLoggedUserTracking() {
    this.router.get(
      "/get-logged-user-tracking/:username/:start/:limit",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const {username, start, limit} = req.params;
          const {startDate, endDate} = req.query as {startDate?: string; endDate?: string};

          if(!username || !start || !limit) {
            res.status(400).json({status: "error", message: "Parameter data is missing!"});
            return;
          }

          const safeStart = Math.max(0, toInt(start, 0, 0));
          const safeLimit = Math.max(1, toInt(limit, 20, 1, 1000));

          const startDt = toDate(startDate);
          const endDt = endOfDay(toDate(endDate));

          const logsRoot = path.join(__dirname, "../../public/logs");

          // Parse a user's log file into entries while applying date filters
          const parseUserLogs = (name: string): {username: string; ip: string; date: Date}[] => {
            const filePath = path.join(logsRoot, name, "user-login.log");
            if(!fs.existsSync(filePath)) return [];

            const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
            const out: {username: string; ip: string; date: Date}[] = [];

            for(const line of lines) {
              const parts = line.match(/\[User: (.*?) \| IP: (.*?) \| Date: (.*?)\]/);
              if(!parts || parts.length < 4) continue;

              const uname = parts[1] ?? "";
              const ip = parts[2] ?? "";
              const dateStr = parts[3] ?? "";
              const date = toDate(dateStr);
              if(!date) continue;

              if(startDt && date < startDt) continue;
              if(endDt && date > endDt) continue;

              out.push({username: uname, ip, date});
            }

            return out;
          };

          // 1) Specific user tracking
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

          // 2) All users' login counts
          const logsRootExists = fs.existsSync(logsRoot);
          const userDirs = logsRootExists
            ? fs
              .readdirSync(logsRoot, {withFileTypes: true})
              .filter((dirent) => dirent.isDirectory())
              .map((dirent) => dirent.name)
            : [];

          const allUsersLoginCounts = userDirs
            .map((user) => {
              const entries = parseUserLogs(user);
              return {username: user, loginCount: entries.length};
            })
            .sort((a, b) => b.loginCount - a.loginCount);

          // 3) Total login count
          const totalLoginCount = allUsersLoginCounts.reduce((sum, u) => sum + u.loginCount, 0);

          res.status(200).json({
            status: "success",
            message: "Tracking and summary retrieved successfully",
            data: {
              userTrackingData,
              allUsersLoginCounts,
              totalLoginCount,
            },
          });
        } catch(error) {
          console.error("Error:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  /* -----------------------------------------------------------------------------
   * GET /get-all-users-login-counts
   * Summarize login counts for all users in logs directory
   * Query: ?startDate=ISO&endDate=ISO
   * -------------------------------------------------------------------------- */
  private getAllUserLoginCounts() {
    this.router.get(
      "/get-all-users-login-counts",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const {startDate, endDate} = req.query as {startDate?: string; endDate?: string};
          const start = toDate(startDate);
          const end = endOfDay(toDate(endDate));

          const logsRoot = path.join(__dirname, "../../public/logs");
          const logsRootExists = fs.existsSync(logsRoot);

          const readUserLog = (name: string): {username: string; date: Date}[] => {
            const filePath = path.join(logsRoot, name, "user-login.log");
            if(!fs.existsSync(filePath)) return [];

            const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
            const out: {username: string; date: Date}[] = [];

            for(const line of lines) {
              const match = line.match(/\[User: (.*?) \| IP: (.*?) \| Date: (.*?)\]/);
              if(!match || match.length < 4) continue;

              const dateStr = match[3] ?? "";
              const date = toDate(dateStr);
              if(!date) continue;

              if(start && date < start) continue;
              if(end && date > end) continue;

              out.push({username: match[1] ?? "", date});
            }

            return out;
          };

          const userDirs = logsRootExists
            ? fs
              .readdirSync(logsRoot, {withFileTypes: true})
              .filter((d) => d.isDirectory())
              .map((d) => d.name)
            : [];

          const users: {username: string; loginCount: number}[] = [];
          let totalLoginCount = 0;

          for(const user of userDirs) {
            const entries = readUserLog(user);
            if(entries.length > 0) {
              users.push({username: user, loginCount: entries.length});
              totalLoginCount += entries.length;
            }
          }

          res.status(200).json({
            status: "success",
            message: "All user login counts retrieved successfully",
            data: {users, totalLoginCount},
          });
        } catch(error) {
          console.error("Error:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  /* -----------------------------------------------------------------------------
   * GET /user-file-management-activity/:username/:start/:limit
   * Paged aggregation against UserDocument.files (uploader, time window)
   * Query: ?startDate=ISO&endDate=ISO
   * -------------------------------------------------------------------------- */
  private getUserFileActivity() {
    this.router.get(
      "/user-file-management-activity/:username/:start/:limit",
      async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
        try {
          const {username, start, limit} = req.params;
          const {startDate, endDate} = req.query as {startDate?: string; endDate?: string};

          // Pagination (strict-safe)
          const safeStart = Math.max(0, toInt(start, 0, 0));
          const safeLimit = Math.min(100, Math.max(1, toInt(limit, 20, 1, 100)));

          // Date filter (strict-safe)
          const startDt = toDate(startDate);
          const endDt = endOfDay(toDate(endDate));
          const dateFilter: Record<string, Date> = {};
          if(startDt) dateFilter.$gte = startDt;
          if(endDt) dateFilter.$lte = endDt;

          // Match criteria
          const matchStage: Record<string, any> = {"files.uploader": username};
          if(startDt || endDt) {
            matchStage["files.uploadDate"] = dateFilter;
          }

          // Aggregation using $facet for count + page
          const results = await UserDocument.aggregate([
            {$unwind: "$files"},
            {$match: matchStage},
            {
              $facet: {
                totalCount: [{$count: "count"}],
                paginatedData: [
                  {$sort: {"files.uploadDate": -1}},
                  {$skip: safeStart},
                  {$limit: safeLimit},
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

          const total = results[0]?.totalCount?.[0]?.count ?? 0;
          const data = results[0]?.paginatedData ?? [];

          res.status(200).json({
            status: "success",
            message: data.length ? "User file activity retrieved successfully" : "No matching records found",
            data: {totalCount: total, data},
          });
        } catch(error) {
          console.error("Error:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  /* -----------------------------------------------------------------------------
   * GET /get-created-users-based-on-creator/:username/:start/:limit
   * Returns users created by :username, filtered by optional date window.
   * Query: ?startDate=ISO&endDate=ISO
   * -------------------------------------------------------------------------- */
  private getCreatedUsersBasedOnCreator() {
    this.router.get(
      "/get-created-users-based-on-creator/:username/:start/:limit",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const {username, start, limit} = req.params;
          const {startDate, endDate} = req.query as {startDate?: string; endDate?: string};

          if(!username || !username.trim()) {
            res.status(400).json({status: "error", message: "Username cannot be empty"});
            return;
          }

          // Pagination (strict-safe)
          const safeStart = Math.max(0, toInt(start, 0, 0));
          const safeLimit = Math.min(100, Math.max(1, toInt(limit, 20, 1, 100)));

          // Date window
          const startDt = toDate(startDate);
          const endDt = endOfDay(toDate(endDate));
          const dateFilter: Record<string, Date> = {};
          if(startDt) dateFilter.$gte = startDt;
          if(endDt) dateFilter.$lte = endDt;

          // Match stage
          const matchStage: Record<string, any> = {creator: username};
          if(startDt || endDt) {
            matchStage.createdAt = dateFilter;
          }

          const results = await UserModel.aggregate([
            {$match: matchStage},
            {
              $facet: {
                totalCount: [{$count: "count"}],
                paginatedData: [
                  {$sort: {createdAt: -1}},
                  {$skip: safeStart},
                  {$limit: safeLimit},
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

          const total = results[0]?.totalCount?.[0]?.count ?? 0;
          const data = results[0]?.paginatedData ?? [];

          res.status(200).json({
            status: "success",
            message: data.length ? "Users retrieved successfully" : "No matching records found",
            data: {totalCount: total, data},
          });
        } catch(error) {
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
