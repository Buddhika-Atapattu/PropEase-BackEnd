// ============================================================================
// Path: src/KPIs/services/kpi-ingest.service.ts
// ============================================================================

import { Types } from 'mongoose';
import { KpiModelAdapter } from '../data/kpi-model.adapter';

import type { KpiDealFactDto } from '../dtos/kpi-deal-fact.dto';
import type { KpiSatisfactionFactDto } from '../dtos/kpi-satisfaction-fact.dto';
import type { KpiMaintenanceEventDto } from '../dtos/kpi-maintenance-event.dto';
import type { KpiTeamTaskFactDto } from '../dtos/kpi-team-task-fact.dto';
import type { KpiTeamTaskEvidenceDto } from '../dtos/kpi-team-task-evidence.dto';
import type { KpiTeamTaskEventDto } from '../dtos/kpi-team-task-event.dto';

import type { IKpiSignalBus } from '../shared/kpi-signal-bus.interface';
import type { KpiDomain, KpiScope } from '../shared/kpi-core.types';
import type { KpiSignalPayload, KpiSignalType } from '../shared/kpi-signal.types';

export class KpiIngestService {
  private readonly bus: IKpiSignalBus;

  public constructor(bus: IKpiSignalBus) {
    this.bus = bus;
  }

  // =========================================================================
  // Deal Fact (append-only)
  // =========================================================================
  public async ingestDealFact(dto: KpiDealFactDto): Promise<string> {
    const Deal = KpiModelAdapter.getDealFactModel();

    const payload: Record<string, unknown> = {
      orgId: this.toObjectId(dto.orgId),
      agentId: this.toObjectId(dto.agentId),

      dealType: dto.dealType,
      status: dto.status,
      propertyType: dto.propertyType ?? null,

      dealValue: dto.dealValue,
      commissionAmount: dto.commissionAmount,
      currencyCode: dto.currencyCode,

      closedAt: new Date(dto.closedAtISO),
    };

    this.attachOptionalObjectId(payload, 'branchId', dto.branchId);
    this.attachOptionalObjectId(payload, 'regionId', dto.regionId);
    this.attachOptionalObjectId(payload, 'teamId', dto.teamId);
    this.attachOptionalObjectId(payload, 'propertyId', dto.propertyId);

    const created = await Deal.create(payload);

    // 🔥 Publish signals for all relevant scopes (org + branch + team + member + property).
    this.publishMultiScopeSignals(
      'facts:deal:inserted',
      'properties',
      {
        orgId: dto.orgId,
        branchId: dto.branchId ?? null,
        regionId: dto.regionId ?? null,
        teamId: dto.teamId ?? null,
        memberId: dto.agentId,
        propertyId: dto.propertyId ?? null,
      },
      'Deal fact stored'
    );

    return String(created._id);
  }

  // =========================================================================
  // Satisfaction Fact (append-only)
  // =========================================================================
  public async ingestSatisfactionFact(dto: KpiSatisfactionFactDto): Promise<string> {
    const Sat = KpiModelAdapter.getSatisfactionFactModel();

    const payload: Record<string, unknown> = {
      orgId: this.toObjectId(dto.orgId),
      agentId: this.toObjectId(dto.agentId),

      rating: dto.rating,
      comment: dto.comment ?? null,

      submittedAt: new Date(dto.submittedAtISO),
    };

    this.attachOptionalObjectId(payload, 'branchId', dto.branchId);
    this.attachOptionalObjectId(payload, 'regionId', dto.regionId);
    this.attachOptionalObjectId(payload, 'teamId', dto.teamId);

    const created = await Sat.create(payload);

    this.publishMultiScopeSignals(
      'facts:satisfaction:inserted',
      'organisation',
      {
        orgId: dto.orgId,
        branchId: dto.branchId ?? null,
        regionId: dto.regionId ?? null,
        teamId: dto.teamId ?? null,
        memberId: dto.agentId,
        propertyId: null,
      },
      'Satisfaction fact stored'
    );

    return String(created._id);
  }

  // =========================================================================
  // Maintenance Event Fact (append-only)
  // =========================================================================
  public async ingestMaintenanceEvent(dto: KpiMaintenanceEventDto): Promise<string> {
    const Ev = KpiModelAdapter.getMaintenanceEventFactModel();

    const payload: Record<string, unknown> = {
      orgId: this.toObjectId(dto.orgId),
      memberId: this.toObjectId(dto.memberId),
      ticketId: this.toObjectId(dto.ticketId),

      eventType: dto.eventType,
      slaMinutes: dto.slaMinutes,
      priority: dto.priority ?? null,

      occurredAt: new Date(dto.occurredAtISO),
    };

    this.attachOptionalObjectId(payload, 'branchId', dto.branchId);
    this.attachOptionalObjectId(payload, 'regionId', dto.regionId);
    this.attachOptionalObjectId(payload, 'teamId', dto.teamId);
    this.attachOptionalObjectId(payload, 'propertyId', dto.propertyId);

    const created = await Ev.create(payload);

    this.publishMultiScopeSignals(
      'facts:maintenance:event',
      'maintenance',
      {
        orgId: dto.orgId,
        branchId: dto.branchId ?? null,
        regionId: dto.regionId ?? null,
        teamId: dto.teamId ?? null,
        memberId: dto.memberId,
        propertyId: dto.propertyId ?? null,
      },
      'Maintenance event stored'
    );

    return String(created._id);
  }

