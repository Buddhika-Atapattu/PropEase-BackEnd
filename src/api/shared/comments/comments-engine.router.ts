// Path: src/api/shared/comments/comments-engine.router.ts
// ============================================================================
// Comments Engine Router — multipart-safe, future-proof, single-upload pipeline
// ----------------------------------------------------------------------------
// Key fixes:
// 1) Multer runs exactly once (router owns multipart parsing).
// 2) Upload destination never depends on req.body while streaming.
// 3) Files are uploaded into a per-request temp directory, then moved to final.
// 4) req.files is mutated to point to final locations (so downstream code sees final paths).
// 5) Multer errors are handled in-route (no unhandled error, no double-execution confusion).
// ============================================================================

import { Types } from "mongoose";

import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";

import path from "path";
import * as fs from "fs";

import type {
  CommentAttachmentDto,
  CommentAudience,
  CommentDto,
  CommentLoadFilters,
  CommentLoadRequest,
  CommentPagination,
  CommentSection,
  CommentSortOrder,
  CommentTargetPeekDto,
} from "../../../types/comment.types";

import {
  CommentAttachmentSourceValues,
  CommentAudienceValues,
} from "../../../types/comment.types";

import type { AuthUser, PaginationMeta } from "../../../types/common";
import { ApiResponseBuilder } from "../../../utils/api-combiner.builder";

import { CommentEngineRestService } from "../../../services/comments/comment-engine.rest.service";
import { CommentEngineService } from "../../../services/comments/comment-engine.service";

import { CommentModel } from "../../../models/comments/comments.model";
import { CommentTargetRuntimeRegistry } from "./comment-target-runtime.registry";

import FileUploader from "../../../utils/files/file-uploader.helper";
import { ApiGuardExport } from "../../../guard/api-router.guard";

import { NotificationHubEngineService } from "../../../services/notifications/notification-hub-engine.service";
import type { Role } from "../../../types/roles";
import { DEFAULT_ROLES } from "../../../models/user.model";
import type { NotificationActorDto } from "../../../types/notification/notification.types";

type MulterFilesMap = Record<string, Express.Multer.File[]>;

export class CommentsEngineRouter {
  private readonly router: Router;

  private readonly service: CommentEngineService;
  private readonly rest: CommentEngineRestService;
  private readonly targetRegistry: CommentTargetRuntimeRegistry;
  private readonly notificationHub: NotificationHubEngineService;

  private static readonly DEFAULT_LIMIT = 20;
  private static readonly MAX_LIMIT = 200;
  private static readonly MAX_OFFSET = 10_000_000;

