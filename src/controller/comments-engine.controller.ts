// Path: src/controller/comments-engine.controller.ts
// ============================================================================
// CommentsEngineController (REST Controller) — ApiResponseBuilder Version
// ----------------------------------------------------------------------------
// ✅ All responses now use ApiResponseBuilder (MSG-compatible)
// ✅ No `{ ok: true }` responses anymore
// ✅ Keeps TS-safe pattern: res...; return;
// ✅ Logs prefixed and end with '\n'
// ============================================================================

import type { Request, Response } from "express";
import { Types } from "mongoose";

import type {
  CommentAttachmentDto,
  CommentAudience,
  CommentDto,
  CommentLoadRequest,
  CommentLoadResponse,
  CommentSortOrder,
} from "../types/comment.types";

import { CommentEngineService } from "../services/comments/comment-engine.service";
import { CommentEngineRestService } from "../services/comments/comment-engine.rest.service";

import { ApiResponseBuilder } from "../utils/api-combiner.builder";
import type { PaginationMeta } from "../types/api-message";

type JsonRecord = Record<string, unknown>;

export class CommentsEngineController {
  public constructor (
    private readonly engine: CommentEngineService,
    private readonly rest: CommentEngineRestService,
  ) {}

  // ==========================================================================
  // 1) CREATE (multipart/form-data)
  // ==========================================================================
  public async addComment( req: Request, res: Response ): Promise<void> {
    try {
      const created: CommentDto = await this.rest.addCommentFromFormData( req );

      ApiResponseBuilder.ok( res, "comment", created, "Comment created." );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [CommentsEngineController] addComment failed.\n", err, "\n" );
      this.sendError( res, err, 400 );
      return;
    }
  }

  // ==========================================================================
  // 2) READ — offset pagination (GET)
  //   query: section, refId, subSection?, module?, scopeKey?, scopeValue?,
  //          start?, limit?, sort?
  // ==========================================================================
  public async load( req: Request, res: Response ): Promise<void> {
    try {
      const section = this.readString( req.query.section );
      const refId = this.readString( req.query.refId );

      const subSection = this.readString( req.query.subSection );
      const module = this.readString( req.query.module );
      const scopeKey = this.readString( req.query.scopeKey );
      const scopeValue = this.readString( req.query.scopeValue );

      const start = this.readInt( req.query.start, 0 );
      const limit = this.readInt( req.query.limit, 20 );
      const sort = this.readSort( req.query.sort );

      if ( !section ) {
        ApiResponseBuilder.validationError( res, "section is required." );
        return;
      }
      if ( !refId ) {
        ApiResponseBuilder.validationError( res, "refId is required." );
        return;
      }

      const loadByTargetData: {
        section: string;
        subSection?: string;
        refId: string;
        module?: string;
        scopeKey?: string;
        scopeValue?: string;
        offset: number;
        limit: number;
        sort: CommentSortOrder;
      } = {
        section,
        refId,
        offset: start,
        limit,
        sort,
        ...( subSection ? { subSection } : {} ),
        ...( module ? { module } : {} ),
        ...( scopeKey && scopeValue ? { scopeKey, scopeValue } : {} ),
      };

      const result: CommentLoadResponse = await this.engine.loadByTarget( loadByTargetData );

      // Controller returns the same data shape as engine:
      // { rows, total, hasMore, nextCursor }
      // For FE compatibility with your router, we also include `other` + `pagination`
      const pagination: PaginationMeta = {
        start,
        offset: start,
        limit,
        total: result.total,
        hasMore: result.hasMore,
      } as unknown as PaginationMeta;

      ApiResponseBuilder.ok(
        res,
        "comments",
        ( result.rows ?? [] ) as CommentDto[],
        "Comments loaded.",
        {
          pagination,
          other: {
            total: result.total,
            hasMore: result.hasMore,
            nextCursor: result.nextCursor ?? null,
            filters: {
              section,
              refId,
              ...( subSection ? { subSection } : {} ),
              ...( module ? { module } : {} ),
              ...( scopeKey && scopeValue ? { scopeKey, scopeValue } : {} ),
            },
            sort,
          },
        },
      );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [CommentsEngineController] load failed.\n", err, "\n" );
      this.sendError( res, err, 400 );
      return;
    }
  }

