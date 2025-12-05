// src/api/tracking.ts
// ============================================================================
// Tracking Controller (class-based)
// ----------------------------------------------------------------------------
// 1) Track logins
//    - File log: /public/logs/<username>/user-login.log
//    - MongoDB: TrackingLoggedUserModel (per-IP login history)
//    - Returns sessionId to link further activities
//
// 2) Summaries & Queries
//    - /get-logged-user-tracking-count/:username
//    - /get-logged-user-tracking/:username?index=&limit=&daterange=&search=
//    - /get-all-users-login-counts?dateRange={"start":"...","end":"..."}
//
// 3) Track Activities (MongoDB LoggedUserActivitiesModel)
//    - /track-activity
//    - /activities/:username/:start/:limit?startDate=&endDate=
//    - /recent?limit=&cursor=&kind=
//
// 4) File & User creation activity
//    - /user-file-management-activity/:username/:start/:limit?startDate=&endDate=
//    - /get-created-users-based-on-creator/:username?index=&limit=&search=
//    - /get-total-of-created-users-based-on-creator/:username
//
// STYLE:
// - All helpers as private methods
// - Safe pagination + date handling
// - exactOptionalPropertyTypes-safe (no `{}` pretending to be a DateRange)
// ============================================================================

import express, { Request, Response, NextFunction, Router } from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

import {
  TrackingLoggedUserModel,
  LoggedUserActivitiesModel,
} from "../models/tracking.model";
import { UserDocumentModel } from "../models/file-upload.model";
import { UserModel, type IUser } from "../models/user.model";
import { ApiResponseBuilder } from "../utils/api-combiner.builder";
import { type PaginationMeta, type DateRange } from "../types/api-message";
import type { FilterQuery } from "mongoose";

dotenv.config();

/** Single parsed line from user-login.log */
interface UserLogEntry {
  username: string;
  ip: string;
  date: Date;
  session?: string;
}

export default class Tracking {
  private readonly router: Router;
  /** Base folder for log files */
  private readonly logsRoot: string = path.join( __dirname, "../../public/logs" );

  constructor () {
    this.router = express.Router();

    // Route registrations
    this.createTrackingForUser();
    this.getTotalUserTackingCount();
    this.getLoggedUserTracking();
    this.getAllUserLoginCounts();
    this.getUserFileActivity();
    this.trackActivity();
    this.getActivitiesByUser();
    this.getCreatedUsersBasedOnCreator();
    this.getTotalOfCreatedUsersBasedOnCreator();
    this.getRecentFeed();
  }

  /** Expose router */
  public get route(): Router {
    return this.router;
  }

