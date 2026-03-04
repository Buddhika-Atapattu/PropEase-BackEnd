// Path: src/services/payments/transactions/payment-transaction.service.ts
// =============================================================================
// PaymentTransactionService — CRUD + LIST (max 500) + APPROVE/REJECT + EVIDENCE UPLOADS
// =============================================================================

import { randomUUID } from "crypto";
import type { Request } from "express";
import type { ClientSession, FilterQuery } from "mongoose";

import {
  PaymentTransactionModel,
  type IPaymentTransaction,
} from "../../../models/payments/transactions/transactions.model";

import type {
  ActorMini,
  AuthUser,
  AuthUserNormalized,
  ISODateString,
  FileMetaPacket,
} from "../../../types/common";

import {
  PaymentMethodKind,
  PaymentStatus,
  PaymentVerificationStatus,
  type PaymentEvidenceDto,
  type PaymentTransactionApproveInputDto,
  type PaymentTransactionCoreDto,
  type PaymentTransactionCountResponseDto,
  type PaymentTransactionCreateInputDto,
  type PaymentTransactionListFilters,
  type PaymentTransactionListItemDto,
  type PaymentTransactionListResponseDto,
  type PaymentTransactionPaymentStatusInputDto,
  type PaymentTransactionReadResponseDto,
  type PaymentTransactionRejectInputDto,
  type PaymentTransactionUpdateInputDto,
} from "../../../types/payments/transactions/payment-transaction.types";

import { NotificationHubEngineService } from "../../notifications/notification-hub-engine.service";
import { MongoIdUtil } from "../../../utils/mongo-id.util";
import type { NotificationActionKey } from "../../../types/notification/notification-action-keys.catalog";

import {
  RecycleBinDomainDeleteService,
  type DomainDeletePlan,
} from "../../recyclebin/recyclebin-domain-delete.service";
import type { RecycleRecordResult } from "../../recyclebin/recyclebin-engine.service";

import FileUploader, {
  type UploadResultPacket,
  type FsMoveResult,
} from "../../../utils/files/file-uploader.helper";

import { FileMetaPacketBuilder } from "../../../utils/files/file-meta-packet.builder";


// =============================================================================
// Lean (DB read shape) — must match NEW model (alias-only)
// =============================================================================

interface PaymentTransactionLean {
  _id: unknown;

  transactionId: string;
  companyId: string;

  bankAccountAlias: string;

  amount: number;
  currencyCode: string;

  method: PaymentMethodKind;

  externalRef?: string;
  transactionAt: Date | string;

  paymentStatus: PaymentStatus;
  verificationStatus: PaymentVerificationStatus;
  verificationNotes?: string;

  verifiedBy?: ActorMini;
  verifiedAt?: Date | string;
  rejectedReason?: string;

  notes?: string;

  evidence?: Array<Omit<PaymentEvidenceDto, "uploadedAt"> & { uploadedAt: Date | string; }>;

  createdBy: ActorMini;
  updatedBy?: ActorMini;

  createdAt: Date | string;
  updatedAt: Date | string;
}

export class PaymentTransactionService {
  // ===========================================================================
  // 01) Dependencies
  // ===========================================================================

  private readonly notificationHub: NotificationHubEngineService =
    new NotificationHubEngineService();

  private readonly deleteSvc: RecycleBinDomainDeleteService =
    new RecycleBinDomainDeleteService();

  // ===========================================================================
  // 02) FormData policy
  // ===========================================================================

  private static readonly PAYLOAD_FIELD: string = "payload";
  private static readonly EVIDENCE_FIELD: string = "evidence";

  private static readonly EVIDENCE_MAX_MB: number = 12;
  private static readonly EVIDENCE_MAX_FILES: number = 10;

  /**
   * ✅ FileUploader expects:
   * allowedMimeTypesByField?: Record<string, ReadonlySet<string>>
   */
  private static readonly ALLOWED_MIME_BY_FIELD: Readonly<Record<string, ReadonlySet<string>>> =
    Object.freeze( {
      [ PaymentTransactionService.EVIDENCE_FIELD ]: new Set<string>( [
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
      ] ),
    } );

  public constructor () {}

  // ===========================================================================
  // CREATE (FormData: payload + evidence[])
  // ===========================================================================

