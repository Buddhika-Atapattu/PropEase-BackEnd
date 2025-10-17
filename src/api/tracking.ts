// src/api/tracking.ts
// ============================================================================
// Tracking Controller (helpers moved into class methods)
// ----------------------------------------------------------------------------
// WHAT THIS DOES:
// 1) Track logins
//    - Appends to a per-user text log: /public/logs/<username>/user-login.log
//    - Upserts MongoDB (TrackingLoggedUserModel) with IP + timestamp (+ sessionId)
//    - Returns a sessionId (uuid) usable to correlate activities
//
// 2) Summaries & Queries
//    - Paged read of a user's login entries + global login counts (from files)
//    - Global login counts (date-filtered)
//
// 3) Track Activities
//    - POST /track-activity → record user action (MongoDB LoggedUserActivitiesModel)
//    - GET /activities/:username/:start/:limit → paged activity history
//
// STYLE & SAFETY:
// - Strong input validation + safe pagination
// - IPv6 localhost normalization (::1 → "localhost")
// - Fully async fs APIs
// - All helpers are private class methods
// ============================================================================

import express, {Express, Request, Response, NextFunction, Router} from "express";
import {
  TrackingLoggedUserModel,
  LoggedUserActivitiesModel,
} from "../models/tracking.model";
import crypto from "crypto";
import dotenv from "dotenv";
import {UserDocument} from "../models/file-upload.model"; // used in file activity aggregation
import {UserModel} from "../models/user.model";
import fs from "fs";
import path from "path";

dotenv.config();

export default class Tracking {
  private readonly router: Router;

  constructor () {
    this.router = express.Router();

    // ROUTES
    this.trackLoggedUserLogin();            // POST /track-logged-user-login
    this.getLoggedUserTracking();           // GET  /get-logged-user-tracking/:username/:start/:limit
    this.getAllUserLoginCounts();           // GET  /get-all-users-login-counts
    this.getUserFileActivity();             // GET  /user-file-management-activity/:username/:start/:limit
    this.trackActivity();                   // POST /track-activity
    this.getActivitiesByUser();             // GET  /activities/:username/:start/:limit
    this.getCreatedUsersBasedOnCreator();   // GET  /get-created-users-based-on-creator/:username/:start/:limit
  }

  /** Expose the router to be mounted in the main app. */
  public get route(): Router {
    return this.router;
  }