  // ==========================================================================
  // 3) READ (advanced) — body: CommentLoadRequest
  // ==========================================================================
  public async loadAdvanced( req: Request, res: Response ): Promise<void> {
    try {
      const body = ( req.body ?? {} ) as JsonRecord;
      const loadReq = body as unknown as CommentLoadRequest;

      const result: CommentLoadResponse = await this.engine.loadCommentsAdvanced( loadReq );

      const pagination: PaginationMeta =
        loadReq.pagination?.mode === "offset"
          ? ( {
            start: ( loadReq.pagination as any )?.offset ?? 0,
            offset: ( loadReq.pagination as any )?.offset ?? 0,
            limit: ( loadReq.pagination as any )?.limit ?? 20,
            total: result.total,
            hasMore: result.hasMore,
          } as unknown as PaginationMeta )
          : ( {
            limit: ( loadReq.pagination as any )?.limit ?? 20,
            total: result.total,
            hasMore: result.hasMore,
            ...( result.nextCursor ? { nextCursor: result.nextCursor } : {} ),
          } as unknown as PaginationMeta );

      ApiResponseBuilder.ok(
        res,
        "comments",
        ( result.rows ?? [] ) as CommentDto[],
        "Comments loaded (advanced).",
        {
          pagination,
          other: {
            total: result.total,
            hasMore: result.hasMore,
            nextCursor: result.nextCursor ?? null,
            filters: loadReq.filters ?? {},
            sort: loadReq.sort ?? "newest",
          },
        },
      );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [CommentsEngineController] loadAdvanced failed.\n", err, "\n" );
      this.sendError( res, err, 400 );
      return;
    }
  }

  // ==========================================================================
  // 4) COUNT (basic)
  // ==========================================================================
  public async count( req: Request, res: Response ): Promise<void> {
    try {
      const section = this.readString( req.query.section );
      const refId = this.readString( req.query.refId );

      if ( !section ) {
        ApiResponseBuilder.validationError( res, "section is required." );
        return;
      }
      if ( !refId ) {
        ApiResponseBuilder.validationError( res, "refId is required." );
        return;
      }

      const subSection = this.readString( req.query.subSection );
      const module = this.readString( req.query.module );
      const scopeKey = this.readString( req.query.scopeKey );
      const scopeValue = this.readString( req.query.scopeValue );

      const countByTargetData: {
        section: string;
        subSection?: string;
        refId: string;
        module?: string;
        scopeKey?: string;
        scopeValue?: string;
      } = {
        section,
        refId,
        ...( subSection ? { subSection } : {} ),
        ...( module ? { module } : {} ),
        ...( scopeKey && scopeValue ? { scopeKey, scopeValue } : {} ),
      };

      const total = await this.engine.countByTarget( countByTargetData );

      const pagination: PaginationMeta = { total };

      ApiResponseBuilder.ok(
        res,
        "other",
        {
          total,
          filters: {
            section,
            refId,
            ...( subSection ? { subSection } : {} ),
            ...( module ? { module } : {} ),
            ...( scopeKey && scopeValue ? { scopeKey, scopeValue } : {} ),
          },
        },
        'Comments counted.',
        { pagination },
      );

      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [CommentsEngineController] count failed.\n", err, "\n" );
      this.sendError( res, err, 400 );
      return;
    }
  }