  public async create( options: {
    actor: AuthUser;
    req: Request;
  } ): Promise<PaymentTransactionReadResponseDto> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );

    // 1) Upload FIRST (multer parses fields during upload)
    const tempToken = randomUUID();

    // ✅ IMPORTANT: pass subPath WITHOUT "uploads/" because helper prefixes it.
    const tempSubPath = `payments/transactions/__tmp/${ tempToken }`;

    const uploadOut = await this.uploadEvidenceToTemp( {
      req: options.req,
      tempSubPath,
    } );

    // 2) Parse payload AFTER upload
    const input = this.mustPayloadFromReq<PaymentTransactionCreateInputDto>(
      options.req,
      PaymentTransactionService.PAYLOAD_FIELD,
    );

    // 3) Validate & build DB doc (alias-only)
    const bankAccountAlias = this.mustString( input.bankAccountAlias, "bankAccountAlias" );
    const amount = this.mustAmount( input.amount, "amount" );
    const currencyCode = this.mustString( input.currencyCode, "currencyCode" ).toUpperCase();
    const method = this.mustPaymentMethod( input.method, "method" );

    const externalRef = this.optTrim( input.externalRef );
    const notes = this.optTrim( input.notes );

    const transactionAtIso = this.mustIso( input.transactionAt, "transactionAt" );
    const transactionAt = new Date( transactionAtIso );

    const now = new Date();
    const createdBy = this.toActorMini( actorN );
    const transactionId = this.newTransactionId();

    const doc: Omit<IPaymentTransaction, "_id"> = {
      transactionId,
      companyId,

      bankAccountAlias,

      amount,
      currencyCode,

      method,

      ...( externalRef ? { externalRef } : {} ),
      ...( notes ? { notes } : {} ),

      transactionAt,

      paymentStatus: PaymentStatus.Pending,
      verificationStatus: PaymentVerificationStatus.Unverified,


      createdBy,
      updatedBy: createdBy,
      createdAt: now,
      updatedAt: now,
    };

    const created = await PaymentTransactionModel.create( doc );

    // 4) Evidence finalize (TEMP -> FINAL) then append evidence[]
    try {
      const tempPackets = this.readByField( uploadOut, PaymentTransactionService.EVIDENCE_FIELD );

      if ( tempPackets.length > 0 ) {
        const finalEvidenceDir = this.buildFinalEvidenceDir( transactionId );

        const sources = this.extractRelativePaths( tempPackets );
        const moved = await FileUploader.movePublicFiles( {
          sources,
          destinationDir: finalEvidenceDir,
          overwrite: true,
          req: options.req,
        } );

        const metaPackets = this.extractMoveMeta( moved );
        const evidenceDtos = this.toEvidenceDtosFromMoveMeta( metaPackets );

        if ( evidenceDtos.length > 0 ) {
          await PaymentTransactionModel.updateOne(
            { companyId, transactionId },
            {
              $push: { evidence: { $each: evidenceDtos.map( ( x ) => this.toDbEvidence( x ) ) } },
              $set: { updatedBy: createdBy, updatedAt: new Date() },
            },
          );
        }
      }
    } catch ( err: unknown ) {
      // your policy: no transactions; so rollback by delete
      await PaymentTransactionModel.deleteOne( { companyId, transactionId } );
      throw new Error( `[Error:] Evidence finalize failed. Transaction create rolled back.\n${ String( err ) }\n` );
    }

    // 5) Reload & notify
    const lean = await PaymentTransactionModel.findOne( { companyId, transactionId } )
      .lean<PaymentTransactionLean | null>();

    if ( !lean ) {
      throw new Error( "[Error:] PaymentTransaction created but failed to re-load.\n" );
    }

    await this.emitNotificationSafe( {
      eventKey: "payment:transaction.created",
      actionKey: "payment:transaction.created",
      actor: actorN,
      refMongoId: lean._id,
      module: "Payment Transaction Management",
      params: { transactionId: lean.transactionId },
    } );

    return { item: this.toCoreDto( lean ) };
  }

  // ===========================================================================
  // UPDATE (FormData: payload + evidence[])
  // ===========================================================================

  public async update( options: {
    actor: AuthUser;
    transactionId: string;
    req: Request;
  } ): Promise<PaymentTransactionReadResponseDto> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );
    const transactionId = this.mustString( options.transactionId, "transactionId" );

    // 0) Existence check
    const found = await PaymentTransactionModel.findOne( { companyId, transactionId } )
      .lean<PaymentTransactionLean | null>();

    if ( !found ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    // 1) Upload FIRST
    const tempToken = randomUUID();
    const tempSubPath = `payments/transactions/__tmp/${ tempToken }`;

    const uploadOut = await this.uploadEvidenceToTemp( {
      req: options.req,
      tempSubPath,
    } );

    // 2) Parse payload AFTER upload
    const patch = this.mustPayloadFromReq<PaymentTransactionUpdateInputDto>(
      options.req,
      PaymentTransactionService.PAYLOAD_FIELD,
    );

    // 3) Evidence finalize (TEMP -> FINAL)
    let evidenceDtos: PaymentEvidenceDto[] = [];
    const tempPackets = this.readByField( uploadOut, PaymentTransactionService.EVIDENCE_FIELD );

    if ( tempPackets.length > 0 ) {
      const finalEvidenceDir = this.buildFinalEvidenceDir( transactionId );

      const sources = this.extractRelativePaths( tempPackets );
      const moved = await FileUploader.movePublicFiles( {
        sources,
        destinationDir: finalEvidenceDir,
        overwrite: true,
        req: options.req,
      } );

      const metaPackets = this.extractMoveMeta( moved );
      evidenceDtos = this.toEvidenceDtosFromMoveMeta( metaPackets );
    }

    // 4) Build $set / $unset patch
    const setDoc: Record<string, unknown> = {};
    const unsetDoc: Record<string, 1> = {};

    if ( patch.bankAccountAlias !== undefined ) {
      const alias = this.optTrim( patch.bankAccountAlias );
      if ( !alias ) throw new Error( "[Error:] bankAccountAlias cannot be empty.\n" );
      setDoc.bankAccountAlias = alias;
    }

    if ( patch.amount !== undefined ) setDoc.amount = this.mustAmount( patch.amount, "amount" );
    if ( patch.currencyCode !== undefined ) {
      setDoc.currencyCode = this.mustString( patch.currencyCode, "currencyCode" ).toUpperCase();
    }
    if ( patch.method !== undefined ) setDoc.method = this.mustPaymentMethod( patch.method, "method" );

    this.applyOptSetOrUnset( setDoc, unsetDoc, "externalRef", patch.externalRef );

    if ( patch.transactionAt !== undefined ) {
      const iso = this.mustIso( patch.transactionAt, "transactionAt" );
      setDoc.transactionAt = new Date( iso );
    }

    if ( patch.paymentStatus !== undefined ) {
      setDoc.paymentStatus = this.mustPaymentStatus( patch.paymentStatus, "paymentStatus" );
    }

    if ( patch.verificationStatus !== undefined ) {
      setDoc.verificationStatus = this.mustVerificationStatus(
        patch.verificationStatus,
        "verificationStatus",
      );
    }

    this.applyOptSetOrUnset( setDoc, unsetDoc, "notes", patch.notes );

    const updatedBy = this.toActorMini( actorN );
    const now = new Date();
    setDoc.updatedBy = updatedBy;
    setDoc.updatedAt = now;

    const op: Record<string, unknown> = {};
    if ( Object.keys( setDoc ).length > 0 ) op.$set = setDoc;
    if ( Object.keys( unsetDoc ).length > 0 ) op.$unset = unsetDoc;

    if ( evidenceDtos.length > 0 ) {
      op.$push = { evidence: { $each: evidenceDtos.map( ( x ) => this.toDbEvidence( x ) ) } };
    }

    // 5) Update + reload
    const updated = await PaymentTransactionModel.findOneAndUpdate(
      { companyId, transactionId },
      op,
      { new: true },
    ).lean<PaymentTransactionLean | null>();

    if ( !updated ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    await this.emitNotificationSafe( {
      eventKey: "payment:transaction.updated",
      actionKey: "payment:transaction.updated",
      actor: actorN,
      refMongoId: updated._id,
      module: "Payment Transaction Management",
      params: { transactionId: updated.transactionId },
    } );

    return { item: this.toCoreDto( updated ) };
  }

  // ===========================================================================
  // EVIDENCE UPLOAD (FormData: evidence[] only)
  // ===========================================================================

  public async uploadEvidence( options: {
    actor: AuthUser;
    transactionId: string;
    req: Request;
  } ): Promise<PaymentTransactionReadResponseDto> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );
    const transactionId = this.mustString( options.transactionId, "transactionId" );

    const found = await PaymentTransactionModel.findOne( { companyId, transactionId } )
      .lean<PaymentTransactionLean | null>();

    if ( !found ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    const tempToken = randomUUID();
    const tempSubPath = `payments/transactions/__tmp/${ tempToken }`;

    const uploadOut = await this.uploadEvidenceToTemp( {
      req: options.req,
      tempSubPath,
    } );

    const tempPackets = this.readByField( uploadOut, PaymentTransactionService.EVIDENCE_FIELD );
    if ( tempPackets.length === 0 ) return { item: this.toCoreDto( found ) };

    const finalEvidenceDir = this.buildFinalEvidenceDir( transactionId );

    const sources = this.extractRelativePaths( tempPackets );
    const moved = await FileUploader.movePublicFiles( {
      sources,
      destinationDir: finalEvidenceDir,
      overwrite: true,
      req: options.req,
    } );

    const metaPackets = this.extractMoveMeta( moved );
    const evidenceDtos = this.toEvidenceDtosFromMoveMeta( metaPackets );

    if ( evidenceDtos.length === 0 ) {
      const re = await PaymentTransactionModel.findOne( { companyId, transactionId } )
        .lean<PaymentTransactionLean | null>();
      if ( !re ) throw new Error( "[Error:] PaymentTransaction not found after evidence upload.\n" );
      return { item: this.toCoreDto( re ) };
    }

    const updatedBy = this.toActorMini( actorN );
    const now = new Date();

    const updated = await PaymentTransactionModel.findOneAndUpdate(
      { companyId, transactionId },
      {
        $push: { evidence: { $each: evidenceDtos.map( ( x ) => this.toDbEvidence( x ) ) } },
        $set: { updatedBy, updatedAt: now },
      },
      { new: true },
    ).lean<PaymentTransactionLean | null>();

    if ( !updated ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    await this.emitNotificationSafe( {
      eventKey: "payment:transaction.updated",
      actionKey: "payment:transaction.updated",
      actor: actorN,
      refMongoId: updated._id,
      module: "Payment Transaction Management",
      params: { transactionId: updated.transactionId },
    } );

    return { item: this.toCoreDto( updated ) };
  }

  // ===========================================================================
  // READ ONE
  // ===========================================================================

  public async getByTransactionId( options: {
    actor: AuthUser;
    transactionId: string;
  } ): Promise<PaymentTransactionReadResponseDto | null> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );
    const transactionId = this.mustString( options.transactionId, "transactionId" );

    const found = await PaymentTransactionModel.findOne( { companyId, transactionId } )
      .lean<PaymentTransactionLean | null>();

    if ( !found ) return null;
    return { item: this.toCoreDto( found ) };
  }

  // ===========================================================================
  // DELETE (RecycleBin DomainDeletePlan) — actor stays AuthUser ✅
  // ===========================================================================

  public async delete( options: {
    actor: AuthUser;
    transactionId: string;
    req: Request;
  } ): Promise<{ deleted: boolean; entry: RecycleRecordResult | null; }> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );
    const transactionId = this.mustString( options.transactionId, "transactionId" );

    const exist = await PaymentTransactionModel.findOne( { companyId, transactionId } )
      .lean<PaymentTransactionLean | null>();

    if ( !exist ) {
      console.error( "[Error:] [PaymentTransactionService:] delete: Transaction does not exist.\n" );
      return { deleted: false, entry: null };
    }

    const refMongoIdStr = MongoIdUtil.toIdString( exist._id );

    const finalEvidenceDir = this.buildFinalEvidenceDir( transactionId );

    const files: FileMetaPacket[] = await FileMetaPacketBuilder.scanTree( {
      bucket: "evidence",
      rootPathLike: finalEvidenceDir,
      req: options.req,
    } );

    const plan: DomainDeletePlan<Record<string, unknown>> = {
      collectionName: PaymentTransactionModel.collection.name,
      description: `Payment transaction has been deleted at ${ new Date().toISOString() }`,
      files,
      label: `Transaction: ${ exist.transactionId } (${ exist.companyId })`,
      refId: refMongoIdStr,
      snapshotData: exist as unknown as Record<string, unknown>,
      sourceKey: "transactions",
      module: "Payment Transaction Management",
      tags: [ "payment", "transaction" ],
      deleteDbRecord: async ( session?: ClientSession ): Promise<void> => {
        const opts = session ? { session } : {};
        await PaymentTransactionModel.deleteOne( { companyId, transactionId }, opts );
      },
    };

    const result = await this.deleteSvc.deleteWithRecycleBin( options.actor, plan, options.req );

    await this.emitNotificationSafe( {
      eventKey: "payment:transaction.deleted",
      actionKey: "payment:transaction.deleted",
      actor: actorN,
      refMongoId: refMongoIdStr,
      module: "Payment Transaction Management",
      params: { transactionId: exist.transactionId },
    } );

    return { deleted: Boolean( result.entry ), entry: result.entry };
  }

  // ===========================================================================
  // LIST / COUNT
  // ===========================================================================

  public async list( options: {
    actor: AuthUser;
    filters?: PaymentTransactionListFilters;
    page: number;
    limit: number;
  } ): Promise<PaymentTransactionListResponseDto> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );

    const safeLimit = this.clamp( options.limit, 1, 500 );
    const safePage = this.clamp( options.page, 1, 1_000_000 );
    const skip = ( safePage - 1 ) * safeLimit;

    const query = this.buildListQuery( companyId, options.filters );

    const [ rows, total ] = await Promise.all( [
      PaymentTransactionModel.find( query )
        .sort( { transactionAt: -1, createdAt: -1 } )
        .skip( skip )
        .limit( safeLimit )
        .lean<PaymentTransactionLean[]>(),
      PaymentTransactionModel.countDocuments( query ),
    ] );

    return { items: rows.map( ( x ) => this.toListItemDto( x ) ), other: { total } };
  }

  public async count( options: {
    actor: AuthUser;
    filters?: PaymentTransactionListFilters;
  } ): Promise<PaymentTransactionCountResponseDto> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );

    const query = this.buildListQuery( companyId, options.filters );

    const [ total, pendingVerification, approved, rejected ] = await Promise.all( [
      PaymentTransactionModel.countDocuments( query ),
      PaymentTransactionModel.countDocuments( {
        ...query,
        verificationStatus: {
          $in: [ PaymentVerificationStatus.Unverified, PaymentVerificationStatus.Submitted ],
        },
      } ),
      PaymentTransactionModel.countDocuments( {
        ...query,
        verificationStatus: PaymentVerificationStatus.Approved,
      } ),
      PaymentTransactionModel.countDocuments( {
        ...query,
        verificationStatus: PaymentVerificationStatus.Rejected,
      } ),
    ] );

    return { other: { total, pendingVerification, approved, rejected } };
  }

  // ===========================================================================
  // APPROVE / REJECT / STATUS
  // ===========================================================================

  public async approve( options: {
    actor: AuthUser;
    transactionId: string;
    input: PaymentTransactionApproveInputDto;
  } ): Promise<PaymentTransactionReadResponseDto> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );
    const transactionId = this.mustString( options.transactionId, "transactionId" );

    const found = await PaymentTransactionModel.findOne( { companyId, transactionId } )
      .lean<PaymentTransactionLean | null>();

    if ( !found ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    const hasEvidence = Array.isArray( found.evidence ) && found.evidence.length > 0;
    if ( !hasEvidence ) throw new Error( "[Error:] Approval requires evidence.\n" );

    const verificationNotes = options.input.notes && this.mustString( options.input.notes, 'verificationNotes' );


    const verifier = this.toActorMini( actorN );
    const now = new Date();

    const setDoc: Record<string, unknown> = {
      verificationStatus: PaymentVerificationStatus.Approved,
      ...( verificationNotes ? { verificationNotes } : {} ),
      verifiedBy: verifier,
      verifiedAt: now,
      updatedBy: verifier,
      updatedAt: now,
    };

    const updated = await PaymentTransactionModel.findOneAndUpdate(
      { companyId, transactionId },
      { $set: setDoc, $unset: { rejectedReason: 1 } },
      { new: true },
    ).lean<PaymentTransactionLean | null>();

    if ( !updated ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    await this.emitNotificationSafe( {
      eventKey: "payment:transaction.approved",
      actionKey: "payment:transaction.approved",
      actor: actorN,
      refMongoId: updated._id,
      module: "Payment Transaction Management",
      params: { transactionId: updated.transactionId },
    } );

    return { item: this.toCoreDto( updated ) };
  }



  public async reject( options: {
    actor: AuthUser;
    transactionId: string;
    input: PaymentTransactionRejectInputDto;
  } ): Promise<PaymentTransactionReadResponseDto> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );
    const transactionId = this.mustString( options.transactionId, "transactionId" );

    const reason = this.mustString( options.input.reason, "reason" );

    const found = await PaymentTransactionModel.findOne( { companyId, transactionId } )
      .lean<PaymentTransactionLean | null>();

    if ( !found ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    const verifier = this.toActorMini( actorN );
    const now = new Date();

    const updated = await PaymentTransactionModel.findOneAndUpdate(
      { companyId, transactionId },
      {
        $set: {
          verificationStatus: PaymentVerificationStatus.Rejected,
          rejectedReason: reason,
          updatedBy: verifier,
          updatedAt: now,
        },
        $unset: { verifiedBy: 1, verifiedAt: 1 },
      },
      { new: true },
    ).lean<PaymentTransactionLean | null>();

    if ( !updated ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    await this.emitNotificationSafe( {
      eventKey: "payment:transaction.rejected",
      actionKey: "payment:transaction.rejected",
      actor: actorN,
      refMongoId: updated._id,
      module: "Payment Transaction Management",
      params: { transactionId: updated.transactionId },
    } );

    return { item: this.toCoreDto( updated ) };
  }


  public async status( options: {
    actor: AuthUser;
    transactionId: string;
    input: PaymentTransactionPaymentStatusInputDto;
  } ): Promise<PaymentTransactionReadResponseDto> {
    const actorN = this.toAuthUserNormalized( options.actor );
    const companyId = this.mustString( actorN.companyId, "actor.companyId" );
    const transactionId = this.mustString( options.transactionId, "transactionId" );

    const found = await PaymentTransactionModel.findOne( { companyId, transactionId } )
      .lean<PaymentTransactionLean | null>();

    if ( !found ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    const hasEvidence = Array.isArray( found.evidence ) && found.evidence.length > 0;
    if ( !hasEvidence ) throw new Error( "[Error:] Approval requires evidence.\n" );

    const paymentStatus = options.input.status && this.mustString( options.input.status, 'paymentStatus' );


    const updator = this.toActorMini( actorN );
    const now = new Date();

    const setDoc: Record<string, unknown> = {
      paymentStatus,
      updatedBy: updator,
      updatedAt: now,
    };

    const updated = await PaymentTransactionModel.findOneAndUpdate(
      { companyId, transactionId },
      { $set: setDoc, $unset: { rejectedReason: 1 } },
      { new: true },
    ).lean<PaymentTransactionLean | null>();

    if ( !updated ) throw new Error( "[Error:] PaymentTransaction not found.\n" );

    await this.emitNotificationSafe( {
      eventKey: "payment:transaction.change.payment.status",
      actionKey: "payment:transaction.change.payment.status",
      actor: actorN,
      refMongoId: updated._id,
      module: "Payment Transaction Management",
      params: { transactionId: updated.transactionId },
    } );

    return { item: this.toCoreDto( updated ) };
  }

  // ===========================================================================
  // Upload helpers (TEMP)
  // ===========================================================================

  private async uploadEvidenceToTemp( options: {
    req: Request;
    tempSubPath: string;
  } ): Promise<UploadResultPacket> {
    return FileUploader.handleMultiFieldUpload(
      options.tempSubPath,
      [
        {
          name: PaymentTransactionService.EVIDENCE_FIELD,
          maxCount: PaymentTransactionService.EVIDENCE_MAX_FILES,
        },
      ],
      options.req,
      {
        allowedMimeTypesByField: PaymentTransactionService.ALLOWED_MIME_BY_FIELD,
        maxFileSizeMb: PaymentTransactionService.EVIDENCE_MAX_MB,
        maxFiles: PaymentTransactionService.EVIDENCE_MAX_FILES,
      },
    );
  }

  private readByField( out: UploadResultPacket, field: string ): FileMetaPacket[] {
    const arr = out?.byField?.[ field ];
    return Array.isArray( arr ) ? arr : [];
  }

  // ===========================================================================
  // FormData payload parsing
  // ===========================================================================

  private mustPayloadFromReq<T extends object>( req: Request, payloadField: string ): T {
    const bodyAny = req.body as unknown;

    const payloadRaw =
      bodyAny && typeof bodyAny === "object"
        ? ( bodyAny as Record<string, unknown> )[ payloadField ]
        : undefined;

    if ( payloadRaw === undefined || payloadRaw === null ) {
      throw new Error( `[Error:] Missing required field: ${ payloadField }\n` );
    }

    if ( typeof payloadRaw === "string" ) {
      const s = payloadRaw.trim();
      if ( !s ) throw new Error( `[Error:] Missing required field: ${ payloadField }\n` );
      try {
        const parsed = JSON.parse( s ) as unknown;
        if ( !parsed || typeof parsed !== "object" ) {
          throw new Error( `[Error:] Invalid ${ payloadField } (must be JSON object).\n` );
        }
        return parsed as T;
      } catch ( err: unknown ) {
        throw new Error( `[Error:] Invalid ${ payloadField } JSON.\n${ String( err ) }\n` );
      }
    }

    if ( typeof payloadRaw === "object" ) return payloadRaw as T;

    throw new Error( `[Error:] Invalid ${ payloadField } (unexpected type).\n` );
  }

  // ===========================================================================
  // Evidence mapping (move meta -> DTO)
  // ===========================================================================

  private extractMoveMeta( moved: FsMoveResult | unknown ): FileMetaPacket[] {
    const any = moved as Record<string, unknown>;
    const meta = any?.meta;
    return Array.isArray( meta ) ? ( meta as FileMetaPacket[] ) : [];
  }

  private toEvidenceDtosFromMoveMeta( meta: FileMetaPacket[] ): PaymentEvidenceDto[] {
    const arr = Array.isArray( meta ) ? meta : [];
    const out: PaymentEvidenceDto[] = [];

    for ( const p of arr ) {
      const originalName =
        this.safeString( ( p as unknown as { originalName?: unknown; } ).originalName ) || "evidence";

      const mimeType =
        this.safeString( ( p as unknown as { mimeType?: unknown; } ).mimeType ) ||
        "application/octet-stream";

      const sizeBytes = this.toNonNegInt( ( p as unknown as { sizeBytes?: unknown; } ).sizeBytes );

      const relativePath = this.safeString( ( p as unknown as { relativePath?: unknown; } ).relativePath );
      if ( !relativePath ) continue;

      const publicUrl = this.safeString( ( p as unknown as { publicUrl?: unknown; } ).publicUrl );

      const uploadedAtIso =
        this.safeString( ( p as unknown as { uploadedAtIso?: unknown; } ).uploadedAtIso ) ||
        new Date().toISOString();

      const dtoBase: PaymentEvidenceDto = {
        evidenceId: randomUUID(),
        label: originalName,
        mime: mimeType,
        sizeBytes,
        publicRel: relativePath,
        uploadedAt: uploadedAtIso as ISODateString,
        ...( publicUrl ? { publicUrl } : {} ),
      };

      out.push( dtoBase );
    }

    return out;
  }

  private toDbEvidence(
    dto: PaymentEvidenceDto,
  ): Omit<PaymentEvidenceDto, "uploadedAt"> & { uploadedAt: Date; } {
    const uploadedAt = new Date( dto.uploadedAt );
    const safe = Number.isNaN( uploadedAt.getTime() ) ? new Date() : uploadedAt;

    return {
      evidenceId: this.mustString( dto.evidenceId, "evidenceId" ),
      label: this.mustString( dto.label, "label" ),
      mime: this.mustString( dto.mime, "mime" ),
      sizeBytes: this.toNonNegInt( dto.sizeBytes ),
      publicRel: this.mustString( dto.publicRel, "publicRel" ),
      uploadedAt: safe,
      ...( this.hasText( dto.publicUrl )
        ? { publicUrl: this.mustString( dto.publicUrl, "publicUrl" ) }
        : {} ),
    };
  }

  private extractRelativePaths( packets: FileMetaPacket[] ): string[] {
    const out: string[] = [];
    for ( const p of packets ) {
      const rel = this.safeString( ( p as unknown as { relativePath?: unknown; } ).relativePath );
      if ( rel ) out.push( rel );
    }
    return out;
  }

  private buildFinalEvidenceDir( transactionId: string ): string {
    // PropEase path rule: relative (no leading "/")
    // IMPORTANT: this is a destinationDir for movePublicFiles (public-relative)
    return `uploads/payments/transactions/${ transactionId }/${ PaymentTransactionService.EVIDENCE_FIELD }`;
  }

  // ===========================================================================
  // Query builder (alias-only)
  // ===========================================================================

  private buildListQuery( companyId: string, filters?: PaymentTransactionListFilters ): FilterQuery<unknown> {
    const q: Record<string, unknown> = { companyId };
    const f = filters ?? {};

    if ( this.hasText( f.bankAccountAlias ) ) {
      q.bankAccountAlias = this.mustString( f.bankAccountAlias, "bankAccountAlias" );
    }

    if ( this.hasText( f.currencyCode ) ) {
      q.currencyCode = this.mustString( f.currencyCode, "currencyCode" ).toUpperCase();
    }

    if ( f.paymentStatus !== undefined ) {
      q.paymentStatus = this.mustPaymentStatus( f.paymentStatus, "paymentStatus" );
    }

    if ( f.verificationStatus !== undefined ) {
      q.verificationStatus = this.mustVerificationStatus( f.verificationStatus, "verificationStatus" );
    }

    if ( f.method !== undefined ) {
      q.method = this.mustPaymentMethod( f.method, "method" );
    }

    if ( this.hasText( f.from ) || this.hasText( f.to ) ) {
      const range: Record<string, Date> = {};
      if ( this.hasText( f.from ) ) range.$gte = new Date( this.mustIso( f.from, "from" ) );
      if ( this.hasText( f.to ) ) range.$lte = new Date( this.mustIso( f.to, "to" ) );
      q.transactionAt = range;
    }

    const search = this.optTrim( f.search );
    if ( search ) {
      const safe = this.escapeRegex( search );
      q.$or = [
        { externalRef: { $regex: safe, $options: "i" } },
        { notes: { $regex: safe, $options: "i" } },
        { bankAccountAlias: { $regex: safe, $options: "i" } },
      ];
    }

    return q;
  }

  // ===========================================================================
  // DTO mappers
  // ===========================================================================

  private toListItemDto( doc: PaymentTransactionLean ): PaymentTransactionListItemDto {
    const base: PaymentTransactionListItemDto = {
      transactionId: this.mustString( doc.transactionId, "transactionId" ),
      companyId: this.mustString( doc.companyId, "companyId" ),
      bankAccountAlias: this.mustString( doc.bankAccountAlias, "bankAccountAlias" ),
      amount: this.mustAmount( doc.amount, "amount" ),
      currencyCode: this.mustString( doc.currencyCode, "currencyCode" ).toUpperCase(),
      method: this.mustPaymentMethod( doc.method, "method" ),
      transactionAt: this.toIso( doc.transactionAt ),
      paymentStatus: this.mustPaymentStatus( doc.paymentStatus, "paymentStatus" ),
      verificationStatus: this.mustVerificationStatus( doc.verificationStatus, "verificationStatus" ),
      createdAt: this.toIso( doc.createdAt ),
      updatedAt: this.toIso( doc.updatedAt ),
    };

    return this.hasText( doc.externalRef )
      ? { ...base, externalRef: this.mustString( doc.externalRef, "externalRef" ) }
      : base;
  }

  private toCoreDto( doc: PaymentTransactionLean ): PaymentTransactionCoreDto {
    const base: PaymentTransactionCoreDto = {
      _id: MongoIdUtil.toIdString( doc._id ),

      transactionId: this.mustString( doc.transactionId, "transactionId" ),
      companyId: this.mustString( doc.companyId, "companyId" ),

      bankAccountAlias: this.mustString( doc.bankAccountAlias, "bankAccountAlias" ),

      amount: this.mustAmount( doc.amount, "amount" ),
      currencyCode: this.mustString( doc.currencyCode, "currencyCode" ).toUpperCase(),

      method: this.mustPaymentMethod( doc.method, "method" ),

      transactionAt: this.toIso( doc.transactionAt ),

      paymentStatus: this.mustPaymentStatus( doc.paymentStatus, "paymentStatus" ),
      verificationStatus: this.mustVerificationStatus( doc.verificationStatus, "verificationStatus" ),
      ...( doc.verificationNotes ? { verificationNotes: this.mustString( doc.verificationNotes, 'verificationNotes' ) } : {} ),

      createdBy: this.mustActorMini( doc.createdBy ),
      createdAt: this.toIso( doc.createdAt ),
      updatedAt: this.toIso( doc.updatedAt ),
    };

    const withExternalRef = this.hasText( doc.externalRef )
      ? { ...base, externalRef: this.mustString( doc.externalRef, "externalRef" ) }
      : base;

    const withVerifiedBy = doc.verifiedBy
      ? { ...withExternalRef, verifiedBy: this.mustActorMini( doc.verifiedBy ) }
      : withExternalRef;

    const withVerifiedAt =
      doc.verifiedAt !== undefined && doc.verifiedAt !== null
        ? { ...withVerifiedBy, verifiedAt: this.toIso( doc.verifiedAt ) }
        : withVerifiedBy;

    const withRejectedReason = this.hasText( doc.rejectedReason )
      ? { ...withVerifiedAt, rejectedReason: this.mustString( doc.rejectedReason, "rejectedReason" ) }
      : withVerifiedAt;

    const withNotes = this.hasText( doc.notes )
      ? { ...withRejectedReason, notes: this.mustString( doc.notes, "notes" ) }
      : withRejectedReason;

    const evidenceArr = Array.isArray( doc.evidence ) ? doc.evidence : [];
    const withEvidence =
      evidenceArr.length > 0
        ? { ...withNotes, evidence: evidenceArr.map( ( e ) => this.toEvidenceDto( e ) ) }
        : withNotes;

    const withUpdatedBy = doc.updatedBy
      ? { ...withEvidence, updatedBy: this.mustActorMini( doc.updatedBy ) }
      : withEvidence;

    return withUpdatedBy;
  }

  private toEvidenceDto(
    e: Omit<PaymentEvidenceDto, "uploadedAt"> & { uploadedAt: Date | string; },
  ): PaymentEvidenceDto {
    const evidenceId = this.mustString( e.evidenceId, "evidenceId" );
    const label = this.mustString( e.label, "label" );
    const mime = this.mustString( e.mime, "mime" );
    const sizeBytes = this.toNonNegInt( e.sizeBytes );
    const publicRel = this.mustString( e.publicRel, "publicRel" );
    const uploadedAt = this.toIso( e.uploadedAt );

    const publicUrl = this.optTrim( ( e as unknown as { publicUrl?: unknown; } ).publicUrl );
    return publicUrl
      ? { evidenceId, label, mime, sizeBytes, publicRel, publicUrl, uploadedAt }
      : { evidenceId, label, mime, sizeBytes, publicRel, uploadedAt };
  }

  // ===========================================================================
  // Actor helpers
  // ===========================================================================

  private toActorMini( actor: AuthUserNormalized ): ActorMini {
    const userId = this.mustString( actor.userId, "actor.userId" );
    const username = this.mustString( actor.username, "actor.username" );
    const role = this.optTrim( actor.role );
    return role ? { userId, username, role } : { userId, username };
  }

  private mustActorMini( actor: ActorMini ): ActorMini {
    const userId = this.mustString( actor.userId, "actorMini.userId" );
    const username = this.mustString( actor.username, "actorMini.username" );
    const role = this.optTrim( actor.role );
    return role ? { userId, username, role } : { userId, username };
  }

  // ===========================================================================
  // Validation helpers
  // ===========================================================================

  private mustPaymentMethod( input: unknown, fieldName: string ): PaymentMethodKind {
    const v = this.mustString( input, fieldName ) as PaymentMethodKind;
    if ( !Object.values( PaymentMethodKind ).includes( v ) ) {
      throw new Error( `[Error:] Invalid ${ fieldName }.\n` );
    }
    return v;
  }

  private mustPaymentStatus( input: unknown, fieldName: string ): PaymentStatus {
    const v = this.mustString( input, fieldName ) as PaymentStatus;
    if ( !Object.values( PaymentStatus ).includes( v ) ) {
      throw new Error( `[Error:] Invalid ${ fieldName }.\n` );
    }
    return v;
  }

  private mustVerificationStatus( input: unknown, fieldName: string ): PaymentVerificationStatus {
    const v = this.mustString( input, fieldName ) as PaymentVerificationStatus;
    if ( !Object.values( PaymentVerificationStatus ).includes( v ) ) {
      throw new Error( `[Error:] Invalid ${ fieldName }.\n` );
    }
    return v;
  }

  private mustAmount( input: unknown, fieldName: string ): number {
    const n = typeof input === "number" ? input : Number( input );
    if ( !Number.isFinite( n ) || n <= 0 ) {
      throw new Error( `[Error:] Invalid ${ fieldName }.\n` );
    }
    return Math.round( n * 100 ) / 100;
  }

  private mustIso( input: unknown, fieldName: string ): ISODateString {
    const v = this.mustString( input, fieldName );
    const d = new Date( v );
    if ( Number.isNaN( d.getTime() ) ) {
      throw new Error( `[Error:] Invalid ${ fieldName }.\n` );
    }
    return d.toISOString();
  }

  // ===========================================================================
  // Misc helpers
  // ===========================================================================

  private newTransactionId(): string {
    return randomUUID();
  }

  private hasText( input?: unknown ): boolean {
    return Boolean( this.optTrim( input ) );
  }

  private optTrim( input?: unknown ): string | null {
    const v = this.safeTrim( input );
    return v ? v : null;
  }

  private safeTrim( input?: unknown ): string {
    if ( input === null || input === undefined ) return "";
    return String( input ).trim();
  }

  private safeString( input: unknown ): string {
    return this.safeTrim( input );
  }

  private mustString( input: unknown, fieldName: string ): string {
    const v = this.safeTrim( input );
    if ( !v ) throw new Error( `[Error:] Missing required field: ${ fieldName }\n` );
    return v;
  }

  private clamp( value: number, min: number, max: number ): number {
    const n = Number( value );
    if ( !Number.isFinite( n ) ) return min;
    if ( n < min ) return min;
    if ( n > max ) return max;
    return n;
  }

  private escapeRegex( input: string ): string {
    return input.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
  }

  private toIso( value: Date | string ): ISODateString {
    if ( value instanceof Date ) return value.toISOString();
    const d = new Date( value );
    if ( Number.isNaN( d.getTime() ) ) return new Date().toISOString();
    return d.toISOString();
  }

  private toNonNegInt( input: unknown ): number {
    const n = typeof input === "number" ? input : Number( input );
    if ( !Number.isFinite( n ) || n < 0 ) return 0;
    return Math.floor( n );
  }

  private applyOptSetOrUnset(
    setDoc: Record<string, unknown>,
    unsetDoc: Record<string, 1>,
    field: string,
    incoming?: string,
  ): void {
    if ( incoming === undefined ) return;
    const v = this.optTrim( incoming );
    if ( !v ) {
      unsetDoc[ field ] = 1;
      return;
    }
    setDoc[ field ] = v;
  }

  private mergeNotes( current: string | undefined, add: string ): string {
    const cur = this.optTrim( current ) ?? "";
    const line = this.mustString( add, "noteLine" );
    return cur ? `${ cur }\n${ line }` : line;
  }

  // ===========================================================================
  // Notifications (safe)
  // ===========================================================================

  private async emitNotificationSafe( options: {
    eventKey: NotificationActionKey;
    actionKey: NotificationActionKey;
    actor: AuthUserNormalized;
    refMongoId: unknown;
    module: string;
    params: Record<string, unknown>;
  } ): Promise<void> {
    const refId = MongoIdUtil.toIdString( options.refMongoId );

    try {
      await this.notificationHub.emit( {
        eventKey: options.eventKey,
        actor: options.actor,
        audiences: [
          { mode: "Role", roleKey: "admin" },
          { mode: "Role", roleKey: "cfo" },
          { mode: "Role", roleKey: "ceo" },
          { mode: "Role", roleKey: "cio" },
          { mode: "Role", roleKey: "coo" },
          { mode: "Role", roleKey: "cto" },
        ],
        target: {
          actionKey: options.actionKey,
          category: "Payment",
          params: { ...options.params, refId },
          refId,
          module: options.module,
        },
      } );
    } catch {
      console.error( "[Warning:] [PaymentTransactionService:] emitNotificationSafe: emit failed.\n" );
    }
  }

  private toAuthUserNormalized( actor: AuthUser ): AuthUserNormalized {
    return { ...actor, userId: MongoIdUtil.toIdString( actor.userId ) };
  }
}

export default PaymentTransactionService;