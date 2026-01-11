// ============================================================================
// Path: src/KPIs/data/kpi-model.adapter.ts
// ============================================================================
// KPI Model Adapter (Mongo Model Registry)
// ----------------------------------------------------------------------------
// Goals (enterprise-grade):
//   1) Single source of truth for KPI Mongo models (loose coupling)
//   2) Hot-reload safe: reuses mongoose.models[] when already registered
//   3) Scale-ready: indexes designed around query patterns (scope + time windows)
//   4) Idempotency: unique keys for append-only facts and projection docs
//
// Why adapter:
//   - Services/Queries/Controllers only call getters.
//   - They never import or know schema details.
//   - Model names remain stable and centralized.
// ============================================================================

import { model, models, Schema, type Model, Types } from 'mongoose';

// ============================================================================
// Shared Types (keep minimal here; detailed types stay in shared/ folder)
// ============================================================================
export type KpiDealType = 'sale' | 'rent';
export type KpiDealStatus = 'won' | 'lost' | 'pending' | 'cancelled';

export type KpiTaskAssigneeScope = 'member' | 'team';

export type KpiTaskEventType =
  | 'assigned'
  | 'status_changed'
  | 'evidence_added'
  | 'completed'
  | 'reopened'
  | 'cancelled';

export type KpiEvidenceType = 'image' | 'pdf' | 'doc' | 'link' | 'text' | 'other';

// ============================================================================
// 1) Deal Fact Doc (append-only)
// ============================================================================
export interface KpiDealFactDoc {
  orgId: Types.ObjectId;
  branchId?: Types.ObjectId;
  regionId?: Types.ObjectId;

  teamId?: Types.ObjectId;
  agentId: Types.ObjectId;
  propertyId?: Types.ObjectId;

  dealType: KpiDealType;
  status: KpiDealStatus;
  propertyType?: string | null;

  dealValue: number;
  commissionAmount: number;
  currencyCode: string;

  closedAt: Date;
}

// ============================================================================
// 2) Satisfaction Fact Doc (append-only)
// ============================================================================
export interface KpiSatisfactionFactDoc {
  orgId: Types.ObjectId;
  branchId?: Types.ObjectId;
  regionId?: Types.ObjectId;

  teamId?: Types.ObjectId;
  agentId: Types.ObjectId;

  rating: number; // 1..5
  comment?: string | null;

  submittedAt: Date;
}

// ============================================================================
// 3) Maintenance Event Fact Doc (append-only)
// ============================================================================
export interface KpiMaintenanceEventFactDoc {
  orgId: Types.ObjectId;
  branchId?: Types.ObjectId;
  regionId?: Types.ObjectId;

  teamId?: Types.ObjectId;
  memberId: Types.ObjectId; // technician/handler
  propertyId?: Types.ObjectId;

  ticketId: Types.ObjectId;
  eventType: string; // opened/completed/closed/etc. (you can narrow later)
  slaMinutes: number;

  priority?: string | null;

  occurredAt: Date;
}

// ============================================================================
// 4) Team Task Fact Doc (projection/upsert collection)
// ----------------------------------------------------------------------------
// This is NOT append-only.
// This is the "current snapshot" for fast KPI reads.
// ============================================================================
export interface KpiTeamTaskFactDoc {
  orgId: Types.ObjectId;
  branchId?: Types.ObjectId;
  regionId?: Types.ObjectId;

  assigneeScope: KpiTaskAssigneeScope;
  teamId?: Types.ObjectId;
  memberId?: Types.ObjectId;

  propertyId?: Types.ObjectId;

  taskId: Types.ObjectId; // unique business key

  category: string;
  status: string; // pending/in_progress/completed/reopened/cancelled/etc.
  priority?: string | null;

  // Timeline (store both naming styles so your system can evolve safely)
  // - assignedAt/expectedEndAt used by ingest & automation
  // - createdAtISO/dueAtISO used by runner/query fallback
  assignedAt: Date;
  expectedEndAt: Date;

  createdAtISO?: Date; // optional mirror for compatibility
  dueAtISO?: Date;     // optional mirror for compatibility

  startedAtISO?: Date;
  completedAt?: Date;

  // evidence fast fields
  hasEvidence?: boolean;
  evidenceCount?: number;

  // automation anti-spam fields (optional)
  lastWarningAt?: Date;
  lastWarningLevel?: '75' | '90' | 'overdue';
}

// ============================================================================
// 5) Team Task Evidence Fact Doc (append-only)
// ============================================================================
export interface KpiTeamTaskEvidenceFactDoc {
  orgId: Types.ObjectId;
  branchId?: Types.ObjectId;
  regionId?: Types.ObjectId;

