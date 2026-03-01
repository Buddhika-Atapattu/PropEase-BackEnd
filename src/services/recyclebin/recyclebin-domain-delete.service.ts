// Path: src/services/recyclebin/recyclebin-domain-delete.service.ts
// =============================================================================
// RecycleBinDomainDeleteService (Tx-aware, Standalone-safe, Non-breaking)
// =============================================================================
// ✅ Goals (your requirements)
// 1) Record → Delete DB → (best-effort) compensation
// 2) Works on BOTH:
//    A) Replica set / mongos  -> uses transactions
//    B) Standalone Mongo      -> NO transactions, NO session usage
// 3) Non-breaking for callers
//    - Existing callers that implement: deleteDbRecord(session?) => Promise<void>
//      will keep working.
//    - New callers MAY return extra info (collectionName) without changing behavior.
// 4) Helps RecycleBinEngine record the DB collection name
//    - Prefer: plan.collectionName (best)
//    - Else: deleteDbRecord() may return { collectionName }
//    - Else: plan.extra.recycle.collectionName if provided
//
// ⚠️ Security / correctness notes
// - Always record FIRST (durability-first design).
// - Never pass { session: undefined } (exactOptionalPropertyTypes safe).
// - If DB delete fails AFTER recording, we purge recycle entry best-effort.
// =============================================================================

import mongoose, { type ClientSession, startSession } from "mongoose";

import type { AuthUser } from "../../types/common";
import type { FileMetaPacket } from "../../types/common";

import {
  RecycleBinEngineService,
  type RecycleRecordResult,
} from "./recyclebin-engine.service";

/* =============================================================================
 * A) Service-level contracts
 * ========================================================================== */

/**
 * Optional extra info returned by deleteDbRecord.
 * (Non-breaking: callers may still return void.)
 */
export interface DomainDeleteDbResult {
  /**
   * @param collectionName
   * - DB collection where the domain record was deleted from.
   * - Example: "users", "leases", "properties"
   * - Purpose: allow RecycleBin restore to re-insert into correct collection.
   */
  collectionName?: string;
}

/**
 * DomainDeletePlan (caller contract)
 * - Provides everything needed for durable recycle bin record + domain delete.
 */
export interface DomainDeletePlan<TDoc> {
  /**
   * @param sourceKey
   * - Appears under: public/recyclebin/<sourceKey>/<refId> (after engine normalizes)
   * - Example: "user", "lease", "property"
   */
  sourceKey: string;

  /**
   * @param refId
   * - Domain identifier used to name the recycle folder.
   * - Example: username, leaseID, propertyId
   */
  refId: string;

  /**
   * @param label
   * - Human readable label for UI list row
   */
  label: string;

  /**
   * @param description
   * - Optional description shown in recycle bin UI
   */
  description?: string;

  /**
   * @param snapshotData
   * - Must contain all data required to restore the record.
   * - Keep as JSON-safe object (no Mongoose documents if possible).
   */
  snapshotData: Record<string, unknown>;

  /**
   * @param files
   * - File packets that belong to the deleted entity.
   * - Engine will move these to recyclebin and rewrite packets.
   */
  files: FileMetaPacket[];

  /**
   * @param collectionName
   * - Optional but recommended.
   * - This is the DB collection that owned the deleted record.
   * - If omitted, this service will try to capture it from:
   *   A) deleteDbRecord() return value
   *   B) extra.recycle.collectionName
   */
  collectionName: string;

  /**
   * deleteDbRecord(session?)
   * ---------------------------------------------------------------
   * - If transactions are supported, service provides a ClientSession.
   * - If Mongo is standalone, service calls WITHOUT session.
   *
   * IMPORTANT (exactOptionalPropertyTypes-safe):
   * - Your implementation MUST omit { session } when session is not provided.
   *
   * Non-breaking enhancement:
   * - You MAY return { collectionName } (optional).
   */
  deleteDbRecord: ( session?: ClientSession ) => Promise<void | DomainDeleteDbResult>;

  /**
   * Optional metadata
   */
  tags?: string[];
  module?: string;
  entity?: string;

  /**
   * @param extra
   * - Arbitrary metadata stored in recycle entry.
   * - If you want, you may provide:
   *   extra.recycle = { collectionName: "users" }
   */
  extra?: Record<string, unknown>;
}

/* =============================================================================
 * B) Domain delete service
 * ========================================================================== */

export class RecycleBinDomainDeleteService {
  private readonly engine: RecycleBinEngineService;