  // ============================================================================
  // POST /track-logged-user-login
  // Writes to file log + upserts MongoDB. Returns sessionId for activity linkage.
  // ============================================================================
  private trackLoggedUserLogin(): void {
    this.router.post(
      "/track-logged-user-login",
      async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
        try {
          // Detect client IP (trust x-forwarded-for when behind proxy)
          const ipHeader = req.headers["x-forwarded-for"]?.toString().split(",")[0];
          const ip = this.normalizeIp(ipHeader ?? req.socket.remoteAddress ?? undefined);

          // Validate payload
          const {username, date} = req.body as {username?: unknown; date?: unknown};
          if(!username || typeof username !== "string" || !username.trim()) {
            res.status(400).json({status: "fail", message: "Invalid or missing username"});
            return;
          }

          // Parse date (allow manual override; otherwise use now)
          const parsedDate = typeof date === "string" ? this.toDate(date) : new Date();
          if(parsedDate === null) {
            res.status(400).json({status: "error", message: "Invalid date format"});
            return;
          }

          // Generate correlation id (session token) for this login
          const sessionId = crypto.randomUUID();

          // 1) Append to FILE LOG
          const {dir, file} = this.makeUserLogPaths(username);
          await fs.promises.mkdir(dir, {recursive: true});
          const logEntry = `[User: ${username} | IP: ${ip} | Date: ${new Date(parsedDate).toISOString()} | Session: ${sessionId}]\n`;
          await fs.promises.appendFile(file, logEntry);

          // 2) Upsert into MongoDB audit
          await TrackingLoggedUserModel.updateOne(
            {username},
            {
              $push: {
                data: {
                  ip_address: ip,
                  date: parsedDate,
                  // Keep sessionId as an extra field in Mongo
                  // @ts-ignore
                  sessionId,
                },
              },
            },
            {upsert: true}
          );

          res.status(200).json({
            status: "success",
            message: "User login tracked successfully",
            data: {username, ip, sessionId, date: parsedDate},
          });
        } catch(error) {
          console.error("Error /track-logged-user-login:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  // ============================================================================
  // GET /get-logged-user-tracking/:username/:start/:limit
  // Returns paged login entries from FILE logs + global counts (from files).
  // Query: ?startDate=ISO&endDate=ISO
  // ============================================================================
  private getLoggedUserTracking(): void {
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

          const safeStart = Math.max(0, this.toInt(start, 0, 0));
          const safeLimit = Math.max(1, this.toInt(limit, 20, 1, 1000));
          const startDt = this.toDate(startDate);
          const endDt = this.endOfDay(this.toDate(endDate));

          const logsRoot = path.join(__dirname, "../../public/logs");

          // Parse a user's log file into entries while applying date filters
          const parseUserLogs = (name: string): {username: string; ip: string; date: Date; session?: string}[] => {
            const filePath = path.join(logsRoot, name, "user-login.log");
            if(!fs.existsSync(filePath)) return [];

            const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
            const out: {username: string; ip: string; date: Date; session?: string}[] = [];

            for(const line of lines) {
              const parts =
                line.match(/\[User: (.*?) \| IP: (.*?) \| Date: (.*?) \| Session: (.*?)\]/) ||
                line.match(/\[User: (.*?) \| IP: (.*?) \| Date: (.*?)\]/);

              if(!parts || parts.length < 4) continue;

              const uname = parts[1] ?? "";
              const ip = parts[2] ?? "";
              const dateStr = parts[3] ?? "";
              const date = this.toDate(dateStr);
              if(!date) continue;

              if(startDt && date < startDt) continue;
              if(endDt && date > endDt) continue;

              const session = parts[4];

              if(uname !== username) continue;
              if(ip !== this.normalizeIp(ip)) continue;
              if(!session) continue;

              out.push({username: uname, ip, date, session});
            }

            return out;
          };

          // 1) Specific user tracking (from file logs)
          const userLogs = parseUserLogs(username);
          const userTotalCount = userLogs.length;
          const userPagedData = userLogs
            .sort((a, b) => b.date.getTime() - a.date.getTime())
            .slice(safeStart, safeStart + safeLimit);

          const userTrackingData = {username, totalCount: userTotalCount, data: userPagedData};

          // 2) All users' login counts (from file logs)
          const logsRootExists = fs.existsSync(logsRoot);
          const userDirs = logsRootExists
            ? fs.readdirSync(logsRoot, {withFileTypes: true}).filter((d) => d.isDirectory()).map((d) => d.name)
            : [];

          const allUsersLoginCounts = userDirs
            .map((user) => {
              const entries = parseUserLogs(user);
              return {username: user, loginCount: entries.length};
            })
            .sort((a, b) => b.loginCount - a.loginCount);

          // 3) Total login count (file-based)
          const totalLoginCount = allUsersLoginCounts.reduce((sum, u) => sum + u.loginCount, 0);

          res.status(200).json({
            status: "success",
            message: "Tracking and summary retrieved successfully",
            data: {userTrackingData, allUsersLoginCounts, totalLoginCount},
          });
        } catch(error) {
          console.error("Error /get-logged-user-tracking:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  // ============================================================================
  // GET /get-all-users-login-counts
  // Summarize login counts for all users in logs directory (optionally date-filtered)
  // Query: ?startDate=ISO&endDate=ISO
  // ============================================================================
  private getAllUserLoginCounts(): void {
    this.router.get(
      "/get-all-users-login-counts",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const {startDate, endDate} = req.query as {startDate?: string; endDate?: string};
          const start = this.toDate(startDate);
          const end = this.endOfDay(this.toDate(endDate));

          const logsRoot = path.join(__dirname, "../../public/logs");
          const logsRootExists = fs.existsSync(logsRoot);

          const readUserLog = (name: string): {username: string; date: Date}[] => {
            const filePath = path.join(logsRoot, name, "user-login.log");
            if(!fs.existsSync(filePath)) return [];

            const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
            const out: {username: string; date: Date}[] = [];

            for(const line of lines) {
              const match =
                line.match(/\[User: (.*?) \| IP: (.*?) \| Date: (.*?) \| Session: (.*?)\]/) ||
                line.match(/\[User: (.*?) \| IP: (.*?) \| Date: (.*?)\]/);

              if(!match || match.length < 4) continue;

              const dateStr = match[3] ?? "";
              const date = this.toDate(dateStr);
              if(!date) continue;

              if(start && date < start) continue;
              if(end && date > end) continue;

              out.push({username: match[1] ?? "", date});
            }

            return out;
          };

          const userDirs = logsRootExists
            ? fs.readdirSync(logsRoot, {withFileTypes: true}).filter((d) => d.isDirectory()).map((d) => d.name)
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
          console.error("Error /get-all-users-login-counts:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  // ============================================================================
  // GET /user-file-management-activity/:username/:start/:limit
  // Paged aggregation against UserDocument.files (uploader, time window)
  // Query: ?startDate=ISO&endDate=ISO
  // ============================================================================
  private getUserFileActivity(): void {
    this.router.get(
      "/user-file-management-activity/:username/:start/:limit",
      async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
        try {
          const {username, start, limit} = req.params;
          const {startDate, endDate} = req.query as {startDate?: string; endDate?: string};

          // Pagination (strict-safe)
          const safeStart = Math.max(0, this.toInt(start, 0, 0));
          const safeLimit = Math.min(100, Math.max(1, this.toInt(limit, 20, 1, 100)));

          // Date filter (strict-safe)
          const startDt = this.toDate(startDate);
          const endDt = this.endOfDay(this.toDate(endDate));
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
          console.error("Error /user-file-management-activity:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  // ============================================================================
  // POST /track-activity
  // Records a user activity event to MongoDB (LoggedUserActivitiesModel).
  // Body: { username: string, activity: string, ip?: string, sessionId?: string, occurredAt?: ISO }
  // ============================================================================
  private trackActivity(): void {
    this.router.post(
      "/track-activity",
      async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
        try {
          const {username, activity, ip, sessionId, occurredAt} = req.body as {
            username?: string;
            activity?: string;
            ip?: string;
            sessionId?: string;
            occurredAt?: string;
          };

          if(!username || !username.trim()) {
            res.status(400).json({status: "error", message: "username is required"});
            return;
          }
          if(!activity || !activity.trim()) {
            res.status(400).json({status: "error", message: "activity is required"});
            return;
          }

          const clientIp = this.normalizeIp(ip ?? req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.socket.remoteAddress);
          const when = occurredAt ? this.toDate(occurredAt) ?? new Date() : new Date();

          await LoggedUserActivitiesModel.updateOne(
            {username, ip_address: clientIp},
            {
              $push: {
                activities: {
                  activity,
                  timestamp: when,
                  // Store sessionId if provided (even if not in strict schema)
                  // @ts-ignore
                  sessionId: sessionId ?? null,
                },
              },
            },
            {upsert: true}
          );

          res.status(200).json({
            status: "success",
            message: "Activity tracked",
            data: {username, activity, ip: clientIp, sessionId: sessionId ?? null, timestamp: when},
          });
        } catch(error) {
          console.error("Error /track-activity:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  // ============================================================================
  // GET /activities/:username/:start/:limit
  // Returns paged activities from MongoDB (LoggedUserActivitiesModel)
  // Query: ?startDate=ISO&endDate=ISO
  // ============================================================================
  private getActivitiesByUser(): void {
    this.router.get(
      "/activities/:username/:start/:limit",
      async (req: Request, res: Response): Promise<void> => {
        try {
          const {username, start, limit} = req.params;
          const {startDate, endDate} = req.query as {startDate?: string; endDate?: string};

          if(!username || !username.trim()) {
            res.status(400).json({status: "error", message: "Username cannot be empty"});
            return;
          }

          const safeStart = Math.max(0, this.toInt(start, 0, 0));
          const safeLimit = Math.min(200, Math.max(1, this.toInt(limit, 20, 1, 200)));

          const startDt = this.toDate(startDate);
          const endDt = this.endOfDay(this.toDate(endDate));

          const pipeline: any[] = [
            {$match: {username}},
            {$unwind: "$activities"},
          ];

          if(startDt || endDt) {
            const ts: Record<string, Date> = {};
            if(startDt) ts.$gte = startDt;
            if(endDt) ts.$lte = endDt;
            pipeline.push({$match: {"activities.timestamp": ts}});
          }

          pipeline.push({
            $facet: {
              totalCount: [{$count: "count"}],
              paginatedData: [
                {$sort: {"activities.timestamp": -1}},
                {$skip: safeStart},
                {$limit: safeLimit},
                {
                  $project: {
                    _id: 0,
                    username: 1,
                    ip_address: 1,
                    activity: "$activities.activity",
                    timestamp: "$activities.timestamp",
                    sessionId: "$activities.sessionId",
                  },
                },
              ],
            },
          });

          const results = await LoggedUserActivitiesModel.aggregate(pipeline);
          const total = results[0]?.totalCount?.[0]?.count ?? 0;
          const data = results[0]?.paginatedData ?? [];

          res.status(200).json({
            status: "success",
            message: data.length ? "Activities retrieved successfully" : "No matching records found",
            data: {totalCount: total, data},
          });
        } catch(error) {
          console.error("Error /activities:", error);
          res.status(500).json({status: "error", message: "Internal Server Error: " + error});
        }
      }
    );
  }

  // ============================================================================
  // GET /get-created-users-based-on-creator/:username/:start/:limit
  // Returns users created by :username, filtered by optional date window.
  // Query: ?startDate=ISO&endDate=ISO
  // ============================================================================
  private getCreatedUsersBasedOnCreator(): void {
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
          const safeStart = Math.max(0, this.toInt(start, 0, 0));
          const safeLimit = Math.min(100, Math.max(1, this.toInt(limit, 20, 1, 100)));

          // Date window
          const startDt = this.toDate(startDate);
          const endDt = this.endOfDay(this.toDate(endDate));
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
          console.error("Error /get-created-users-based-on-creator:", error);
          res.status(500).json({
            status: "error",
            message: "Internal Server Error: " + (error as Error).message,
          });
        }
      }
    );
  }

  // ============================================================================
  // Private helper METHODS (moved from top-level helpers)
  // ============================================================================

  /** Parse a possibly-undefined string into an integer with default & clamping. */
  private toInt(
    v: string | undefined,
    def = 0,
    min = Number.MIN_SAFE_INTEGER,
    max = Number.MAX_SAFE_INTEGER
  ): number {
    const n = Number.parseInt(v ?? "", 10);
    if(Number.isNaN(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  /** Parse a date string into a Date; returns null if invalid or undefined. */
  private toDate(v: unknown): Date | null {
    if(typeof v !== "string") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Get end-of-day (23:59:59.999) for a Date; returns null if input null. */
  private endOfDay(d: Date | null): Date | null {
    if(!d) return null;
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return e;
  }

  /** Normalize IPv6 localhost & loopback to 'localhost'. */
  private normalizeIp(ip: string | undefined | null): string {
    if(!ip) return "unknown";
    const trimmed = ip.trim();
    return trimmed === "::1" || trimmed === "127.0.0.1" ? "localhost" : trimmed;
  }

  /** Make a folder path under /public/logs/<username> in a safe, consistent way. */
  private makeUserLogPaths(username: string): {base: string; dir: string; file: string} {
    const base = path.join(__dirname, "../../public/logs");
    const dir = path.join(base, username);
    const file = path.join(dir, "user-login.log");
    return {base, dir, file};
  }
}