  teamId?: Types.ObjectId;
  memberId?: Types.ObjectId;

  propertyId?: Types.ObjectId;

  taskId: Types.ObjectId;
  evidenceId: Types.ObjectId;

  evidenceType: KpiEvidenceType;
  ref: string;

  submittedAt: Date;
}

// ============================================================================
// 6) Team Task Event Fact Doc (append-only)
// ============================================================================
export interface KpiTeamTaskEventFactDoc {
  orgId: Types.ObjectId;
  branchId?: Types.ObjectId;
  regionId?: Types.ObjectId;

  assigneeScope: KpiTaskAssigneeScope;
  teamId?: Types.ObjectId;
  memberId?: Types.ObjectId;

  propertyId?: Types.ObjectId;

  taskId: Types.ObjectId;
  eventId: Types.ObjectId;

  eventType: KpiTaskEventType;
  status: string;

  category: string;
  priority?: string | null;

  occurredAt: Date;
  note?: string | null;
}

// ============================================================================
// KPI Model Adapter Class (100% class-based)
// ============================================================================
export class KpiModelAdapter {
  // --------------------------------------------------------------------------
  // Model names (single source of truth)
  // --------------------------------------------------------------------------
  private static readonly DEAL_FACT_MODEL: string = 'kpi_deal_facts';
  private static readonly SATISFACTION_FACT_MODEL: string = 'kpi_satisfaction_facts';
  private static readonly MAINTENANCE_EVENT_FACT_MODEL: string = 'kpi_maintenance_event_facts';

  private static readonly TEAM_TASK_FACT_MODEL: string = 'kpi_team_task_facts'; // projection/upsert
  private static readonly TEAM_TASK_EVIDENCE_FACT_MODEL: string = 'kpi_team_task_evidence_facts';
  private static readonly TEAM_TASK_EVENT_FACT_MODEL: string = 'kpi_team_task_event_facts';

  // --------------------------------------------------------------------------
  // Public getters (the only API other layers should use)
  // --------------------------------------------------------------------------
  public static getDealFactModel(): Model<KpiDealFactDoc> {
    return this.getOrCreateModel<KpiDealFactDoc>(
      this.DEAL_FACT_MODEL,
      this.buildDealFactSchema(),
    );
  }

  public static getSatisfactionFactModel(): Model<KpiSatisfactionFactDoc> {
    return this.getOrCreateModel<KpiSatisfactionFactDoc>(
      this.SATISFACTION_FACT_MODEL,
      this.buildSatisfactionFactSchema(),
    );
  }

  public static getMaintenanceEventFactModel(): Model<KpiMaintenanceEventFactDoc> {
    return this.getOrCreateModel<KpiMaintenanceEventFactDoc>(
      this.MAINTENANCE_EVENT_FACT_MODEL,
      this.buildMaintenanceEventFactSchema(),
    );
  }

  public static getTeamTaskFactModel(): Model<KpiTeamTaskFactDoc> {
    return this.getOrCreateModel<KpiTeamTaskFactDoc>(
      this.TEAM_TASK_FACT_MODEL,
      this.buildTeamTaskFactSchema(),
    );
  }

  public static getTeamTaskEvidenceFactModel(): Model<KpiTeamTaskEvidenceFactDoc> {
    return this.getOrCreateModel<KpiTeamTaskEvidenceFactDoc>(
      this.TEAM_TASK_EVIDENCE_FACT_MODEL,
      this.buildTeamTaskEvidenceFactSchema(),
    );
  }

  public static getTeamTaskEventFactModel(): Model<KpiTeamTaskEventFactDoc> {
    return this.getOrCreateModel<KpiTeamTaskEventFactDoc>(
      this.TEAM_TASK_EVENT_FACT_MODEL,
      this.buildTeamTaskEventFactSchema(),
    );
  }

  // ==========================================================================
  // Core registry logic (private, class-based)
  // ==========================================================================
  private static getOrCreateModel<TDoc>(
    name: string,
    schema: Schema<TDoc>,
  ): Model<TDoc> {
    // Hot-reload safe: reuse existing model if already compiled
    if (models[name]) {
      return models[name] as Model<TDoc>;
    }

    // 3rd param ensures collection name === model name (no pluralization surprises)
    return model<TDoc>(name, schema, name);
  }

  // ==========================================================================
  // Schema builders (private, class-based only)
  // ==========================================================================