  /**
   * 01) Why this class and for what
   * - Central helper to enforce the PropEase recycle bin deletion pattern:
   *   RECORD → DELETE → (optional) COMPENSATION.
   *
   * 02) Param usage and purpose
   * - No params; engine is created internally.
   *
   * 03) Usage hint
   * - Call deleteWithRecycleBin(actor, plan) from any module controller/service.
   *
   * 04) Reason to use this class
   * - Prevents scattered, inconsistent delete flows across modules.
   * - Removes dev-time crash on standalone Mongo (no transaction support).
   *
   * 05) Avoid
   * - Avoid deleting DB first. If you delete first, you lose durability on crash.
   *
   * 06) Result
   * - Returns recycle entry info (entryId + paths) for UI/notification usage.
   *
   * 07) Return values hint pattern
   * - { entry: RecycleRecordResult }
   */
  public constructor() {
    this.engine = new RecycleBinEngineService();
  }

  /**
   * Record to Recycle Bin FIRST, then delete the domain DB record.
   *
   * 01) Why this method and for what
   * - Ensures durability-first deletion: snapshot + files safely stored BEFORE delete.
   *
   * 02) Param usage and purpose
   * @param actor
   * - Authenticated actor identity used for attribution/audit.
   *
   * @param plan
   * - DomainDeletePlan containing snapshot/files and the actual DB delete callback.
   *
   * 03) Usage hint
   * - In controller:
   *   await recycleDelete.deleteWithRecycleBin(authUser, {
   *     sourceKey: "user",
   *     refId: username,
   *     label: `User: ${name}`,
   *     collectionName: UserModel.collection.name, // ✅ best
   *     snapshotData: { user: userDocLean, restoreHints: { username } },
   *     files: filePackets,
   *     deleteDbRecord: async (session?) => {
   *       const opts = session ? { session } : {};
   *       await UserModel.deleteOne({ username }, opts);
   *       return { collectionName: UserModel.collection.name }; // optional
   *     },
   *   });
   *
   * 04) Reason to use this method
   * - Prevents permanent loss, enables real restore later.
   *
   * 05) What we need to avoid
   * - Avoid passing non-JSON (full Mongoose docs) in snapshotData.
   * - Avoid returning { session: undefined } from your deleteDbRecord implementation.
   *
   * 06) What result method generates
   * - A recyclebin DB entry + snapshot.json/meta.json on disk + moved files.
   *
   * 07) Return values hint pattern
   * @returns Promise<{ entry: RecycleRecordResult }>
   */
  public async deleteWithRecycleBin<TDoc>(
    actor: AuthUser,
    plan: DomainDeletePlan<TDoc>
  ): Promise<{ entry: RecycleRecordResult }> {
    // Keep a copy of ORIGINAL packets for fallback safety.
    // IMPORTANT: engine.record may rewrite packets (paths) to recyclebin.
    const originalFiles: FileMetaPacket[] = Array.isArray( plan.files )
      ? plan.files.map( ( f ) => ( { ...f } ) )
      : [];

    // Decide collectionName to record (non-breaking, best-effort).
    // Priority:
    // 1) plan.collectionName (best)
    // 2) plan.extra.recycle.collectionName (if provided)
    // 3) deleteDbRecord() return value (captured later, if any)
    let collectionName: string | undefined =
      this.pickNonEmpty( plan.collectionName ) ??
      this.pickNonEmpty( this.readExtraRecycleCollectionName( plan.extra ) );

    // 1) Record first (durability)
    const recorded = await this.engine.record(
      {
        sourceKey: plan.sourceKey,
        refId: plan.refId,
        label: plan.label,

        ...( this.pickNonEmpty( plan.description ) ? { description: plan.description } : {} ),

        deletedBy: actor,
        snapshotData: plan.snapshotData,

        // Prefer plan.files. If plan.files is empty, fallback to originalFiles.
        files: Array.isArray( plan.files ) && plan.files.length > 0 ? plan.files : originalFiles,

        ...( Array.isArray( plan.tags ) && plan.tags.length > 0 ? { tags: plan.tags } : {} ),
        ...( this.pickNonEmpty( plan.module ) ? { module: plan.module } : {} ),
        ...( this.pickNonEmpty( plan.entity ) ? { entity: plan.entity } : {} ),
        ...( plan.extra && Object.keys( plan.extra ).length > 0 ? { extra: plan.extra } : {} ),

        // ✅ New (optional) engine input. If your engine supports it, it will record it.
        ...( collectionName ? { collectionName } : {} ),
      },
      undefined // do NOT pass session here; record is durability-first and can be outside tx.
    );

    // 2) Delete DB record (Tx-aware)
    const txSupported = await this.isMongoTransactionSupported();

    try {
      if (txSupported) {
        // Replica set / mongos path
        const session = await startSession();

        try {
          // If you later want record+delete in one TX, you can refactor:
          // - but right now, you explicitly said you are NOT using transactions.
          await session.withTransaction(async () => {
            const delResult = await this.runDeleteDbRecord( plan, session );
            const delCollection = this.pickNonEmpty( delResult?.collectionName );

            // If delete callback provided better collectionName, keep it for restore.
            if ( !collectionName && delCollection ) {
              collectionName = delCollection;
            }
          });

          return { entry: recorded };
        } finally {
          await session.endSession();
        }
      }

      // Standalone path (NO transaction, NO session)
      const delResult = await this.runDeleteDbRecord( plan, undefined );
      const delCollection = this.pickNonEmpty( delResult?.collectionName );

      if ( !collectionName && delCollection ) {
        collectionName = delCollection;
      }

      return { entry: recorded };
    } catch (err: unknown) {
      // 3) Compensation (DB delete failed after recording)
      // Current policy: purge recycle entry best-effort to avoid orphan recycle rows.
      try {
        await this.engine.purge(recorded.entryId, actor);
      } catch {
        // best-effort only
      }

      throw err instanceof Error ? err : new Error("deleteWithRecycleBin failed");
    }
  }

