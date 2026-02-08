// Path: src/services/comments/comment-engine.rest.service.ts
// ============================================================================
// CommentEngineRestService — REST-facing wrapper (FormData -> DTO mapping)
// ----------------------------------------------------------------------------
// Critical fix:
// - DO NOT run Multer/FileUploader here.
// - Router already performed upload and moved files to final directory.
// - This service only reads req.body + req.files and builds CommentAttachmentDto[].
// ============================================================================

import type { Request } from "express";
import path from "path";

import type {
  CommentAttachmentDto,
  CommentAudience,
  CommentAuthorDto,
  CommentDto,
  CommentTargetDto,
} from "../../types/comment.types";

import { CommentEngineService } from "./comment-engine.service";

type MulterFilesMap = Record<string, Express.Multer.File[]>;

export interface AddCommentFormData {
  commentTargetJson: string;

  section: string;
  subSection: string;
  refId: string;
  module: string;
  modelName: string;

  scopeJson: string;

  audience: string;
  messageHtml: string;

  commentId: string;

  parentCommentId: string;
  rootCommentId: string;
  isPinned: string;
}

export class CommentEngineRestService {
  // Your rule: store relative paths under public/ (no leading slash for Electron compatibility).
  private readonly PUBLIC_ROOT_ABS = path.resolve( process.cwd(), "public" );

  public constructor ( private readonly engine: CommentEngineService ) {}

  public async addCommentFromFormData( req: Request ): Promise<CommentDto> {
    const author = await this.engine.resolveAuthorFromRequest( req );
    if ( !author ) {
      throw new Error( "Not logged in (author could not be resolved)." );
    }

    const body = this.readFormBody( req );

    const messageHtml = body.messageHtml.trim();
    if ( !messageHtml ) {
      throw new Error( "messageHtml is required." );
    }

    const audience = this.parseAudienceOrThrow( body.audience );

    const commentTarget = this.buildTargetDtoFromForm( body );

    this.mergeReplyAndPinToScope( commentTarget, body );

    // IMPORTANT: Build attachments from req.files only (no uploads here).
    const attachments = this.buildAttachmentsFromRequestFiles( req );

    const engineInput: {
      commentTarget: CommentTargetDto;
      audience: CommentAudience;
      messageHtml: string;
      author: CommentAuthorDto;
      attachments?: CommentAttachmentDto[] | null;
      commentId?: string;
      byAvatarUrl?: string | null;
    } = {
      commentTarget,
      audience,
      messageHtml,
      author,
      ...( attachments ? { attachments } : {} ),
      byAvatarUrl: null,
    };

    const commentId = body.commentId.trim();
    if ( commentId ) {
      engineInput.commentId = commentId;
    }

    return await this.engine.addComment( engineInput );
  }

  private readFormBody( req: Request ): AddCommentFormData {
    const b = ( req.body ?? {} ) as Record<string, unknown>;
    return {
      commentTargetJson: this.toStringSafe( b[ "commentTargetJson" ] ),

      section: this.toStringSafe( b[ "section" ] ),
      subSection: this.toStringSafe( b[ "subSection" ] ),
      refId: this.toStringSafe( b[ "refId" ] ),
      module: this.toStringSafe( b[ "module" ] ),
      modelName: this.toStringSafe( b[ "modelName" ] ),

      scopeJson: this.toStringSafe( b[ "scopeJson" ] ),

      audience: this.toStringSafe( b[ "audience" ] ),
      messageHtml: this.toStringSafe( b[ "messageHtml" ] ),

      commentId: this.toStringSafe( b[ "commentId" ] ),

      parentCommentId: this.toStringSafe( b[ "parentCommentId" ] ),
      rootCommentId: this.toStringSafe( b[ "rootCommentId" ] ),
      isPinned: this.toStringSafe( b[ "isPinned" ] ),
    };
  }

  private toStringSafe( v: unknown ): string {
    return typeof v === "string" ? v : "";
  }

  private parseAudienceOrThrow( raw: string ): CommentAudience {
    const aud = String( raw ?? "" ).trim();
    if ( !aud ) throw new Error( "audience is required." );
    return aud as CommentAudience;
  }