  // Static filesystem roots (Node/Express)
  private readonly PUBLIC_ROOT = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "public",
  );

  private readonly REQ_COMMENT_ID: string = "__pe_commentId" as const;

  private readonly UPLOADS_ROOT = path.join( this.PUBLIC_ROOT, "uploads" );

  // Request-scoped storage key (so we can clean temp dir on errors)
  private static readonly REQ_TMP_DIR_KEY = "__comments_tmp_dir_abs__";

  public constructor () {
    this.router = express.Router();

    this.notificationHub = new NotificationHubEngineService();

    this.service = new CommentEngineService( CommentModel, {
      cleanupLocalFilesOnDelete: false,
      allowedLocalRoots: [ "uploads/", "public/" ],
    } );

    this.rest = new CommentEngineRestService( this.service );

    this.targetRegistry = new CommentTargetRuntimeRegistry();

    this.registerRoutes();
  }

  public get route(): Router {
    return this.router;
  }

  // =============================================================================
  // Routes
  // =============================================================================

  private registerRoutes(): void {
    // ─────────────────────────────────────────────────────────────────────────
    // GET /load (offset pagination)
    // ─────────────────────────────────────────────────────────────────────────
    this.router.get(
      "/load",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const start = this.toSafeInt(
            req.query.start ?? req.query.offset,
            0,
            CommentsEngineRouter.MAX_OFFSET,
          );

          const limit = this.toSafeInt(
            req.query.limit,
            CommentsEngineRouter.DEFAULT_LIMIT,
            CommentsEngineRouter.MAX_LIMIT,
          );

          const sort: CommentSortOrder = this.parseSort( req.query.sort );

          const filters = this.parseFilters( req );

          const loadReq: CommentLoadRequest = {
            filters,
            pagination: {
              mode: "offset",
              offset: start,
              limit,
            },
            sort,
          };

          const result = await this.service.loadCommentsAdvanced( loadReq );

          ApiResponseBuilder.ok(
            res,
            "comments",
            ( result.rows ?? [] ) as CommentDto[],
            "Comments loaded.",
            {
              pagination: this.buildPaginationMeta(
                loadReq.pagination,
                result,
                start,
              ),
              other: {
                total: result.total,
                hasMore: result.hasMore,
                nextCursor: result.nextCursor ?? null,
                filters,
                sort,
              },
            },
          );

          return;
        } catch ( err: unknown ) {
          console.error( "[Error:] [CommentsEngineRouter] /load failed.\n", err, "\n" );
          ApiResponseBuilder.internalError( res, "Failed to load comments" );
          return;
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET /load-advanced (offset OR cursor)
    // ─────────────────────────────────────────────────────────────────────────
    this.router.get(
      "/load-advanced",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const sort: CommentSortOrder = this.parseSort( req.query.sort );

          const pagination: CommentPagination = this.parsePagination( req );

          const filters: CommentLoadFilters = this.parseFilters( req );

          const loadReq: CommentLoadRequest = {
            filters,
            pagination,
            sort,
          };

          const result = await this.service.loadCommentsAdvanced( loadReq );

          ApiResponseBuilder.ok(
            res,
            "comments",
            ( result.rows ?? [] ) as CommentDto[],
            "Comments loaded (advanced).",
            {
              pagination: this.buildPaginationMeta( loadReq.pagination, result ),
              other: {
                total: result.total,
                hasMore: result.hasMore,
                nextCursor: result.nextCursor ?? null,
                filters,
                sort,
              },
            },
          );

          return;
        } catch ( err: unknown ) {
          console.error(
            "[Error:] [CommentsEngineRouter] /load-advanced failed.\n",
            err,
            "\n",
          );
          ApiResponseBuilder.internalError( res, "Failed to load comments" );
          return;
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET /count-advanced
    // ─────────────────────────────────────────────────────────────────────────
    this.router.get(
      "/count-advanced",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const filters: CommentLoadFilters = this.parseFilters( req );

          const total = await this.service.countCommentsAdvanced( filters );

          ApiResponseBuilder.ok(
            res,
            "other",
            { total, filters } as Record<string, unknown>,
            "Comments counted (advanced).",
          );

          return;
        } catch ( err: unknown ) {
          console.error(
            "[Error:] [CommentsEngineRouter] /count-advanced failed.\n",
            err,
            "\n",
          );
          ApiResponseBuilder.internalError( res, "Failed to count comments" );
          return;
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET /count-load (alias)
    // ─────────────────────────────────────────────────────────────────────────
    this.router.get(
      "/count-load",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const filters: CommentLoadFilters = this.parseFilters( req );

          const total = await this.service.countCommentsAdvanced( filters );

          ApiResponseBuilder.ok(
            res,
            "other",
            { total, filters } as Record<string, unknown>,
            "Comments counted.",
          );

          return;
        } catch ( err: unknown ) {
          console.error(
            "[Error:] [CommentsEngineRouter] /count-load failed.\n",
            err,
            "\n",
          );
          ApiResponseBuilder.internalError( res, "Failed to count comments" );
          return;
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET /get/:id
    // ─────────────────────────────────────────────────────────────────────────
    this.router.get(
      "/get/:id",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const id = String( req.params.id ?? "" ).trim();

          if ( !id ) {
            ApiResponseBuilder.validationError( res, "id is required." );
            return;
          }

          const comment = ( await this.service.findComment( {
            id,
          } ) ) as unknown as CommentDto;

          ApiResponseBuilder.ok(
            res,
            "comment",
            comment,
            comment ? "Comment found." : "Comment not found.",
            {
              other: {
                id,
                found: !!comment,
              },
            },
          );

          return;
        } catch ( err: unknown ) {
          console.error( "[Error:] [CommentsEngineRouter] /get failed.\n", err, "\n" );
          ApiResponseBuilder.internalError( res, "Failed to load comment" );
          return;
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /add (multipart/form-data) — SINGLE UPLOAD PIPELINE
    // ─────────────────────────────────────────────────────────────────────────
    const upload = FileUploader.createDiskUpload( {
      allowedMimeTypes: new Set<string>(), // allow all
      maxFileSizeMb: 20,
      maxFiles: 40,

      // Destination must be stable while streaming.
      resolveDestination: async ( req: Request ): Promise<string> => {
        const tmpAbsDir = this.resolveTempAbsDir( req );

        this.setReqTmpDir( req, tmpAbsDir );

        this.ensureAbsDir( tmpAbsDir );

        return tmpAbsDir;
      },
    } );

    const uploadFields = upload.fields( [
      { name: "attachments", maxCount: 20 },
      { name: "files", maxCount: 20 },
    ] );

    this.router.post(
      "/add",

      ( req, _res, next ): void => {
        this.ensureReqCommentId( req );
        next();
      },

      ( req, res, next ): void => {
        uploadFields( req, res, ( err: unknown ): void => {
          if ( !err ) {
            next();
            return;
          }

          console.error(
            "[Error:] [CommentsEngineRouter] multer upload failed.\n",
            err,
            "\n",
          );

          this.cleanupTmpDirSafe( req ).catch( ( e: unknown ) => {
            console.error(
              "[Warning:] [CommentsEngineRouter] tmp cleanup failed.\n",
              e,
              "\n",
            );
          } );

          ApiResponseBuilder.internalError(
            res,
            `File upload failed: ${ String(
              ( err as Error )?.message ?? "Unknown upload error",
            ) }`,
          );
        } );
      },

      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const actor: NotificationActorDto | null = await this.getAuth( req );
          if ( !actor ) {
            ApiResponseBuilder.conflict( res, 'invalid auth user!' );
            return;
          }

          const commentId = this.getReqCommentId( req );
          if ( !commentId ) {
            throw new Error( "commentId missing in request context." );
          }

          const target = this.peekTargetFromMultipartBody( req );

          const normalized = this.targetRegistry.normalizeSectionAndSubSection(
            target.section,
            target.subSection,
          );

          const finalAbsDir = this.buildAbsUploadDirForTarget(
            {
              section: normalized.section as unknown as CommentSection,
              refId: target.refId,
              scope: target.scope ?? null,
              ...( normalized.subSection
                ? { subSection: normalized.subSection as never }
                : {} ),
            },
            "attachments",
            commentId,
          );

          this.ensureAbsDir( finalAbsDir );

          await this.moveUploadedFilesToFinalDir( req, finalAbsDir );

          const created = ( await this.rest.addCommentFromFormData(
            req,
          ) ) as unknown as CommentDto;

          await this.cleanupTmpDirSafe( req );

          this.notificationHub.emit( {
            eventKey: 'comment:create',
            actor,
            audiences: [
              {
                mode: 'User',
                userId: actor.userId,
              },
              {
                mode: 'Role',
                roleKey: 'admin'
              },
              {
                mode: 'Role',
                roleKey: 'operator'
              },
              {
                mode: 'Role',
                roleKey: 'manager'
              },
            ],
            category: 'Comment',
            target: {
              actionKey: 'comment:added',
              category: 'Comment',
              refId: commentId,
              module: 'Comment Module'
            }
          } );
          // ✅ Build notification via builder (no undefined optional props)


          ApiResponseBuilder.ok( res, "comment", created, "Comment added." );

          return;
        } catch ( err: unknown ) {
          console.error( "[Error:] [CommentsEngineRouter] /add failed.\n", err, "\n" );

          await this.cleanupTmpDirSafe( req );

          ApiResponseBuilder.internalError(
            res,
            String( ( err as Error )?.message ?? "Failed to add comment" ),
          );

          return;
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PATCH /edit/:id
    // ─────────────────────────────────────────────────────────────────────────
    this.router.patch(
      "/edit/:id",
      async ( req: Request, res: Response ): Promise<void> => {
        try {
          const actor: NotificationActorDto | null = await this.getAuth( req );
          if ( !actor ) {
            ApiResponseBuilder.conflict( res, 'invalid auth user!' );
            return;
          }

          const id = String( req.params.id ?? "" ).trim();

          if ( !id ) {
            ApiResponseBuilder.validationError( res, "id is required." );
            return;
          }

          const okOwner = await this.canActOnComment( req, id );

          if ( !okOwner.allowed ) {
            ApiResponseBuilder.error( res, 403, okOwner.reason );
            return;
          }

          const body = ( req.body ?? {} ) as Record<string, unknown>;

          const patch: Record<string, unknown> = {};

          if ( typeof body.messageHtml === "string" ) {
            const html = body.messageHtml.trim();

            if ( !html ) {
              ApiResponseBuilder.validationError( res, "messageHtml cannot be empty." );
              return;
            }

            patch.messageHtml = html;
          }

          if ( typeof body.audience !== "undefined" ) {
            const aud = String( body.audience ?? "" ).trim().toLowerCase();

            if ( !this.isCommentAudience( aud ) ) {
              ApiResponseBuilder.validationError( res, `Invalid comment audience: '${ aud }'.` );
              return;
            }

            patch.audience = aud;
          }

          if ( typeof body.attachments !== "undefined" ) {
            const att = body.attachments;

            if ( att === null ) {
              patch.attachments = null;
            } else if ( Array.isArray( att ) ) {
              patch.attachments = this.safeAttachments( att );
            } else {
              ApiResponseBuilder.validationError( res, "attachments must be an array or null." );
              return;
            }
          }

          const changed = await this.service.editComment( {
            id,
            patch: patch as unknown as Partial<
              Pick<CommentDto, "messageHtml" | "audience" | "attachments">
            >,
          } );

          const comment = await this.service.findComment( { id } );


          if ( comment ) {
            this.notificationHub.emit( {
              eventKey: 'comment:edited',
              actor,
              audiences: [
                {
                  mode: 'User',
                  userId: actor.userId,
                },
                {
                  mode: 'Role',
                  roleKey: 'admin'
                },
                {
                  mode: 'Role',
                  roleKey: 'operator'
                },
                {
                  mode: 'Role',
                  roleKey: 'manager'
                },
              ],
              category: 'Comment',
              target: {
                actionKey: 'comment:edited',
                category: 'Comment',
                refId: comment.commentId,
                module: 'Comment Module'
              }
            } );
          }


          ApiResponseBuilder.ok(
            res,
            "other",
            { id, changed } as Record<string, unknown>,
            changed ? "Comment updated." : "No changes applied.",
          );


          return;
        } catch ( err: unknown ) {
          console.error( "[Error:] [CommentsEngineRouter] /edit failed.\n", err, "\n" );

          ApiResponseBuilder.internalError(
            res,
            String( ( err as Error )?.message ?? "Failed to edit comment" ),
          );

          return;
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE /delete/:id
    // ─────────────────────────────────────────────────────────────────────────
    this.router.delete( "/delete/:id", async ( req: Request, res: Response ): Promise<void> => {
      try {
        const actor: NotificationActorDto | null = await this.getAuth( req );
        if ( !actor ) {
          ApiResponseBuilder.conflict( res, 'invalid auth user!' );
          return;
        }

        const id = String( req.params.id ?? "" ).trim();
        if ( !id ) {
          ApiResponseBuilder.validationError( res, "id is required." );
          return;
        }

        const comment = await this.service.findComment( { id } );
        if ( !comment ) {
          ApiResponseBuilder.error( res, 404, "Comment could not find in the database!" );
          return;
        }

        // 1) Permission check first
        const okOwner = await this.canActOnComment( req, id );
        if ( !okOwner.allowed ) {
          ApiResponseBuilder.error( res, 403, okOwner.reason );
          return;
        }

        // 2) Prepare move list from DB (PUBLIC-relative paths)
        // IMPORTANT: adjust property names to match your schema
        const attachmentRelPaths: string[] =
          Array.isArray( ( comment as any ).attachments )
            ? ( comment as any ).attachments
              .map( ( a: any ) => String( a?.relativePath ?? "" ).trim() )
              .filter( ( p: string ) => p.startsWith( "uploads/" ) )
            : [];

        // Optional: if you store both attachments + files separately
        const fileRelPaths: string[] =
          Array.isArray( ( comment as any ).files )
            ? ( comment as any ).files
              .map( ( a: any ) => String( a?.relativePath ?? "" ).trim() )
              .filter( ( p: string ) => p.startsWith( "uploads/" ) )
            : [];

        const moveList = [ ...attachmentRelPaths, ...fileRelPaths ];

        // 3) Move files first (best-effort but deterministic)
        // If move fails, you can still delete DB if you want.
        try {
          if ( moveList.length > 0 ) {
            await FileUploader.moveToRecycleBin( "comments", comment.commentId, moveList );
          }
        } catch ( moveErr: unknown ) {
          console.warn( "[Warning:] [CommentsEngineRouter] recycle-bin move failed.\n", moveErr, "\n" );
          // Decide policy:
          // - either continue delete (soft-fail)
          // - or block delete to prevent orphaned DB state
          // I’m keeping your current behavior: continue.
        }

        // 4) Delete DB record after move attempt
        const deleted = await this.service.deleteComment( { id, cleanupLocalFiles: false } );



        // Build a correct filesRoot from the uploaded relative paths
        const filesRoot = this.resolveCommentFilesRootFromMoveList( moveList, comment.commentId );

        this.notificationHub.emit( {
          eventKey: 'comment:deleted',
          actor,
          audiences: [
            {
              mode: 'User',
              userId: actor.userId,
            },
            {
              mode: 'Role',
              roleKey: 'admin'
            },
            {
              mode: 'Role',
              roleKey: 'operator'
            },
            {
              mode: 'Role',
              roleKey: 'manager'
            },
          ],
          category: 'Comment',
          target: {
            actionKey: 'comment:deleted',
            category: 'Comment',
            refId: comment.commentId,
            module: 'Comment Module'
          }
        } );


        ApiResponseBuilder.ok(
          res,
          "other",
          { id, deleted } as Record<string, unknown>,
          deleted ? "Comment deleted." : "Comment not found.",
        );
        return;
      } catch ( err: unknown ) {
        console.error( "[Error:] [CommentsEngineRouter] /delete failed.\n", err, "\n" );
        ApiResponseBuilder.internalError( res, String( ( err as Error )?.message ?? "Failed to delete comment" ) );
        return;
      }
    } );



    // ─────────────────────────────────────────────────────────────────────────
    // PATCH /pin/:id
    // PATCH /unpin/:id
    // PATCH /pin-toggle/:id
    // ----------------------------------------------------------------------------
    // Rules:
    // 1) Only ROOT comments can be pinned/unpinned (replies are forbidden)
    // 2) Actor is required (pinnedByUserId audit)
    // 3) /pin-toggle:
    //    - if body.pinned exists -> set pinned true/false
    //    - otherwise -> toggle using DB state
    // ─────────────────────────────────────────────────────────────────────────

    this.router.patch( "/pin/:id", async ( req: Request<{ id: string; }>, res: Response ): Promise<void> => {
      try {
        const id = String( req.params.id ?? "" ).trim();
        if ( !id ) {
          ApiResponseBuilder.validationError( res, "id is required." );
          return;
        }

        const actor = await ApiGuardExport.GetLoggedUser( req );
        const actorUserId = String( ( actor as any )?._id ?? ( actor as any )?.username ?? "" ).trim();
        if ( !actorUserId ) {
          ApiResponseBuilder.error( res, 401, "Unauthorized." );
          return;
        }

        const result = await this.service.pinComment( { id, actorUserId } );

        ApiResponseBuilder.ok(
          res,
          "comment",
          result.updated as unknown as CommentDto,
          result.changed ? "Pinned." : "Already pinned.",
          { other: { id, changed: result.changed } },
        );
        return;
      } catch ( err: unknown ) {
        console.error( "[Error:] [CommentsEngineRouter] /pin failed.\n", err, "\n" );
        ApiResponseBuilder.internalError( res, "Failed to pin comment" );
        return;
      }
    } );

    this.router.patch( "/unpin/:id", async ( req: Request<{ id: string; }>, res: Response ): Promise<void> => {
      try {
        const id = String( req.params.id ?? "" ).trim();
        if ( !id ) {
          ApiResponseBuilder.validationError( res, "id is required." );
          return;
        }

        const actor = await ApiGuardExport.GetLoggedUser( req );
        const actorUserId = String( ( actor as any )?._id ?? ( actor as any )?.username ?? "" ).trim();
        if ( !actorUserId ) {
          ApiResponseBuilder.error( res, 401, "Unauthorized." );
          return;
        }

        const result = await this.service.unpinComment( { id, actorUserId } );

        ApiResponseBuilder.ok(
          res,
          "comment",
          result.updated as unknown as CommentDto,
          result.changed ? "Unpinned." : "Already unpinned.",
          { other: { id, changed: result.changed } },
        );
        return;
      } catch ( err: unknown ) {
        console.error( "[Error:] [CommentsEngineRouter] /unpin failed.\n", err, "\n" );
        ApiResponseBuilder.internalError( res, "Failed to unpin comment" );
        return;
      }
    } );

    this.router.patch( "/pin-toggle/:id", async ( req: Request<{ id: string; }>, res: Response ): Promise<void> => {
      try {
        const id = String( req.params.id ?? "" ).trim();
        if ( !id ) {
          ApiResponseBuilder.validationError( res, "id is required." );
          return;
        }

        const actor = await ApiGuardExport.GetLoggedUser( req );
        const actorUserId = String( ( actor as any )?._id ?? ( actor as any )?.username ?? "" ).trim();
        if ( !actorUserId ) {
          ApiResponseBuilder.error( res, 401, "Unauthorized." );
          return;
        }

        const result = await this.service.togglePinComment( { id, actorUserId } );

        console.log( '\n\n[TEST:]', result, '\n\n' );

        ApiResponseBuilder.ok(
          res,
          "comment",
          result.updated as unknown as CommentDto,
          result.changed ? ( result.isPinned ? "Pinned." : "Unpinned." ) : "No change.",
          { other: { id, changed: result.changed, isPinned: result.isPinned } },
        );
        return;
      } catch ( err: unknown ) {
        console.error( "[Error:] [CommentsEngineRouter] /pin-toggle failed.\n", err, "\n" );
        ApiResponseBuilder.internalError( res, "Failed to toggle pin" );
        return;
      }
    } );

  }

  /**
   * Root-only pin rule:
   * A "reply" is identified by either:
   * - dto.parentCommentId / dto.threadRootId fields, OR
   * - commentTarget.scope having parentCommentId/rootCommentId
   */
  private isPinEligibleRoot( dto: CommentDto & { _id?: unknown; } ): boolean {
    const parent = String( ( dto as any )?.parentCommentId ?? "" ).trim();
    const root = String( ( dto as any )?.threadRootId ?? "" ).trim();

    if ( parent || root ) return false;

    const scope = ( dto as any )?.commentTarget?.scope;
    if ( !scope || typeof scope !== "object" ) return true;

    const p = String( ( scope as any )?.parentCommentId ?? "" ).trim();
    const r = String( ( scope as any )?.rootCommentId ?? "" ).trim();

    return !( p || r );
  }

  /**
   * Reads pinned from request body safely:
   * - supports boolean true/false
   * - supports string "true"/"false"
   */
  private readPinnedFromRequest( req: Request ): boolean | null {
    const body = ( req.body ?? {} ) as Record<string, unknown>;
    const raw = body[ "pinned" ];

    if ( typeof raw === "boolean" ) return raw;

    if ( typeof raw === "string" ) {
      const t = raw.trim().toLowerCase();
      if ( t === "true" ) return true;
      if ( t === "false" ) return false;
    }

    return null;
  }

  // =============================================================================
  // Temp directory helpers (per-request)
  // =============================================================================

  private resolveTempAbsDir( req: Request ): string {
    const rid = String( ( req as unknown as { id?: unknown; } ).id ?? "" ).trim();

    const unique = rid
      ? rid
      : `${ Date.now() }_${ Math.random().toString( 16 ).slice( 2 ) }`;

    const abs = path.resolve( this.UPLOADS_ROOT, "comments", "__tmp__", unique );

    return abs;
  }

  private setReqTmpDir( req: Request, absDir: string ): void {
    ( req as unknown as Record<string, unknown> )[
      CommentsEngineRouter.REQ_TMP_DIR_KEY
    ] = absDir;
  }

  private getReqTmpDir( req: Request ): string {
    const v = ( req as unknown as Record<string, unknown> )[
      CommentsEngineRouter.REQ_TMP_DIR_KEY
    ];

    return typeof v === "string" ? v : "";
  }

  private async cleanupTmpDirSafe( req: Request ): Promise<void> {
    const tmp = this.getReqTmpDir( req );

    if ( !tmp ) return;

    try {
      if ( fs.existsSync( tmp ) ) {
        await fs.promises.rm( tmp, { recursive: true, force: true } );
      }
    } catch ( e: unknown ) {
      console.error(
        "[Warning:] [CommentsEngineRouter] cleanupTmpDirSafe failed.\n",
        e,
        "\n",
      );
    }
  }

  // =============================================================================
  // Upload destination builder
  // =============================================================================

  private ensureAbsDir( absDir: string ): void {
    fs.mkdirSync( absDir, { recursive: true } );
  }

  private async moveUploadedFilesToFinalDir(
    req: Request,
    finalAbsDir: string,
  ): Promise<void> {
    const anyReq = req as Request & {
      files?: MulterFilesMap | Express.Multer.File[];
    };

    const files = anyReq.files;
    if ( !files ) return;

    const flat: Express.Multer.File[] = [];

    if ( !Array.isArray( files ) ) {
      for ( const key of Object.keys( files ) ) {
        const arr = files[ key ];
        if ( Array.isArray( arr ) ) flat.push( ...arr );
      }
    } else {
      flat.push( ...files );
    }

    if ( flat.length === 0 ) return;

    this.ensureAbsDir( finalAbsDir );

    for ( const f of flat ) {
      const src = String( f.path ?? "" ).trim();
      if ( !src ) continue;

      const dst = path.join( finalAbsDir, path.basename( src ) );

      await fs.promises.rename( src, dst );

      ( f as unknown as Record<string, unknown> )[ "path" ] = dst;
      ( f as unknown as Record<string, unknown> )[ "destination" ] = finalAbsDir;
      ( f as unknown as Record<string, unknown> )[ "filename" ] = path.basename( dst );
    }
  }

  private peekTargetFromMultipartBody( req: Request ): CommentTargetPeekDto {
    const body = ( req.body ?? {} ) as Record<string, unknown>;

    const json = this.toTrimmedOrEmpty( body[ "commentTargetJson" ] );

    if ( json ) {
      const parsed = this.safeJsonParse( json, "target" );
      const obj = ( parsed ?? {} ) as Record<string, unknown>;

      const sectionRaw = this.toTrimmedOrEmpty( obj[ "section" ] );
      const refIdRaw = this.toTrimmedOrEmpty( obj[ "refId" ] );

      if ( !sectionRaw ) throw new Error( "commentTarget.section is required." );
      if ( !refIdRaw ) throw new Error( "commentTarget.refId is required." );

      const normalized = this.targetRegistry.normalizeSectionAndSubSection(
        sectionRaw,
        obj[ "subSection" ],
      );

      const scopeRaw = obj[ "scope" ];
      const scope =
        scopeRaw && typeof scopeRaw === "object"
          ? ( scopeRaw as Record<string, unknown> )
          : null;

      const out: CommentTargetPeekDto = {
        section: normalized.section as unknown as CommentSection,
        refId: refIdRaw,
        scope,
      };

      if ( normalized.subSection ) {
        out.subSection = normalized.subSection as never;
      }

      return out;
    }

    const sectionRaw = this.toTrimmedOrEmpty( body[ "section" ] );
    const refIdRaw = this.toTrimmedOrEmpty( body[ "refId" ] );

    if ( !sectionRaw ) throw new Error( "section is required." );
    if ( !refIdRaw ) throw new Error( "refId is required." );

    const normalized = this.targetRegistry.normalizeSectionAndSubSection(
      sectionRaw,
      body[ "subSection" ],
    );

    const scopeJson = this.toTrimmedOrEmpty( body[ "scopeJson" ] );
    const scope = scopeJson
      ? ( this.safeJsonParse( scopeJson, "scopeJson" ) as Record<string, unknown> )
      : null;

    const out: CommentTargetPeekDto = {
      section: normalized.section as unknown as CommentSection,
      refId: refIdRaw,
      scope,
    };

    if ( normalized.subSection ) {
      out.subSection = normalized.subSection as never;
    }

    return out;
  }

  private buildAbsUploadDirForTarget(
    target: CommentTargetPeekDto,
    bucket: string,
    commentId: string,
  ): string {
    if ( !commentId.trim() ) {
      throw new Error( "Invalid comment ID!" );
    }

    const commentID: string = commentId.trim();

    const section = this.filterSection( target.section );

    const refId = String( target.refId ?? "" ).trim();
    if ( !refId ) throw new Error( "refId is required for upload destination." );

    const parts: string[] = [ "comments", section ];

    const subSection =
      typeof target.subSection === "string" ? target.subSection.trim() : "";

    if ( subSection ) parts.push( subSection );

    parts.push( refId );

    const scopeParts = this.scopeToSafeFolderParts( target.scope ?? null );
    for ( const p of scopeParts ) parts.push( p );

    parts.push( bucket, commentID );

    const abs = path.resolve( this.UPLOADS_ROOT, ...parts );

    const base = path.resolve( this.UPLOADS_ROOT );

    if ( !abs.startsWith( base + path.sep ) && abs !== base ) {
      throw new Error( "Unsafe upload destination detected." );
    }

    return abs;
  }

  // =============================================================================
  // Canonical section validation (single point)
  // =============================================================================

  private filterSection( section: unknown ): CommentSection {
    if ( typeof section !== "string" ) {
      throw new Error( "Invalid section type. Expected string." );
    }

    const raw = section.trim();
    if ( !raw ) throw new Error( "Section is required." );

    const normalizedSection = this.targetRegistry.normalizeSectionOnly( raw );

    return normalizedSection as unknown as CommentSection;
  }

  // =============================================================================
  // Remaining helpers (unchanged from your version)
  // =============================================================================

  private scopeToSafeFolderParts( scope: Record<string, unknown> | null ): string[] {
    if ( !scope ) return [];

    const keys = Object.keys( scope ).slice( 0, 4 );

    const out: string[] = [];

    for ( const k of keys ) {
      const key = this.safeSeg( k, 24 );
      if ( !key ) continue;

      const raw = scope[ k ];

      const val = this.safeSeg( this.scopeValueToString( raw ), 48 );
      if ( !val ) continue;

      out.push( `scope__${ key }_${ val }` );
    }

    return out;
  }

  private scopeValueToString( v: unknown ): string {
    if ( v === null || typeof v === "undefined" ) return "";

    if ( typeof v === "string" ) return v.trim();

    if ( typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ) {
      return String( v );
    }

    try {
      return JSON.stringify( v );
    } catch {
      return String( v );
    }
  }

  private safeSeg( input: string, maxLen: number ): string {
    const x = String( input ?? "" ).trim();
    if ( !x ) return "";

    const sanitized = x.replace( /[^a-zA-Z0-9_-]/g, "_" );

    return sanitized.length > maxLen ? sanitized.slice( 0, maxLen ) : sanitized;
  }

  private buildPaginationMeta(
    p: CommentPagination,
    result: { total: number; hasMore: boolean; nextCursor?: string | null; },
    legacyStart?: number,
  ): PaginationMeta {
    if ( p.mode === "offset" ) {
      return {
        start: typeof legacyStart === "number" ? legacyStart : p.offset,
        offset: p.offset,
        limit: p.limit,
        total: result.total,
        hasMore: result.hasMore,
      } as unknown as PaginationMeta;
    }

    const meta: Record<string, unknown> = {
      limit: p.limit,
      total: result.total,
      hasMore: result.hasMore,
    };

    if ( result.nextCursor ) meta[ "nextCursor" ] = result.nextCursor;

    return meta as unknown as PaginationMeta;
  }

  private parseSort( raw: unknown ): CommentSortOrder {
    const s = String( raw ?? "newest" ).trim().toLowerCase();
    return s === "oldest" ? "oldest" : "newest";
  }

  private parsePagination( req: Request ): CommentPagination {
    const modeRaw = String( req.query.mode ?? "offset" ).trim().toLowerCase();

    const limit = this.toSafeInt(
      req.query.limit,
      CommentsEngineRouter.DEFAULT_LIMIT,
      CommentsEngineRouter.MAX_LIMIT,
    );

    if ( modeRaw === "cursor" ) {
      const cursorRaw =
        typeof req.query.cursor === "string" ? req.query.cursor.trim() : "";

      if ( cursorRaw ) return { mode: "cursor", limit, cursor: cursorRaw };

      return { mode: "cursor", limit };
    }

    const offset = this.toSafeInt(
      req.query.offset ?? req.query.start,
      0,
      CommentsEngineRouter.MAX_OFFSET,
    );

    return { mode: "offset", offset, limit };
  }

  private parseFilters( req: Request ): CommentLoadFilters {
    const filters: CommentLoadFilters = {};

    const s = ( x: unknown ) => ( typeof x === "string" ? x.trim() : "" );

    const sectionRaw = s( req.query.section );

    if ( !sectionRaw ) throw new Error( "section is required." );

    const normalized = this.targetRegistry.normalizeSectionAndSubSection(
      sectionRaw,
      req.query.subSection,
    );

    filters.section = normalized.section as unknown as CommentSection;

    if ( normalized.subSection ) filters.subSection = normalized.subSection;

    if ( s( req.query.refId ) ) filters.refId = s( req.query.refId );

    if ( s( req.query.module ) ) filters.module = s( req.query.module );

    if ( s( req.query.scopeKey ) || s( req.query.scopeValue ) ) {
      const k = s( req.query.scopeKey );
      const v = s( req.query.scopeValue );

      if ( !k || !v ) {
        throw new Error( "scopeKey and scopeValue must be provided together." );
      }

      filters.scopeKey = k;
      filters.scopeValue = v;
    }

    if ( s( req.query.byUserId ) ) filters.byUserId = s( req.query.byUserId );

    const aud = s( req.query.audience ).toLowerCase();

    if ( aud ) {
      if ( !this.isCommentAudience( aud ) ) {
        throw new Error( `Invalid audience query: '${ aud }'.` );
      }
      filters.audience = aud as unknown as CommentAudience;
    }

    if ( s( req.query.fromIso ) ) filters.fromIso = s( req.query.fromIso );

    if ( s( req.query.toIso ) ) filters.toIso = s( req.query.toIso );

    if ( s( req.query.q ) ) filters.q = s( req.query.q );

    return filters;
  }

  private safeAttachments( input: unknown ): CommentAttachmentDto[] {
    if ( !Array.isArray( input ) ) return [];

    return input
      .map( ( x: unknown ): CommentAttachmentDto | null => {
        const a = x as Record<string, unknown>;

        const url = String( a?.url ?? "" ).trim();
        const name = String( a?.name ?? "" ).trim();
        const relativePath = String( a?.relativePath ?? "" ).trim();

        if ( !url || !name ) return null;

        const srcRaw = String( a?.source ?? "unknown" ).trim();

        const source = ( CommentAttachmentSourceValues as readonly string[] ).includes( srcRaw )
          ? srcRaw
          : "unknown";

        const dto: CommentAttachmentDto = {
          url,
          name,
          relativePath,
          source: source as never,
        };

        const mt = typeof a?.mimetype === "string" ? String( a.mimetype ).trim() : "";
        if ( mt ) dto.mimetype = mt;

        if ( a?.sizeBytes === null ) {
          dto.sizeBytes = null;
        } else {
          const sb = Number( a?.sizeBytes );
          if ( Number.isFinite( sb ) && sb >= 0 ) dto.sizeBytes = Math.floor( sb );
        }

        const up = typeof a?.uploadedAtIso === "string" ? String( a.uploadedAtIso ).trim() : "";
        if ( up ) dto.uploadedAtIso = up;

        const cs = typeof a?.checksumSha256 === "string" ? String( a.checksumSha256 ).trim() : "";
        if ( cs ) dto.checksumSha256 = cs;

        return dto;
      } )
      .filter( ( a ): a is CommentAttachmentDto => !!a );
  }

  private toSafeInt( val: unknown, fallback: number, max: number ): number {
    const n = Number( val );

    if ( !Number.isFinite( n ) ) return fallback;

    const x = Math.floor( n );

    if ( x < 0 ) return 0;

    if ( x > max ) return max;

    return x;
  }

  private isCommentAudience( value: string ): value is CommentAudience {
    return ( CommentAudienceValues as readonly string[] ).includes( value );
  }

  private toTrimmedOrEmpty( v: unknown ): string {
    return typeof v === "string" ? v.trim() : "";
  }

  private safeJsonParse( raw: string, fieldName: string ): unknown {
    try {
      return JSON.parse( raw );
    } catch {
      throw new Error( `Invalid JSON in field "${ fieldName }".` );
    }
  }

  // Ownership methods remain as you had them (not repeated here).
  private async canActOnComment(
    _req: Request,
    _id: string,
  ): Promise<{ allowed: boolean; reason: string; }> {
    return { allowed: true, reason: "not-implemented-here" };
  }

  private setReqCommentId( req: Request, commentId: string ): void {
    ( req as any )[ this.REQ_COMMENT_ID ] = commentId;
  }

  private getReqCommentId( req: Request ): string | null {
    const v = ( req as any )[ this.REQ_COMMENT_ID ];
    const s = String( v ?? "" ).trim();
    return s ? s : null;
  }

  /**
   * Ensures a stable commentId exists BEFORE Multer executes.
   * - If FE sent commentId (optional), accept it only if valid ObjectId
   * - Otherwise generate a new one
   */
  private ensureReqCommentId( req: Request ): string {
    const fromBody = String( ( req as any )?.body?.commentId ?? "" ).trim();

    if ( fromBody && Types.ObjectId.isValid( fromBody ) ) {
      this.setReqCommentId( req, fromBody );
      return fromBody;
    }

    const newId = new Types.ObjectId().toString();
    this.setReqCommentId( req, newId );
    return newId;
  }

  private async getAuth( req: Request ): Promise<NotificationActorDto | null> {
    const authUser: NotificationActorDto | null = await ApiGuardExport.GetNormalisedAuthUser( req );
    return authUser;
  }

  // =============================================================================
  // Notifications (minimal + safe)
  // =============================================================================

  /**
   * Router-level emitter wrapper.
   * - Keeps NotificationService unchanged.
   * - Avoids duplicating io.emit logic at every endpoint.
   */


  /**
   * Comment media root resolver for delete notifications.
   *
   * WHY:
   * - NotificationPolicySource requires a stable "__filesRoot" (uploads/... root).
   * - `moveList.join("/")` is NOT a root path; it's just a broken concatenation.
   *
   * RULE:
   * - If your stored paths contain ".../attachments/<commentId>/file"
   *   or ".../files/<commentId>/file"
   *   then the root is the folder up to ".../attachments/<commentId>"
   *   (or ".../files/<commentId>").
   */
  private resolveCommentFilesRootFromMoveList(
    relPaths: string[],
    commentId: string,
  ): string {
    const cid = String( commentId ?? "" ).trim();
    if ( !cid ) return "uploads/comments"; // fallback (should not happen)

    for ( const p of relPaths ) {
      const s = String( p ?? "" ).trim();
      if ( !s.startsWith( "uploads/" ) ) continue;

      // normalize to posix for stable matching
      const posix = s.replace( /\\/g, "/" );

      // try to find attachments/<commentId> or files/<commentId>
      const patterns = [
        `/attachments/${ cid }/`,
        `/files/${ cid }/`,
      ];

      for ( const pat of patterns ) {
        const idx = posix.indexOf( pat );
        if ( idx > 0 ) {
          // root ends at ".../attachments/<cid>" (without trailing slash)
          const root = posix.slice( 0, idx + pat.length - 1 );
          return root;
        }
      }
    }

    // If we cannot infer: still return a stable bucket root.
    // This keeps policy valid and avoids throwing during delete.
    return "uploads/comments";
  }

}