  /* =============================================================================
   * INTERNAL: run delete callback safely (never pass undefined session)
   * ========================================================================== */

  /**
   * Why this method
   * - Enforces exactOptionalPropertyTypes-safe calling pattern for deleteDbRecord.
   *
   * @param plan
   * - The deletion plan containing the callback.
   *
   * @param session
   * - Optional session. If undefined, we call deleteDbRecord() WITHOUT arguments.
   *
   * @returns Promise<DomainDeleteDbResult | undefined>
   * - Returns optional extra info if caller returned it.
   */
  private async runDeleteDbRecord<TDoc>(
    plan: DomainDeletePlan<TDoc>,
    session: ClientSession | undefined
  ): Promise<DomainDeleteDbResult | undefined> {
    const res = session ? await plan.deleteDbRecord( session ) : await plan.deleteDbRecord();
    if ( !res ) return undefined;

    // Caller may return anything; we only accept safe shape.
    if ( typeof res === "object" && res !== null ) {
      const r = res as Record<string, unknown>;
      const cn = typeof r[ "collectionName" ] === "string" ? ( r[ "collectionName" ] as string ) : undefined;
      return cn ? { collectionName: cn } : {};
    }

    return undefined;
  }

  /* =============================================================================
   * INTERNAL: environment capability check
   * ========================================================================== */

  /**
   * Detect whether MongoDB supports transactions.
   *
   * @returns Promise<boolean>
   * - true  => replica set member OR mongos (transactions supported)
   * - false => standalone or unknown (no transaction)
   *
   * Notes
   * - Uses `hello: 1` (replacement for isMaster).
   */
  private async isMongoTransactionSupported(): Promise<boolean> {
    try {
      if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
        return false;
      }

      const admin = mongoose.connection.db.admin();
      const hello = (await admin.command({ hello: 1 })) as Record<string, unknown>;

      const setName = typeof hello[ "setName" ] === "string" ? ( hello[ "setName" ] as string ) : "";
      const msg = typeof hello["msg"] === "string" ? (hello["msg"] as string) : "";

      if (setName.trim().length > 0) return true;
      if (msg === "isdbgrid") return true;

      return false;
    } catch {
      return false;
    }
  }

  /* =============================================================================
   * INTERNAL: small helpers
   * ========================================================================== */

  private pickNonEmpty( v: unknown ): string | undefined {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length > 0 ? s : undefined;
  }

  private readExtraRecycleCollectionName( extra?: Record<string, unknown> ): string | undefined {
    if ( !extra || typeof extra !== "object" ) return undefined;

    const recycle = ( extra as Record<string, unknown> )[ "recycle" ];
    if ( !recycle || typeof recycle !== "object" ) return undefined;

    const cn = ( recycle as Record<string, unknown> )[ "collectionName" ];
    return typeof cn === "string" ? cn : undefined;
  }
}