  // ============================================================================
  // POST /track-logged-user-login
  // ============================================================================
  private createTrackingForUser(): void {
    this.router.post(
      "/track-logged-user-login",
      async ( req: Request, res: Response, _next: NextFunction ): Promise<void> => {
        try {
          // 1) Resolve client IP (x-forwarded-for first, then socket)
          const ipHeader = req.headers[ "x-forwarded-for" ]
            ?.toString()
            .split( "," )[ 0 ];
          const rawIp = ipHeader ?? req.socket.remoteAddress ?? undefined;
          const ip = this.normalizeIp( rawIp ) || "unknown";

          // 2) Basic payload validation
          const { username, date } = req.body as {
            username?: unknown;
            date?: unknown;
          };

          if ( !username || typeof username !== "string" || !username.trim() ) {
            ApiResponseBuilder.validationError(
              res,
              "Invalid or missing username"
            );
            return;
          }

          const parsedDate =
            typeof date === "string" ? this.toDate( date ) : new Date();
          if ( parsedDate === null ) {
            ApiResponseBuilder.validationError( res, "Invalid date format" );
            return;
          }

          const safeUsername = username.trim();
          const sessionId = crypto.randomUUID();

          // 3) Append to per-user log file
          const { dir, file } = this.makeUserLogPaths( safeUsername );
          await fs.promises.mkdir( dir, { recursive: true } );

          const logEntry =
            `[User: ${ safeUsername } | IP: ${ ip } | ` +
            `Date: ${ new Date( parsedDate ).toISOString() } | ` +
            `Session: ${ sessionId }]\n`;

          await fs.promises.appendFile( file, logEntry );

          // 4) Update Mongo login-tracking document
          //    Schema: { username, data: [{ ip_address, date }] }
          await TrackingLoggedUserModel.updateOne(
            { username: safeUsername }, // ✅ only schema paths at root
            {
              $push: {
                data: {
                  ip_address: ip, // ✅ lives inside data[]
                  date: parsedDate,
                },
              },
            },
            { upsert: true } // safe with strict mode now
          );

          // 5) Respond
          ApiResponseBuilder.ok(
            res,
            "other",
            {
              username: safeUsername,
              ip,
              sessionId,
              date: parsedDate,
            },
            "User login tracked successfully"
          );
          return;
        } catch ( error ) {
          console.error( "Error /track-logged-user-login:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ============================================================================
  // GET /get-logged-user-tracking-count/:username
  // ============================================================================
  private getTotalUserTackingCount(): void {
    this.router.get(
      "/get-logged-user-tracking-count/:username",
      async (
        req: Request<{ username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const username = ( req.params.username ?? "" ).trim();

          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Username is required!" );
            return;
          }

          const total = this.countUserLoginsByUsername( username );

          const pagination: PaginationMeta = {
            index: 0,
            limit: total || 0,
            total,
            start: 0,
            end: total ? total - 1 : 0,
            hasNext: false,
            hasPrevious: false,
            hasResults: total > 0,
            hasMore: false,
          };

          ApiResponseBuilder.ok(
            res,
            "other",
            { username, total },
            "Total login count retrieved",
            { pagination }
          );
        } catch ( error ) {
          console.error( "Error /get-logged-user-tracking-count:", error );
          ApiResponseBuilder.internalError( res, error );
        }
      }
    );
  }

  // ============================================================================
  // GET /get-logged-user-tracking/:username
  // Query: ?index=&limit=&daterange=&search=
  //   - daterange = JSON string: {"start":"2025-01-01","end":"2025-01-31"}
  // ============================================================================
  private getLoggedUserTracking(): void {
    this.router.get(
      "/get-logged-user-tracking/:username",
      async (
        req: Request<{ username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const username = ( req.params.username ?? "" ).trim();

          if ( !username ) {
            ApiResponseBuilder.validationError( res, "Username is required!" );
            return;
          }

          const { index, limit, daterange, search } = req.query as {
            index?: string;
            limit?: string;
            daterange?: string;
            search?: string;
          };

          if ( !index || !limit ) {
            ApiResponseBuilder.validationError( res, "Parameter data is missing!" );
            return;
          }

          const parsedIndex = this.toInt( index, 0, 0 );
          const parsedLimit = this.toInt( limit, 20, 1, 200 );

          if ( !Number.isFinite( parsedIndex ) || parsedIndex < 0 ) {
            ApiResponseBuilder.validationError( res, "Invalid index value!" );
            return;
          }

          if ( !Number.isFinite( parsedLimit ) || parsedLimit <= 0 ) {
            ApiResponseBuilder.validationError( res, "Invalid limit value!" );
            return;
          }

          const safeIndex = parsedIndex;
          const safeLimit = parsedLimit;
          const start = safeIndex * safeLimit;

          const safeDateRange = this.parseDateRangeFromQuery( daterange ?? "" );
          const safeSearch = ( search ?? "" ).trim().toLowerCase();

          // 1) User logs (file-based)
          const userLogs = this.parseUserLogsForUser( username, safeDateRange );

          const filteredLogs =
            safeSearch.length > 0
              ? userLogs.filter( ( log ) =>
                [
                  log.username.toLowerCase(),
                  log.ip.toLowerCase(),
                  log.session?.toLowerCase() ?? "",
                  log.date.toISOString().toLowerCase(),
                ].some( ( field ) => field.includes( safeSearch ) )
              )
              : userLogs;

          const userTotalCount = filteredLogs.length;

          const userPagedData = filteredLogs
            .sort( ( a, b ) => b.date.getTime() - a.date.getTime() )
            .slice( start, start + safeLimit );

          const userTrackingData = {
            username,
            totalCount: userTotalCount,
            data: userPagedData,
          };

          // 2) All users login counts (file-based)
          const allUsersLogin = this.getallUsersLoginFromFiles(
            safeDateRange ?? undefined
          );

          const totalLoginCount: number = allUsersLogin.reduce(
            ( sum, u ) => sum + u.loginCount,
            0
          );

          const pagination: PaginationMeta = this.buildPaginationMeta(
            safeIndex,
            safeLimit,
            userTotalCount,
            start,
            userPagedData.length
          );

          ApiResponseBuilder.ok(
            res,
            "other",
            { userTrackingData, allUsersLogin, totalLoginCount },
            "Tracking and summary retrieved successfully",
            { pagination }
          );
        } catch ( error ) {
          console.error( "Error /get-logged-user-tracking:", error );
          ApiResponseBuilder.internalError( res, error );
        }
      }
    );
  }

  // ============================================================================
  // GET /get-all-users-login-counts
  // Query: ?dateRange={"start":"2025-01-01","end":"2025-01-31"}
  // ============================================================================
  private getAllUserLoginCounts(): void {
    this.router.get(
      "/get-all-users-login-counts",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const rawRangeStr =
            ( req.query.dateRange as string | undefined )?.trim() ?? "";

          if ( !rawRangeStr ) {
            ApiResponseBuilder.validationError( res, "Date range is required!" );
            return;
          }

          // Expected: { "start": "2025-01-01", "end": "2025-01-31" }
          const rawRange = this.mustJSON<{ start?: string; end?: string; }>(
            rawRangeStr,
            "Date range"
          );

          const startDt = rawRange.start ? this.toDate( rawRange.start ) : null;
          const endDt = rawRange.end
            ? this.endOfDay( this.toDate( rawRange.end ) )
            : null;

          const dateRange: DateRange = {
            start: '',
            end: ''
          };
          if ( startDt ) dateRange.start = startDt;
          if ( endDt ) dateRange.end = endDt;

          if ( !dateRange.start && !dateRange.end ) {
            ApiResponseBuilder.validationError( res, "Date range is invalid!" );
            return;
          }

          const allUserLoginRecords = this.getallUsersLoginFromFiles( dateRange );

          const totalLoginCount = allUserLoginRecords.reduce(
            ( sum, u ) => sum + u.loginCount,
            0
          );

          const pagination: PaginationMeta = {
            index: 0,
            limit: totalLoginCount || 0,
            total: totalLoginCount,
            start: 0,
            end: totalLoginCount ? totalLoginCount - 1 : 0,
            hasNext: false,
            hasPrevious: false,
            hasResults: totalLoginCount > 0,
            hasMore: false,
          };

          ApiResponseBuilder.ok(
            res,
            "other",
            { allUserLoginRecords },
            "All user login counts retrieved successfully",
            { pagination }
          );
          return;
        } catch ( error ) {
          console.error( "Error /get-all-users-login-counts:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ============================================================================
  // GET /user-file-management-activity/:username/:start/:limit
  // Query: ?startDate=ISO&endDate=ISO
  // ============================================================================
  private getUserFileActivity(): void {
    this.router.get(
      "/user-file-management-activity/:username/:start/:limit",
      async (
        req: Request<{ username: string; start: string; limit: string; }>,
        res: Response,
        _next: NextFunction
      ): Promise<void> => {
        try {
          const { username, start, limit } = req.params;
          const { startDate, endDate } = req.query as {
            startDate?: string;
            endDate?: string;
          };

          const safeStart = Math.max( 0, this.toInt( start, 0, 0 ) );
          const safeLimit = Math.min(
            100,
            Math.max( 1, this.toInt( limit, 20, 1, 100 ) )
          );

          const startDt = this.toDate( startDate );
          const endDt = this.endOfDay( this.toDate( endDate ) );

          const dateFilter: Record<string, Date> = {};
          if ( startDt ) dateFilter.$gte = startDt;
          if ( endDt ) dateFilter.$lte = endDt;

          const matchStage: Record<string, unknown> = {
            "files.uploader": username,
          };
          if ( startDt || endDt ) {
            matchStage[ "files.uploadDate" ] = dateFilter;
          }

          const results = await UserDocumentModel.aggregate( [
            { $unwind: "$files" },
            { $match: matchStage },
            {
              $facet: {
                totalCount: [ { $count: "count" } ],
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
          ] );

          const total: number = results[ 0 ]?.totalCount?.[ 0 ]?.count ?? 0;
          const data = results[ 0 ]?.paginatedData ?? [];

          const message = data.length
            ? "User file activity retrieved successfully"
            : "No matching records found";

          const pagination: PaginationMeta = this.buildPaginationMeta(
            Math.floor( safeStart / safeLimit ),
            safeLimit,
            total,
            safeStart,
            data.length
          );

          ApiResponseBuilder.ok( res, "fileUploads", data, message, {
            pagination,
          } );
        } catch ( error ) {
          console.error( "Error /user-file-management-activity:", error );
          ApiResponseBuilder.internalError( res, error );
        }
      }
    );
  }

  // ============================================================================
  // POST /track-activity
  // Body:
  //   { username, activity, ip?, sessionId?, occurredAt?, kind?, title?, refId?, severity? }
  // ============================================================================
  private trackActivity(): void {
    this.router.post(
      "/track-activity",
      async ( req: Request, res: Response, _next: NextFunction ): Promise<void> => {
        try {
          const {
            username,
            activity,
            ip,
            sessionId,
            occurredAt,
            kind,
            title,
            refId,
            severity,
          } = req.body as {
            username?: string;
            activity?: string;
            ip?: string;
            sessionId?: string;
            occurredAt?: string;
            kind?: string;
            title?: string;
            refId?: string;
            severity?: string;
          };

          if ( !username || !username.trim() ) {
            ApiResponseBuilder.validationError( res, "username is required" );
            return;
          }
          if ( !activity || !activity.trim() ) {
            ApiResponseBuilder.validationError( res, "activity is required" );
            return;
          }

          const clientIp = this.normalizeIp(
            ip ??
            req.headers[ "x-forwarded-for" ]?.toString().split( "," )[ 0 ] ??
            req.socket.remoteAddress
          );
          const when = occurredAt
            ? this.toDate( occurredAt ) ?? new Date()
            : new Date();

          await LoggedUserActivitiesModel.updateOne(
            { username, ip_address: clientIp },
            {
              $push: {
                activities: {
                  activity,
                  timestamp: when,
                  kind: kind ?? undefined,
                  title: title ?? undefined,
                  refId: refId ?? undefined,
                  severity: severity ?? undefined,
                  sessionId: sessionId ?? null,
                },
              },
            },
            { upsert: true }
          );

          ApiResponseBuilder.ok(
            res,
            "other",
            {
              username,
              activity,
              ip: clientIp,
              sessionId: sessionId ?? null,
              timestamp: when,
              kind: kind ?? undefined,
              title: title ?? undefined,
              refId: refId ?? undefined,
              severity: severity ?? undefined,
            },
            "Activity tracked"
          );
        } catch ( error ) {
          console.error( "Error /track-activity:", error );
          ApiResponseBuilder.internalError( res, error );
        }
      }
    );
  }

  // ============================================================================
  // GET /activities/:username/:start/:limit
  // Query: ?startDate=ISO&endDate=ISO
  // ============================================================================
  private getActivitiesByUser(): void {
    this.router.get(
      "/activities/:username/:start/:limit",
      async (
        req: Request<{ username: string; start: string; limit: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const { username, start, limit } = req.params;
          const { startDate, endDate } = req.query as {
            startDate?: string;
            endDate?: string;
          };

          if ( !username || !username.trim() ) {
            ApiResponseBuilder.validationError( res, "username is required" );
            return;
          }

          const safeStart = Math.max( 0, this.toInt( start, 0, 0 ) );
          const safeLimit = Math.min(
            200,
            Math.max( 1, this.toInt( limit, 20, 1, 200 ) )
          );

          const startDt = this.toDate( startDate );
          const endDt = this.endOfDay( this.toDate( endDate ) );

          const pipeline: any[] = [
            { $match: { username } },
            { $unwind: "$activities" },
          ];

          if ( startDt || endDt ) {
            const ts: Record<string, Date> = {};
            if ( startDt ) ts.$gte = startDt;
            if ( endDt ) ts.$lte = endDt;
            pipeline.push( { $match: { "activities.timestamp": ts } } );
          }

          pipeline.push( {
            $facet: {
              totalCount: [ { $count: "count" } ],
              paginatedData: [
                { $sort: { "activities.timestamp": -1 } },
                { $skip: safeStart },
                { $limit: safeLimit },
                {
                  $project: {
                    _id: 0,
                    username: 1,
                    ip_address: 1,
                    activity: "$activities.activity",
                    timestamp: "$activities.timestamp",
                    sessionId: "$activities.sessionId",
                    kind: "$activities.kind",
                    title: "$activities.title",
                    refId: "$activities.refId",
                    severity: "$activities.severity",
                  },
                },
              ],
            },
          } );

          const results = await LoggedUserActivitiesModel.aggregate( pipeline );
          const total = results[ 0 ]?.totalCount?.[ 0 ]?.count ?? 0;
          const data = results[ 0 ]?.paginatedData ?? [];

          const message = data.length
            ? "Activities retrieved successfully"
            : "No matching records found";

          const pagination: PaginationMeta = this.buildPaginationMeta(
            Math.floor( safeStart / safeLimit ),
            safeLimit,
            total,
            safeStart,
            data.length
          );

          ApiResponseBuilder.ok(
            res,
            "other",
            { data },
            message,
            { pagination }
          );
        } catch ( error ) {
          console.error( "Error /activities:", error );
          ApiResponseBuilder.internalError( res, error );
        }
      }
    );
  }

  // ============================================================================
  // GET /get-total-of-created-users-based-on-creator/:username
  // ============================================================================
  private getTotalOfCreatedUsersBasedOnCreator(): void {
    this.router.get(
      "/get-total-of-created-users-based-on-creator/:username",
      async (
        req: Request<{ username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const rawUsername = req.params.username ?? "";
          const username = rawUsername.trim();

          if ( !username ) {
            ApiResponseBuilder.validationError( res, "username is required" );
            return;
          }

          const filter: FilterQuery<IUser> = { creator: username };

          const total: number = await UserModel.countDocuments( filter );

          const pagination: PaginationMeta = {
            index: 0,
            limit: total || 0,
            total,
            start: 0,
            end: total ? total - 1 : 0,
            hasNext: false,
            hasPrevious: false,
            hasResults: total > 0,
            hasMore: false,
          };

          ApiResponseBuilder.ok(
            res,
            "other",
            {},
            "Created users count got successful!",
            { pagination }
          );
          return;
        } catch ( error ) {
          console.error(
            "Error /get-total-of-created-users-based-on-creator:",
            error
          );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ============================================================================
  // GET /get-created-users-based-on-creator/:username
  // Query: ?index=&limit=&search=
  // ============================================================================
  private getCreatedUsersBasedOnCreator(): void {
    this.router.get(
      "/get-created-users-based-on-creator/:username",
      async (
        req: Request<{ username: string; }>,
        res: Response
      ): Promise<void> => {
        try {
          const rawUsername = req.params.username ?? "";
          const username = rawUsername.trim();

          const { index, limit, search } = req.query as {
            index?: string;
            limit?: string;
            search?: string;
          };

          if ( !username ) {
            ApiResponseBuilder.validationError( res, "username is required" );
            return;
          }

          if ( !index || !limit ) {
            ApiResponseBuilder.validationError(
              res,
              "index and limit are required"
            );
            return;
          }

          const pageIndex = this.toInt( index, 0, 0 );
          const pageLimit = this.toInt( limit, 20, 1, 100 );
          const safeSkip = pageIndex * pageLimit;

          const safeSearch = search?.trim();
          const filter: FilterQuery<IUser> = { creator: username };

          if ( safeSearch ) {
            const rx = new RegExp( safeSearch, "i" );
            filter.$or = [ { name: rx }, { username: rx }, { role: rx } ];
          }

          const users: IUser[] = ( await UserModel.find( filter, { password: 0 } )
            .sort( { createdAt: -1 } )
            .skip( safeSkip )
            .limit( pageLimit )
            .lean<IUser>()
            .exec() ) as unknown as IUser[];

          const message = users.length
            ? "Users retrieved successfully"
            : "No matching records found";

          // Optional: you could also add pagination here by counting documents,
          // but for now we return just the list to avoid another DB round-trip.
          ApiResponseBuilder.ok( res, "users", users, message );
          return;
        } catch ( error ) {
          console.error(
            "Error /get-created-users-based-on-creator:",
            error
          );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ============================================================================
  // GET /recent
  // Query: ?limit=20&cursor=<ISO>&kind=<lease|payment|maintenance|user|system>
  // ============================================================================
  private getRecentFeed(): void {
    this.router.get(
      "/recent",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const rawLimit = String( req.query.limit ?? "" );
          const limit = Math.min(
            200,
            Math.max( 1, this.toInt( rawLimit, 20, 1, 200 ) )
          );
          const cursorIso = ( req.query.cursor as string | undefined )?.trim();
          const kind = ( req.query.kind as string | undefined )?.trim();

          const timeMatch: Record<string, Date> = {};
          if ( cursorIso ) {
            const cursorDate = this.toDate( cursorIso );
            if ( cursorDate ) timeMatch.$lt = cursorDate;
          }

          const matchStage: Record<string, unknown> = {};
          if ( kind ) matchStage[ "activities.kind" ] = kind;
          if ( timeMatch.$lt ) matchStage[ "activities.timestamp" ] = timeMatch;

          const pipeline: any[] = [
            { $unwind: "$activities" },
            Object.keys( matchStage ).length ? { $match: matchStage } : null,
            { $sort: { "activities.timestamp": -1 } },
            { $limit: limit + 1 },
            {
              $project: {
                _id: 0,
                username: 1,
                ip_address: 1,
                kind: "$activities.kind",
                title: "$activities.title",
                message: "$activities.activity",
                refId: "$activities.refId",
                occurredAt: "$activities.timestamp",
                severity: "$activities.severity",
                sessionId: "$activities.sessionId",
              },
            },
          ].filter( Boolean );

          const rows = await LoggedUserActivitiesModel.aggregate( pipeline );

          const items = rows.slice( 0, limit ).map( ( r: any ) => ( {
            id: `${ r.refId ?? "" }|${ r.occurredAt ?? "" }|${ r.username ?? "" }`,
            kind: ( r.kind || "system" ) as string,
            title: r.title || "Activity",
            message: r.message || "",
            refId: r.refId,
            actor: r.username
              ? { username: r.username, name: r.username, role: "user" }
              : undefined,
            occurredAt: new Date( r.occurredAt ).toISOString(),
            severity: ( r.severity || "info" ) as string,
            sessionId: r.sessionId ?? null,
          } ) );

          const hasMore = rows.length > limit;
          const lastItem =
            items.length > 0 ? items[ items.length - 1 ] : undefined;
          const nextCursor =
            hasMore && lastItem
              ? this.toIsoOrUndef( lastItem.occurredAt )
              : undefined;

          ApiResponseBuilder.ok(
            res,
            "other",
            { items, nextCursor },
            "Recent activity feed"
          );
        } catch ( error ) {
          console.error( "Error /recent:", error );
          ApiResponseBuilder.internalError( res, error );
        }
      }
    );
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  /** String → int with default and bounds. */
  private toInt(
    v: string | undefined,
    def = 0,
    min = Number.MIN_SAFE_INTEGER,
    max = Number.MAX_SAFE_INTEGER
  ): number {
    const n = Number.parseInt( v ?? "", 10 );
    if ( Number.isNaN( n ) ) return def;
    return Math.min( max, Math.max( min, n ) );
  }

  /** string → Date (or null if invalid). */
  private toDate( v: unknown ): Date | null {
    if ( typeof v !== "string" ) return null;
    const d = new Date( v );
    return Number.isNaN( d.getTime() ) ? null : d;
  }

  /** End-of-day for a Date (or null). */
  private endOfDay( d: Date | null ): Date | null {
    if ( !d ) return null;
    const e = new Date( d );
    e.setHours( 23, 59, 59, 999 );
    return e;
  }

  /** Normalize IP (IPv6 localhost and loopback). */
  private normalizeIp( ip: string | undefined | null ): string {
    if ( !ip ) return "unknown";
    const trimmed = ip.trim();
    return trimmed === "::1" || trimmed === "127.0.0.1" ? "localhost" : trimmed;
  }

  /** Returns base/dir/file paths for user-login.log under logsRoot. */
  private makeUserLogPaths(
    username: string
  ): { base: string; dir: string; file: string; } {
    const base = this.logsRoot;
    const dir = path.join( base, username );
    const file = path.join( dir, "user-login.log" );
    return { base, dir, file };
  }

  /** Safe ISO string or undefined. */
  private toIsoOrUndef( input: unknown ): string | undefined {
    const d = new Date( input as string );
    return Number.isNaN( d.getTime() ) ? undefined : d.toISOString();
  }

  private mustString( v: unknown, name: string ): string {
    if ( typeof v !== "string" || !v.trim() ) {
      throw new Error( `${ name } is required` );
    }
    return v.trim();
  }

  private mustJSON<T = unknown>( v: unknown, name: string ): T {
    const s = this.mustString( v, name );
    try {
      return JSON.parse( s ) as T;
    } catch {
      throw new Error( `${ name } must be valid JSON.` );
    }
  }

  /** Read raw lines from user login file. */
  private readUserLogLines( username: string ): string[] {
    const safe = username.trim();
    const filePath = path.join( this.logsRoot, safe, "user-login.log" );

    if ( !fs.existsSync( filePath ) ) return [];

    const content = fs.readFileSync( filePath, "utf-8" ).trim();
    if ( !content ) return [];

    return content.split( "\n" );
  }

  /** Parse logs for a user, optionally filtered by DateRange. */
  private parseUserLogsForUser(
    username: string,
    range?: DateRange | null
  ): UserLogEntry[] {
    const lines = this.readUserLogLines( username );
    const out: UserLogEntry[] = [];

    const startDt = range?.start ?? null;
    const endDt = range?.end ?? null;

    for ( const line of lines ) {
      const parts =
        line.match(
          /\[User: (.*?) \| IP: (.*?) \| Date: (.*?) \| Session: (.*?)\]/
        ) ||
        line.match( /\[User: (.*?) \| IP: (.*?) \| Date: (.*?)\]/ );

      if ( !parts || parts.length < 4 ) continue;

      const uname = ( parts[ 1 ] ?? "" ).trim();
      const ip = ( parts[ 2 ] ?? "" ).trim();
      const dateStr = parts[ 3 ] ?? "";
      const date = this.toDate( dateStr );
      const rawSession = parts[ 4 ];

      if ( !date ) continue;

      if ( startDt && date < startDt ) continue;
      if ( endDt && date > endDt ) continue;

      if ( uname !== username ) continue;

      const entry: UserLogEntry = { username: uname, ip, date };
      if ( rawSession ) entry.session = rawSession;

      out.push( entry );
    }

    return out;
  }

  /** Count login lines for given user (no date filter). */
  private countUserLoginsByUsername( username: string ): number {
    const lines = this.readUserLogLines( username );
    let count = 0;

    for ( const line of lines ) {
      const match = line.match( /\[User: (.*?) \|/ );
      if ( !match ) continue;

      const nameFromLog = ( match[ 1 ] ?? "" ).trim();
      if ( nameFromLog === username.trim() ) count++;
    }

    return count;
  }

  /** Aggregate login counts for all users (from files), optional date range. */
  private getallUsersLoginFromFiles(
    range?: DateRange
  ): { username: string; loginCount: number; }[] {
    if ( !fs.existsSync( this.logsRoot ) ) return [];

    const dirs = fs
      .readdirSync( this.logsRoot, { withFileTypes: true } )
      .filter( ( d ) => d.isDirectory() )
      .map( ( d ) => d.name );

    const results: { username: string; loginCount: number; }[] = [];

    for ( const userDir of dirs ) {
      const entries = this.parseUserLogsForUser( userDir, range );
      if ( entries.length > 0 ) {
        results.push( { username: userDir, loginCount: entries.length } );
      }
    }

    return results.sort( ( a, b ) => b.loginCount - a.loginCount );
  }

  /** Parse `daterange` query JSON → DateRange with real Dates. */
  private parseDateRangeFromQuery( json?: string ): DateRange | null {
    if ( !json ) return null;

    try {
      const raw = JSON.parse( json ) as { start?: string; end?: string; };

      const startDt = raw.start ? this.toDate( raw.start ) : null;
      const endDt = raw.end ? this.endOfDay( this.toDate( raw.end ) ) : null;

      const range: DateRange = {
        start: '',
        end: ''
      };
      if ( startDt ) range.start = startDt;
      if ( endDt ) range.end = endDt;

      return !range.start && !range.end ? null : range;
    } catch {
      return null;
    }
  }

  /** Build PaginationMeta for current page. */
  private buildPaginationMeta(
    index: number,
    limit: number,
    total: number,
    start: number,
    pageLength: number
  ): PaginationMeta {
    const end = pageLength > 0 ? start + pageLength - 1 : start;
    const hasMore = start + pageLength < total;

    return {
      index,
      limit,
      total,
      start,
      end,
      hasNext: hasMore,
      hasPrevious: index > 0,
      hasResults: total > 0,
      hasMore,
    };
  }
}