  // =========================================================================
  // Team Task Fact (projection/upsert snapshot)
  // =========================================================================
  public async ingestTeamTaskFact(dto: KpiTeamTaskFactDto): Promise<string> {
    const Task = KpiModelAdapter.getTeamTaskFactModel();

    const taskId: Types.ObjectId = this.toObjectId(dto.taskId);

    const assignedAt: Date = new Date(dto.assignedAtISO);
    const expectedEndAt: Date = new Date(dto.expectedEndAtISO);

    const set: Record<string, unknown> = {
      orgId: this.toObjectId(dto.orgId),

      assigneeScope: dto.assigneeScope,
      category: dto.category,
      status: dto.status,

      assignedAt,
      expectedEndAt,

      // compat mirrors
      createdAtISO: assignedAt,
      dueAtISO: expectedEndAt,
    };

    this.attachOptionalObjectId(set, 'branchId', dto.branchId);
    this.attachOptionalObjectId(set, 'regionId', dto.regionId);
    this.attachOptionalObjectId(set, 'teamId', dto.teamId);
    this.attachOptionalObjectId(set, 'memberId', dto.memberId);
    this.attachOptionalObjectId(set, 'propertyId', dto.propertyId);

    if (dto.priority) set.priority = dto.priority;
    if (dto.startedAtISO) set.startedAtISO = new Date(dto.startedAtISO);
    if (dto.completedAtISO) set.completedAt = new Date(dto.completedAtISO);

    if (typeof dto.evidenceCount === 'number') set.evidenceCount = dto.evidenceCount;
    if (typeof dto.hasEvidence === 'boolean') set.hasEvidence = dto.hasEvidence;

    if (dto.lastWarningAtISO) set.lastWarningAt = new Date(dto.lastWarningAtISO);
    if (dto.lastWarningLevel) set.lastWarningLevel = dto.lastWarningLevel;

    const setOnInsert: Record<string, unknown> = { taskId };

    const result = await Task.updateOne(
      { taskId },
      { $set: set, $setOnInsert: setOnInsert },
      { upsert: true }
    ).exec();

    // 🔥 Task KPI changes affect org/branch/team/member/property dashboards.
    this.publishMultiScopeSignals(
      'facts:team:task',
      'team',
      {
        orgId: dto.orgId,
        branchId: dto.branchId ?? null,
        regionId: dto.regionId ?? null,
        teamId: dto.teamId ?? null,
        memberId: dto.memberId ?? null,
        propertyId: dto.propertyId ?? null,
      },
      'Team task projection updated'
    );

    const upserted = (result as unknown as { upsertedId?: unknown }).upsertedId;
    return upserted ? String(upserted) : String(taskId);
  }

  // =========================================================================
  // Team Task Evidence Fact (append-only)
  // =========================================================================
  public async ingestTeamTaskEvidence(dto: KpiTeamTaskEvidenceDto): Promise<string> {
    const Evidence = KpiModelAdapter.getTeamTaskEvidenceFactModel();

    const payload: Record<string, unknown> = {
      orgId: this.toObjectId(dto.orgId),

      taskId: this.toObjectId(dto.taskId),
      evidenceId: this.toObjectId(dto.evidenceId),

      evidenceType: dto.evidenceType,
      ref: dto.ref,

      submittedAt: new Date(dto.submittedAtISO),
    };

    this.attachOptionalObjectId(payload, 'branchId', dto.branchId);
    this.attachOptionalObjectId(payload, 'regionId', dto.regionId);
    this.attachOptionalObjectId(payload, 'teamId', dto.teamId);
    this.attachOptionalObjectId(payload, 'memberId', dto.memberId);
    this.attachOptionalObjectId(payload, 'propertyId', dto.propertyId);

    const created = await Evidence.create(payload);

    // Keep projection evidence counters in-sync (best-effort)
    await this.safeIncrementProjectionEvidence(dto);

    // 🔥 Evidence affects team task KPIs.
    this.publishMultiScopeSignals(
      'facts:team:task',
      'team',
      {
        orgId: dto.orgId,
        branchId: dto.branchId ?? null,
        regionId: dto.regionId ?? null,
        teamId: dto.teamId ?? null,
        memberId: dto.memberId ?? null,
        propertyId: dto.propertyId ?? null,
      },
      'Task evidence stored'
    );

    return String(created._id);
  }

