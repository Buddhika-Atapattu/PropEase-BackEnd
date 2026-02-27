// Path: src/services/recyclebin/recyclebin-domain-delete.service.ts
// =============================================================================
// RecycleBinDomainDeleteService (Tx-aware)
// =============================================================================
// 01) Introduction
// - Central helper to perform: Record → Delete DB → (optional) Compensation
// - Works in BOTH environments:
//    A) Replica set / mongos  -> uses transactions
//    B) Standalone Mongo      -> no transactions, no session usage
//
// 02) Important matters
// - Mongo transactions require replica set or mongos.
// - Standalone Mongo will throw:
//   "Transaction numbers are only allowed on a replica set member or mongos"
// - We therefore detect capability via { hello: 1 } and decide.
//
// 03) Why we make this class / method
// - Keep RecycleBin durability-first design intact.
// - Remove dev-time crash on standalone Mongo.
// - Preserve production correctness when you switch to replica set later.
//
// =============================================================================

import mongoose, { type ClientSession, startSession } from "mongoose";

import type { AuthUser } from "../../types/common";
import type { FileMetaPacket } from "../../types/common";
import {
  RecycleBinEngineService,
  type RecycleRecordResult,
} from "./recyclebin-engine.service";

export interface DomainDeletePlan<TDoc> {
  sourceKey: string; // appears under public/recyclebin/<sourceKey>/<refId>
  refId: string; // domain identifier
  label: string; // UI label
  description?: string;

  snapshotData: Record<string, unknown>;
  files: FileMetaPacket[];

  // ===============================================================
  // deleteDbRecord(session?)
  // - If transactions are supported, service provides a ClientSession.
  // - If Mongo is standalone, service calls WITHOUT session.
  // - Your implementation MUST omit { session } when session is not provided.
  // ===============================================================
  deleteDbRecord: (session?: ClientSession) => Promise<void>;

  tags?: string[];
  module?: string;
  entity?: string;
  extra?: Record<string, unknown>;
}

export class RecycleBinDomainDeleteService {
  private readonly engine: RecycleBinEngineService;

  /**
   * Create the domain delete service.
   *
   * @param none
   * - This class builds its own engine instance.
   *
   * Usage hint:
   * - Call deleteWithRecycleBin(actor, plan) from any domain controller/service.
   *
   * Keep in mind:
   * - This service records to recycle bin FIRST (durability), then deletes DB.
   */
  public constructor() {
    this.engine = new RecycleBinEngineService();
  }

  /**
   * Record to Recycle Bin FIRST, then delete the domain DB record.
   *
   * @param actor
   * - Expected: authenticated user identity (AuthUser)
   * - Used for recycle entry attribution + purge compensation audit
   *
   * @param plan
   * - Expected: DomainDeletePlan<TDoc>
   * - Contains snapshot + file packets + delete callback
   *
   * Keep in mind:
   * - If DB delete fails after recording, we best-effort purge the recycle entry.
   *   (You can later replace this with a rollback restore of files if needed.)
   */
  public async deleteWithRecycleBin<TDoc>(
    actor: AuthUser,
    plan: DomainDeletePlan<TDoc>
  ): Promise<{ entry: RecycleRecordResult }> {
    // Keep a copy of ORIGINAL file packets for compensation.
    // IMPORTANT: engine.record may rewrite packets to recycle paths.
    const originalFiles: FileMetaPacket[] = plan.files.map((f) => ({ ...f }));

    // 1) Record first (durability)
    const recorded = await this.engine.record({
      sourceKey: plan.sourceKey,
      refId: plan.refId,
      label: plan.label,
      ...(plan.description ? { description: plan.description } : {}),
      deletedBy: actor,
      snapshotData: plan.snapshotData,
      files: plan.files ?? originalFiles,
      ...(plan.tags && plan.tags.length ? { tags: plan.tags } : {}),
      ...(plan.module ? { module: plan.module } : {}),
      ...(plan.entity ? { entity: plan.entity } : {}),
      ...(plan.extra ? { extra: plan.extra } : {}),
    });

    // 2) Delete DB record (Tx-aware)
    const txSupported = await this.isMongoTransactionSupported();

    try {
      if (txSupported) {
        // Replica set / mongos path
        const session = await startSession();

        try {
          await session.withTransaction(async () => {
            await plan.deleteDbRecord(session);
          });

          return { entry: recorded };
        } finally {
          await session.endSession();
        }
      }

      // Standalone path (NO transaction, NO session)
      await plan.deleteDbRecord();

      return { entry: recorded };
    } catch (err: unknown) {
      // 3) Compensation (DB delete failed after recording)
      // At this point files are already moved to recyclebin.
      // Current approach: purge the recycle entry best-effort.
      try {
        await this.engine.purge(recorded.entryId, actor);
      } catch {
        // best-effort only — do not hide the original error
      }

      throw err instanceof Error ? err : new Error("deleteWithRecycleBin failed");
    }
  }

  /**
   * Detect whether MongoDB supports transactions.
   *
   * @returns Promise<boolean>
   * - true  => replica set member OR mongos (transactions supported)
   * - false => standalone or unknown (no transaction)
   *
   * Important:
   * - Uses `hello: 1` (modern replacement for isMaster).
   * - Result is safe for your environment switching later.
   */
  private async isMongoTransactionSupported(): Promise<boolean> {
    try {
      // If not connected, we cannot reliably detect; be safe and return false.
      if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
        return false;
      }

      // Admin hello — works on modern Mongo.
      const admin = mongoose.connection.db.admin();
      const hello = (await admin.command({ hello: 1 })) as Record<string, unknown>;

      // Replica set nodes include setName.
      const setName = typeof hello["setName"] === "string" ? (hello["setName"] as string) : "";

      // Mongos returns msg: "isdbgrid".
      const msg = typeof hello["msg"] === "string" ? (hello["msg"] as string) : "";

      if (setName.trim().length > 0) return true;
      if (msg === "isdbgrid") return true;

      return false;
    } catch {
      return false;
    }
  }
}