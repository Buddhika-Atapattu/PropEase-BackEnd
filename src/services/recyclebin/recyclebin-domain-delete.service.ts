// Path: src/services/recyclebin/recyclebin-domain-delete.service.ts
// =============================================================================
// RecycleBinDomainDeleteService
// - A reusable helper that domain services call to perform safe deletes
// - Handles: snapshot build + recycle record + db delete + compensation
// =============================================================================

import { Types, type ClientSession, startSession } from "mongoose";

import type { AuthUser } from "../../types/common";
import type { FileMetaPacket } from "../../types/common";
import { RecycleBinEngineService, type RecycleRecordResult } from "./recyclebin-engine.service";

export interface DomainDeletePlan<TDoc> {
  sourceKey: string;              // ex: "teamTask"
  refId: string;                  // domain id string
  label: string;                  // UI label
  description?: string;           // optional

  snapshotData: Record<string, unknown>; // JSON-safe snapshot of doc
  files: FileMetaPacket[];              // ORIGINAL file packets (before moving)

  // DB delete callback (must use session)
  deleteDbRecord: (session: ClientSession) => Promise<void>;

  // optional: custom tags for recycle list filters
  tags?: string[];
  module?: string;
  entity?: string;
  extra?: Record<string, unknown>;
}

export class RecycleBinDomainDeleteService {
  private readonly engine: RecycleBinEngineService;

  public constructor() {
    this.engine = new RecycleBinEngineService();
  }

  public async deleteWithRecycleBin<TDoc>(
    actor: AuthUser,
    plan: DomainDeletePlan<TDoc>
  ): Promise<{ entry: RecycleRecordResult }> {
    // Keep a copy of ORIGINAL file packets for compensation.
    // IMPORTANT: engine.record will rewrite packets to recycle paths.
    const originalFiles: FileMetaPacket[] = plan.files.map((f) => ({ ...f }));

    // 1) Record first (durability)
    let recorded: RecycleRecordResult | null = null;
    recorded = await this.engine.record(
      {
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
      }
    );

    // 2) Delete DB record inside a session (DB consistency)
    const session = await startSession();
    try {
      await session.withTransaction(async () => {
        await plan.deleteDbRecord(session);
      });

      // If transaction commits, we keep recycle entry as recorded.
      return { entry: recorded };
    } catch (err: unknown) {
      // 3) Compensation (DB delete failed)
      // At this point: files are already moved to recyclebin.
      // If you want "no recycle entry unless delete succeeds", do:
      // - move files back using originalFiles (requires a helper)
      // - purge the recycle entry

      try {
        // If you later add a helper like engine.rollbackRecord(entryId, originalFiles),
        // call it here. For now, simplest is purge.
        await this.engine.purge(recorded.entryId, actor);
      } catch {
        // best-effort: don't hide the original error
      }

      throw err instanceof Error ? err : new Error("deleteWithRecycleBin failed");
    } finally {
      await session.endSession();
    }
  }
}