  private buildTargetDtoFromForm( body: AddCommentFormData ): CommentTargetDto {
    const json = body.commentTargetJson.trim();
    if ( json ) {
      const parsed = this.safeJsonParse( json, "commentTargetJson" );
      const obj = ( parsed ?? {} ) as Record<string, unknown>;

      const section = String( obj[ "section" ] ?? "" ).trim();
      const refId = String( obj[ "refId" ] ?? "" ).trim();

      if ( !section ) throw new Error( "commentTarget.section is required." );
      if ( !refId ) throw new Error( "commentTarget.refId is required." );

      const scopeRaw = obj[ "scope" ];
      const scope =
        scopeRaw && typeof scopeRaw === "object" ? ( scopeRaw as Record<string, unknown> ) : null;

      const subSection = typeof obj[ "subSection" ] === "string" ? String( obj[ "subSection" ] ).trim() : "";
      const module = typeof obj[ "module" ] === "string" ? String( obj[ "module" ] ).trim() : "";
      const modelName = typeof obj[ "modelName" ] === "string" ? String( obj[ "modelName" ] ).trim() : "";

      const out: Record<string, unknown> = { section, refId, scope };

      if ( subSection ) out[ "subSection" ] = subSection;
      if ( module ) out[ "module" ] = module;
      if ( modelName ) out[ "modelName" ] = modelName;

      return out as unknown as CommentTargetDto;
    }

    const section = body.section.trim();
    const refId = body.refId.trim();
    if ( !section ) throw new Error( "section is required (or pass commentTargetJson)." );
    if ( !refId ) throw new Error( "refId is required (or pass commentTargetJson)." );

    const subSection = body.subSection.trim();
    const module = body.module.trim();
    const modelName = body.modelName.trim();

    const scope =
      body.scopeJson.trim()
        ? ( this.safeJsonParse( body.scopeJson.trim(), "scopeJson" ) as Record<string, unknown> )
        : null;

    const out: Record<string, unknown> = { section, refId, scope };

    if ( subSection ) out[ "subSection" ] = subSection;
    if ( module ) out[ "module" ] = module;
    if ( modelName ) out[ "modelName" ] = modelName;

    return out as unknown as CommentTargetDto;
  }

  private safeJsonParse( raw: string, fieldName: string ): unknown {
    try {
      return JSON.parse( raw );
    } catch {
      throw new Error( `Invalid JSON in field "${ fieldName }".` );
    }
  }

  private mergeReplyAndPinToScope( target: CommentTargetDto, body: AddCommentFormData ): void {
    const parentId = body.parentCommentId.trim();
    const rootId = body.rootCommentId.trim();
    const pinned = body.isPinned.trim();

    if ( !parentId && !rootId && !pinned ) return;

    const scope =
      target.scope && typeof target.scope === "object" ? ( target.scope as Record<string, unknown> ) : {};

    if ( parentId ) scope[ "parentCommentId" ] = parentId;
    if ( rootId ) scope[ "rootCommentId" ] = rootId;

    if ( pinned ) {
      const v = pinned.toLowerCase();
      scope[ "isPinned" ] = v === "true";
    }

    target.scope = scope;
  }

  private buildAttachmentsFromRequestFiles( req: Request ): CommentAttachmentDto[] | null {
    const anyReq = req as Request & { files?: MulterFilesMap | Express.Multer.File[]; };
    const files = anyReq.files;
    if ( !files ) return null;

    const flat: Express.Multer.File[] = [];

    if ( Array.isArray( files ) ) {
      flat.push( ...files );
    } else {
      for ( const k of Object.keys( files ) ) {
        const arr = files[ k ];
        if ( Array.isArray( arr ) ) flat.push( ...arr );
      }
    }

    if ( flat.length === 0 ) return null;

    // De-duplicate in case frontend mistakenly appends same file to multiple fields.
    const seen = new Set<string>();
    const out: CommentAttachmentDto[] = [];

    for ( const f of flat ) {
      const absPath = String( f.path ?? "" ).trim();
      if ( !absPath ) continue;

      const key = absPath;
      if ( seen.has( key ) ) continue;
      seen.add( key );

      // Convert to public-relative path: "uploads/..."
      const relToPublic = path.relative( this.PUBLIC_ROOT_ABS, absPath ).replace( /\\/g, "/" ).trim();
      if ( !relToPublic ) continue;

      // Ensure Electron-safe rule: no leading slash.
      const url = relToPublic.replace( /^\/+/, "" );
      const origin = `${ req.protocol }://${ req.get( "host" ) }`;
      const publicUrl = `${ origin }/${ url }`;

      const originalName = String( f.originalname ?? "" ).trim();
      const storedName = String( f.filename ?? "" ).trim();

      const name = originalName || storedName;
      if ( !name ) continue;

      const mimetype = String( f.mimetype ?? "" ).trim();
      const sizeBytesRaw = Number( f.size );

      const dto: CommentAttachmentDto = {
        url: publicUrl,
        name,
        source: "local",
        relativePath: relToPublic,
        uploadedAtIso: new Date().toISOString(),
        checksumSha256: null,
        ...( mimetype ? { mimetype } : {} ),
        ...( Number.isFinite( sizeBytesRaw ) && sizeBytesRaw >= 0 ? { sizeBytes: Math.floor( sizeBytesRaw ) } : {} ),
      };

      out.push( dto );
    }

    return out.length ? out : null;
  }
}