  // =========================================================================
  // Team Task Event Fact (append-only)
  // =========================================================================
  public async ingestTeamTaskEvent(dto: KpiTeamTaskEventDto): Promise<string> {
    const Event = KpiModelAdapter.getTeamTaskEventFactModel();

    const payload: Record<string, unknown> = {
      orgId: this.toObjectId(dto.orgId),

      assigneeScope: dto.assigneeScope,

      taskId: this.toObjectId(dto.taskId),
      eventId: this.toObjectId(dto.eventId),

      eventType: dto.eventType,
      status: dto.status,
      category: dto.category,

      priority: dto.priority ?? null,
      occurredAt: new Date(dto.occurredAtISO),
      note: dto.note ?? null,
    };

    this.attachOptionalObjectId(payload, 'branchId', dto.branchId);
    this.attachOptionalObjectId(payload, 'regionId', dto.regionId);
    this.attachOptionalObjectId(payload, 'teamId', dto.teamId);
    this.attachOptionalObjectId(payload, 'memberId', dto.memberId);
    this.attachOptionalObjectId(payload, 'propertyId', dto.propertyId);

    const created = await Event.create(payload);

    // 🔥 Events affect team task KPIs.
    this.publishMultiScopeSignals(
      'facts:team:task',
      'team',
      {
        orgId: dto.orgId,
        branchId: dto.branchId ?? null,
        regionId: dto.regionId ?? null,
        teamId: dto.teamId ?? null,
        memberId: dto.memberId ?? null,
        propertyId: dto.propertyId ?? null,
      },
      'Task event stored'
    );

    return String(created._id);
  }

  /**
   * Projection fast-path:
   * - increment evidenceCount and set hasEvidence=true
   * - does not fail the main request if projection update fails
   */
  private async safeIncrementProjectionEvidence(dto: KpiTeamTaskEvidenceDto): Promise<void> {
    try {
      const Task = KpiModelAdapter.getTeamTaskFactModel();

      await Task.updateOne(
        { taskId: this.toObjectId(dto.taskId) },
        {
          $set: { hasEvidence: true },
          $inc: { evidenceCount: 1 },
        },
        { upsert: false }
      ).exec();
    } catch (err) {
      console.log('[Warning:] [KPI] Projection evidence update skipped.\n', err);
    }
  }

  // =========================================================================
  // Signal publish helpers (exactOptionalPropertyTypes-safe)
  // =========================================================================

  private publishMultiScopeSignals(
    type: KpiSignalType,
    domain: KpiDomain,
    dims: {
      orgId: string;
      branchId: string | null;
      regionId: string | null;
      teamId: string | null;
      memberId: string | null;
      propertyId: string | null;
    },
    reason: string
  ): void {
    // Teaching note:
    // We publish "scope invalidated" signals per scope so any dashboard can listen to its own room:
    // - org dashboard listens org:<orgId>
    // - branch dashboard listens branch:<branchId>
    // - team dashboard listens team:<teamId>
    // - member dashboard listens member:<memberId>
    // - property dashboard listens property:<propertyId>
    this.publishSignal(type, domain, 'org', dims.orgId, dims, reason);

    if (dims.branchId) this.publishSignal(type, domain, 'branch', dims.branchId, dims, `${reason} (branch)`);
    if (dims.regionId) this.publishSignal(type, domain, 'region', dims.regionId, dims, `${reason} (region)`);
    if (dims.teamId) this.publishSignal(type, domain, 'team', dims.teamId, dims, `${reason} (team)`);
    if (dims.memberId) this.publishSignal(type, domain, 'member', dims.memberId, dims, `${reason} (member)`);
    if (dims.propertyId) this.publishSignal(type, domain, 'property', dims.propertyId, dims, `${reason} (property)`);
  }

  private publishSignal(
    type: KpiSignalType,
    domain: KpiDomain,
    scope: KpiScope,
    targetId: string,
    dims: {
      orgId: string;
      branchId: string | null;
      regionId: string | null;
      teamId: string | null;
      memberId: string | null;
      propertyId: string | null;
    },
    reason: string
  ): void {
    // exactOptionalPropertyTypes rule:
    // - do not set optional fields to undefined
    // - only assign when we have a real value
    const payload: KpiSignalPayload = {
      type,
      domain,
      scope,
      targetId,
      occurredAtISO: new Date().toISOString(),
      reason,
    };

    // Dimension hints (optional)
    payload.orgId = dims.orgId;

    if (dims.branchId) payload.branchId = dims.branchId;
    if (dims.regionId) payload.regionId = dims.regionId;
    if (dims.teamId) payload.teamId = dims.teamId;
    if (dims.memberId) payload.memberId = dims.memberId;
    if (dims.propertyId) payload.propertyId = dims.propertyId;

    this.bus.publish(payload);
  }

  // =========================================================================
  // INTERNAL HELPERS (100% class-based)
  // =========================================================================

  private attachOptionalObjectId(target: Record<string, unknown>, key: string, raw?: string | null): void {
    if (!raw) return;
    target[key] = this.toObjectId(raw);
  }

  private toObjectId(raw: string | undefined): Types.ObjectId {
    if (!raw) throw new Error('Cannot convert undefined to ObjectId');
    if (!Types.ObjectId.isValid(raw)) throw new Error(`Invalid ObjectId: ${raw}`);
    return new Types.ObjectId(raw);
  }
}