  private static buildDealFactSchema(): Schema<KpiDealFactDoc> {
    const s = new Schema<KpiDealFactDoc>(
      {
        orgId: { type: Schema.Types.ObjectId, required: true, index: true },
        branchId: { type: Schema.Types.ObjectId, required: false, index: true },
        regionId: { type: Schema.Types.ObjectId, required: false, index: true },

        teamId: { type: Schema.Types.ObjectId, required: false, index: true },
        agentId: { type: Schema.Types.ObjectId, required: true, index: true },
        propertyId: { type: Schema.Types.ObjectId, required: false, index: true },

        dealType: { type: String, required: true, enum: ['sale', 'rent'], index: true },
        status: { type: String, required: true, enum: ['won', 'lost', 'pending', 'cancelled'], index: true },
        propertyType: { type: String, required: false, default: null },

        dealValue: { type: Number, required: true },
        commissionAmount: { type: Number, required: true },
        currencyCode: { type: String, required: true, index: true },

        closedAt: { type: Date, required: true, index: true },
      },
      { timestamps: true, versionKey: false },
    );

    // Heavy queries: scope + time
    s.index({ orgId: 1, closedAt: 1 });
    s.index({ orgId: 1, branchId: 1, closedAt: 1 });
    s.index({ orgId: 1, teamId: 1, closedAt: 1 });
    s.index({ orgId: 1, agentId: 1, closedAt: 1 });

    // Leaderboards: status=won + time + value sort
    s.index({ status: 1, closedAt: 1, dealValue: -1 });

    return s;
  }

  private static buildSatisfactionFactSchema(): Schema<KpiSatisfactionFactDoc> {
    const s = new Schema<KpiSatisfactionFactDoc>(
      {
        orgId: { type: Schema.Types.ObjectId, required: true, index: true },
        branchId: { type: Schema.Types.ObjectId, required: false, index: true },
        regionId: { type: Schema.Types.ObjectId, required: false, index: true },

        teamId: { type: Schema.Types.ObjectId, required: false, index: true },
        agentId: { type: Schema.Types.ObjectId, required: true, index: true },

        rating: { type: Number, required: true, min: 0, max: 5 },
        comment: { type: String, required: false, default: null },

        submittedAt: { type: Date, required: true, index: true },
      },
      { timestamps: true, versionKey: false },
    );

    s.index({ orgId: 1, submittedAt: 1 });
    s.index({ orgId: 1, agentId: 1, submittedAt: 1 });
    s.index({ orgId: 1, teamId: 1, submittedAt: 1 });

    return s;
  }

  private static buildMaintenanceEventFactSchema(): Schema<KpiMaintenanceEventFactDoc> {
    const s = new Schema<KpiMaintenanceEventFactDoc>(
      {
        orgId: { type: Schema.Types.ObjectId, required: true, index: true },
        branchId: { type: Schema.Types.ObjectId, required: false, index: true },
        regionId: { type: Schema.Types.ObjectId, required: false, index: true },

        teamId: { type: Schema.Types.ObjectId, required: false, index: true },
        memberId: { type: Schema.Types.ObjectId, required: true, index: true },
        propertyId: { type: Schema.Types.ObjectId, required: false, index: true },

        ticketId: { type: Schema.Types.ObjectId, required: true, index: true },
        eventType: { type: String, required: true, index: true },
        slaMinutes: { type: Number, required: true },

        priority: { type: String, required: false, default: null },

        occurredAt: { type: Date, required: true, index: true },
      },
      { timestamps: true, versionKey: false },
    );

    // SLA queries: ticket timeline + time
    s.index({ ticketId: 1, occurredAt: 1 });
    s.index({ orgId: 1, occurredAt: 1 });
    s.index({ orgId: 1, teamId: 1, occurredAt: 1 });
    s.index({ orgId: 1, memberId: 1, occurredAt: 1 });

    return s;
  }

