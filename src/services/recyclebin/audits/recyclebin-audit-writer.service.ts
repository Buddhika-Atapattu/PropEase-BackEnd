// Path: src/services/recyclebin/audits/recyclebin-audit-writer.service.ts
// =============================================================================
// RecycleBinAuditWriterService (Facade)
// -----------------------------------------------------------------------------
// PURPOSE:
// - Provide a stable "writer API" for the engine/controller.
// - Internally writes JSONL records using RecycleBinAuditFileService.
// - Keeps engine decoupled from file naming/month parts/size caps.
// =============================================================================

import type { ClientSession } from "mongoose";
import type { AuthUser } from "../../../types/common";

import {
  RecycleBinAuditFileService,
  type RecycleBinAuditAction,
  type RecycleBinAuditContext,
  type RecycleBinAuditRecord,
  type RecycleBinAuditTarget,
} from "./recyclebin-audit-file.service";

/**
 * Engine-friendly target core.
 * We keep it minimal so the engine doesn't need to know audit file schema details.
 */
export interface RecycleBinAuditTargetCore {
  entryId?: string;
  sourceKey?: string;
  refId?: string;
  label?: string;
}

export class RecycleBinAuditWriterService {
  private readonly file: RecycleBinAuditFileService;

  public constructor() {
    // No constructor params (your rule)
    this.file = new RecycleBinAuditFileService();
  }

  // ---------------------------------------------------------------------------
  // Engine hooks (the engine calls these)
  // ---------------------------------------------------------------------------

  public async recordRecycleCreated(
    target: RecycleBinAuditTargetCore,
    actor: AuthUser,
    _session?: ClientSession
  ): Promise<void> {
    // "soft_delete_recorded" = deletion successfully recorded into recycle bin
    await this.append("rb.soft_delete_recorded", actor, target, { message: "Recycle entry recorded" });
  }

  public async recordRestorePrepared(
    target: RecycleBinAuditTargetCore,
    actor: AuthUser,
    _session?: ClientSession
  ): Promise<void> {
    await this.append("rb.restore", actor, target, { message: "Restore prepared" });
  }

  public async recordRestored(
    target: RecycleBinAuditTargetCore,
    actor: AuthUser,
    _session?: ClientSession
  ): Promise<void> {
    await this.append("rb.restore", actor, target, { message: "Restore completed" });
  }

  public async recordPurged(
    target: RecycleBinAuditTargetCore,
    actor: AuthUser,
    _session?: ClientSession
  ): Promise<void> {
    await this.append("rb.purge", actor, target, { message: "Recycle entry purged" });
  }

  // ---------------------------------------------------------------------------
  // Controller hooks (optional — use in controller/router)
  // ---------------------------------------------------------------------------

  public async recordList(actor: AuthUser, ctx?: RecycleBinAuditContext): Promise<void> {
    await this.append("rb.list", actor, undefined, { message: "Listed recycle entries" }, ctx);
  }

  public async recordCount(actor: AuthUser, ctx?: RecycleBinAuditContext): Promise<void> {
    await this.append("rb.count", actor, undefined, { message: "Counted recycle entries" }, ctx);
  }

  public async recordViewSnapshot(
    target: RecycleBinAuditTargetCore,
    actor: AuthUser,
    ctx?: RecycleBinAuditContext
  ): Promise<void> {
    await this.append("rb.view_snapshot", actor, target, { message: "Viewed snapshot" }, ctx);
  }

  public async recordDenied(
    actor: AuthUser,
    reason: string,
    ctx?: RecycleBinAuditContext,
    target?: RecycleBinAuditTargetCore
  ): Promise<void> {
    await this.append("rb.denied", actor, target, { ok: false, error: reason }, ctx);
  }

  public async recordError(
    actor: AuthUser,
    err: unknown,
    ctx?: RecycleBinAuditContext,
    target?: RecycleBinAuditTargetCore
  ): Promise<void> {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await this.append("rb.error", actor, target, { ok: false, error: msg }, ctx);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async append(
    action: RecycleBinAuditAction,
    actor: AuthUser,
    target?: RecycleBinAuditTargetCore,
    result?: { ok?: boolean; message?: string; error?: string },
    ctx?: RecycleBinAuditContext
  ): Promise<void> {
    // Build JSONL record. We only include optional objects when they exist.
    // This respects exactOptionalPropertyTypes (omit instead of setting undefined).
    const rec: RecycleBinAuditRecord = {
      ts: new Date().toISOString(),
      action,
      actor,
      result: {
        ok: result?.ok ?? true,
        ...(result?.message ? { message: result.message } : {}),
        ...(result?.error ? { error: result.error } : {}),
      },
      ...(target ? { target: this.toTarget(target) } : {}),
      ...(ctx ? { ctx } : {}),
    };

    await this.file.append(rec);
  }

  private toTarget(core: RecycleBinAuditTargetCore): RecycleBinAuditTarget {
    // Build target with conditional fields only.
    const out: RecycleBinAuditTarget = {};

    if (core.entryId) out.entryId = core.entryId;
    if (core.sourceKey) out.sourceKey = core.sourceKey;
    if (core.refId) out.refId = core.refId;
    if (core.label) out.label = core.label;

    return out;
  }
}