  // ==========================================================================
  // 5) FIND ONE
  // ==========================================================================
  public async findOne( req: Request, res: Response ): Promise<void> {
    try {
      const idRaw = this.readString( req.params.id );
      if ( !idRaw ) {
        ApiResponseBuilder.validationError( res, "id is required." );
        return;
      }

      const id: string | Types.ObjectId = Types.ObjectId.isValid( idRaw )
        ? new Types.ObjectId( idRaw )
        : idRaw;

      const doc = await this.engine.findComment( { id } );

      if ( !doc ) {
        ApiResponseBuilder.error( res, 404, "Comment not found." );
        return;
      }

      ApiResponseBuilder.ok( res, "comment", doc as unknown as CommentDto, "Comment found." );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [CommentsEngineController] findOne failed.\n", err, "\n" );
      this.sendError( res, err, 400 );
      return;
    }
  }

  // ==========================================================================
  // 6) EDIT
  // ==========================================================================
  public async edit( req: Request, res: Response ): Promise<void> {
    try {
      const idRaw = this.readString( req.params.id );
      if ( !idRaw ) {
        ApiResponseBuilder.validationError( res, "id is required." );
        return;
      }

      const id: string | Types.ObjectId = Types.ObjectId.isValid( idRaw )
        ? new Types.ObjectId( idRaw )
        : idRaw;

      const b = ( req.body ?? {} ) as JsonRecord;

      const patch: Partial<Pick<CommentDto, "messageHtml" | "audience" | "attachments">> = {};

      const messageHtml = this.readString( b[ "messageHtml" ] );
      if ( messageHtml ) patch.messageHtml = messageHtml;

      const audience = this.readString( b[ "audience" ] );
      if ( audience ) patch.audience = audience as CommentAudience;

      if ( typeof b[ "attachments" ] !== "undefined" ) {
        const att = b[ "attachments" ];
        if ( att === null ) {
          patch.attachments = null;
        } else if ( Array.isArray( att ) ) {
          patch.attachments = att as CommentAttachmentDto[];
        } else {
          ApiResponseBuilder.validationError( res, "attachments must be an array or null." );
          return;
        }
      }

      const ok = await this.engine.editComment( { id, patch } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { updated: ok } as Record<string, unknown>,
        ok ? "Comment updated." : "No changes applied.",
      );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [CommentsEngineController] edit failed.\n", err, "\n" );
      this.sendError( res, err, 400 );
      return;
    }
  }

  // ==========================================================================
  // 7) DELETE
  // ==========================================================================
  public async remove( req: Request, res: Response ): Promise<void> {
    try {
      const idRaw = this.readString( req.params.id );
      if ( !idRaw ) {
        ApiResponseBuilder.validationError( res, "id is required." );
        return;
      }

      const id: string | Types.ObjectId = Types.ObjectId.isValid( idRaw )
        ? new Types.ObjectId( idRaw )
        : idRaw;

      const cleanupStr = this.readString( req.query.cleanupLocalFiles );
      const cleanupLocalFiles = cleanupStr ? cleanupStr.toLowerCase() === "true" : false;

      const ok = await this.engine.deleteComment( {
        id,
        ...( cleanupLocalFiles ? { cleanupLocalFiles: true } : {} ),
      } );

      ApiResponseBuilder.ok(
        res,
        "other",
        { deleted: ok } as Record<string, unknown>,
        ok ? "Comment deleted." : "Comment not found.",
      );
      return;
    } catch ( err: unknown ) {
      console.error( "[Error:] [CommentsEngineController] remove failed.\n", err, "\n" );
      this.sendError( res, err, 400 );
      return;
    }
  }

  // ==========================================================================
  // INTERNAL HELPERS
  // ==========================================================================
  private sendError( res: Response, err: unknown, fallbackStatus: number ): void {
    const msg = err instanceof Error ? err.message : "Unknown error";
    ApiResponseBuilder.error( res, fallbackStatus, msg );
  }

  private readString( v: unknown ): string {
    if ( typeof v !== "string" ) return "";
    return v.trim();
  }

  private readInt( v: unknown, fallback: number ): number {
    const n = Number( v );
    if ( !Number.isFinite( n ) ) return fallback;
    return Math.max( 0, Math.floor( n ) );
  }

  private readSort( v: unknown ): CommentSortOrder {
    const s = this.readString( v ).toLowerCase();
    return s === "oldest" ? "oldest" : "newest";
  }
}