  private static buildTeamTaskFactSchema(): Schema<KpiTeamTaskFactDoc> {
    const s = new Schema<KpiTeamTaskFactDoc>(
      {
        orgId: { type: Schema.Types.ObjectId, required: true, index: true },
        branchId: { type: Schema.Types.ObjectId, required: false, index: true },
        regionId: { type: Schema.Types.ObjectId, required: false, index: true },

        assigneeScope: { type: String, required: true, enum: ['member', 'team'], index: true },
        teamId: { type: Schema.Types.ObjectId, required: false, index: true },
        memberId: { type: Schema.Types.ObjectId, required: false, index: true },

        propertyId: { type: Schema.Types.ObjectId, required: false, index: true },

        taskId: { type: Schema.Types.ObjectId, required: true, index: true },

        category: { type: String, required: true, index: true },
        status: { type: String, required: true, index: true },
        priority: { type: String, required: false, default: null },

        // Required core timeline
        assignedAt: { type: Date, required: true, index: true },
        expectedEndAt: { type: Date, required: true, index: true },

        // Compatibility mirrors (optional)
        createdAtISO: { type: Date, required: false, index: true },
        dueAtISO: { type: Date, required: false, index: true },

        startedAtISO: { type: Date, required: false, index: true },
        completedAt: { type: Date, required: false, index: true },

        hasEvidence: { type: Boolean, required: false, default: false, index: true },
        evidenceCount: { type: Number, required: false, default: 0 },

        lastWarningAt: { type: Date, required: false, index: true },
        lastWarningLevel: { type: String, required: false, enum: ['75', '90', 'overdue'], index: true },
      },
      { timestamps: true, versionKey: false },
    );

    // Idempotency for projection: taskId unique
    s.index({ taskId: 1 }, { unique: true });

    // Runner scans: active tasks by expected end
    s.index({ status: 1, expectedEndAt: 1 });
    s.index({ orgId: 1, status: 1, expectedEndAt: 1 });
    s.index({ orgId: 1, branchId: 1, status: 1, expectedEndAt: 1 });

    // Member/team dashboards
    s.index({ orgId: 1, memberId: 1, assignedAt: 1 });
    s.index({ orgId: 1, teamId: 1, assignedAt: 1 });

    return s;
  }

  private static buildTeamTaskEvidenceFactSchema(): Schema<KpiTeamTaskEvidenceFactDoc> {
    const s = new Schema<KpiTeamTaskEvidenceFactDoc>(
      {
        orgId: { type: Schema.Types.ObjectId, required: true, index: true },
        branchId: { type: Schema.Types.ObjectId, required: false, index: true },
        regionId: { type: Schema.Types.ObjectId, required: false, index: true },

        teamId: { type: Schema.Types.ObjectId, required: false, index: true },
        memberId: { type: Schema.Types.ObjectId, required: false, index: true },

        propertyId: { type: Schema.Types.ObjectId, required: false, index: true },

        taskId: { type: Schema.Types.ObjectId, required: true, index: true },
        evidenceId: { type: Schema.Types.ObjectId, required: true, index: true },

        evidenceType: { type: String, required: true, enum: ['image', 'pdf', 'doc', 'link', 'text', 'other'] },
        ref: { type: String, required: true },

        submittedAt: { type: Date, required: true, index: true },
      },
      { timestamps: true, versionKey: false },
    );

    // Idempotency: evidenceId unique
    s.index({ evidenceId: 1 }, { unique: true });

    // Timeline per task
    s.index({ taskId: 1, submittedAt: 1 });

    // Org/branch time pivot
    s.index({ orgId: 1, branchId: 1, submittedAt: 1 });

    return s;
  }

  private static buildTeamTaskEventFactSchema(): Schema<KpiTeamTaskEventFactDoc> {
    const s = new Schema<KpiTeamTaskEventFactDoc>(
      {
        orgId: { type: Schema.Types.ObjectId, required: true, index: true },
        branchId: { type: Schema.Types.ObjectId, required: false, index: true },
        regionId: { type: Schema.Types.ObjectId, required: false, index: true },

        assigneeScope: { type: String, required: true, enum: ['member', 'team'], index: true },
        teamId: { type: Schema.Types.ObjectId, required: false, index: true },
        memberId: { type: Schema.Types.ObjectId, required: false, index: true },

        propertyId: { type: Schema.Types.ObjectId, required: false, index: true },

        taskId: { type: Schema.Types.ObjectId, required: true, index: true },
        eventId: { type: Schema.Types.ObjectId, required: true, index: true },

        eventType: {
          type: String,
          required: true,
          enum: ['assigned', 'status_changed', 'evidence_added', 'completed', 'reopened', 'cancelled'],
          index: true,
        },

        status: { type: String, required: true, index: true },

        category: { type: String, required: true, index: true },
        priority: { type: String, required: false, default: null },

        occurredAt: { type: Date, required: true, index: true },
        note: { type: String, required: false, default: null },
      },
      { timestamps: true, versionKey: false },
    );

    // Idempotency: eventId unique
    s.index({ eventId: 1 }, { unique: true });

    // Timeline per task
    s.index({ taskId: 1, occurredAt: 1 });

    // Org time pivot
    s.index({ orgId: 1, occurredAt: 1 });

    return s;
  }
}
