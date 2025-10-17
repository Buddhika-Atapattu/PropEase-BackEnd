// src/models/notification.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// Notification model (Mongoose)
// - Fixed TITLE_VALUES (shared with FE / services)
// - Derive category (domain) + normalized action type (DefinedTypes) from title
// - Audience, channels, severity, metadata
// - Optional target pointer { kind, refId } to the affected domain record
// - Optional delivery tracking per channel
// - Study-friendly comments throughout
// ─────────────────────────────────────────────────────────────────────────────

import {Schema, model, type Document} from 'mongoose';

/* ============================================================================
 * 1) FIXED TITLES (single source of truth)
 *    Keep this list aligned with FE and services.
 * ==========================================================================*/
export const TITLE_VALUES = [
  // ── User Management
  'New User', 'Update User', 'Delete User', 'User Role Changed',
  'User Password Reset', 'User Suspended', 'User Reactivated',

  // ── Tenant Management
  'New Tenant', 'Update Tenant', 'Delete Tenant', 'Tenant Verified',
  'Tenant Moved Out', 'Tenant Complaint Filed',

  // ── Property Management
  'New Property', 'Update Property', 'Delete Property', 'Property Approved',
  'Property Listing Expired', 'Property Maintenance Requested',
  'Property Maintenance Completed', 'Property Inspection Scheduled',

  // ── Lease / Agreement
  'New Lease', 'Update Lease', 'Delete Lease', 'Lease Renewed',
  'Lease Terminated', 'Lease Payment Received', 'Lease Reminder Sent',
  'Lease Agreement Download',

  // ── Agent / Developer
  'New Agent', 'Update Agent', 'Delete Agent', 'Agent Assigned Property',
  'New Developer', 'Update Developer', 'Delete Developer',

  // ── Maintenance
  'New Maintenance Request', 'Update Maintenance Request',
  'Close Maintenance Request', 'Assign Maintenance Team',
  'Maintenance In Progress', 'Maintenance Completed',

  // ── Complaints
  'New Complaint', 'Update Complaint', 'Close Complaint',
  'Complaint Escalated', 'Complaint Resolved',

  // ── Team / Staff
  'New Team', 'Update Team', 'Delete Team', 'Assign Team Member',
  'Team Task Created', 'Team Task Completed',

  // ── Registration / Verification
  'New Registration', 'Account Verified', 'KYC Document Uploaded',
  'KYC Document Approved', 'KYC Document Rejected',

  // ── Payments & Billing
  'New Invoice', 'Update Invoice', 'Invoice Paid', 'Invoice Overdue',
  'Refund Issued', 'Payment Failed',

  // ── System / Admin
  'System Update', 'Security Alert', 'Backup Completed', 'New Message',
  'New Notification', 'Broadcast Announcement',
] as const;

export type Title = (typeof TITLE_VALUES)[number];

/* ============================================================================
 * 2) DOMAIN CATEGORY + MAPPING FROM TITLE
 *    Categories describe the domain area, not the user action.
 * ==========================================================================*/
export type TitleCategory =
  | 'User' | 'Tenant' | 'Property' | 'Lease'
  | 'Agent' | 'Developer' | 'Maintenance' | 'Complaint'
  | 'Team' | 'Registration' | 'Payment' | 'System';

export const TITLE_CATEGORY_MAP: Record<Title, TitleCategory> = {
  // User
  'New User': 'User',
  'Update User': 'User',
  'Delete User': 'User',
  'User Role Changed': 'User',
  'User Password Reset': 'User',
  'User Suspended': 'User',
  'User Reactivated': 'User',
  // Tenant
  'New Tenant': 'Tenant',
  'Update Tenant': 'Tenant',
  'Delete Tenant': 'Tenant',
  'Tenant Verified': 'Tenant',
  'Tenant Moved Out': 'Tenant',
  'Tenant Complaint Filed': 'Tenant',
  // Property
  'New Property': 'Property',
  'Update Property': 'Property',
  'Delete Property': 'Property',
  'Property Approved': 'Property',
  'Property Listing Expired': 'Property',
  'Property Maintenance Requested': 'Property',
  'Property Maintenance Completed': 'Property',
  'Property Inspection Scheduled': 'Property',
  // Lease
  'New Lease': 'Lease',
  'Update Lease': 'Lease',
  'Delete Lease': 'Lease',
  'Lease Renewed': 'Lease',
  'Lease Terminated': 'Lease',
  'Lease Payment Received': 'Lease',
  'Lease Reminder Sent': 'Lease',
  'Lease Agreement Download': 'Lease',
  // Agent / Developer
  'New Agent': 'Agent',
  'Update Agent': 'Agent',
  'Delete Agent': 'Agent',
  'Agent Assigned Property': 'Agent',
  'New Developer': 'Developer',
  'Update Developer': 'Developer',
  'Delete Developer': 'Developer',
  // Maintenance
  'New Maintenance Request': 'Maintenance',
  'Update Maintenance Request': 'Maintenance',
  'Close Maintenance Request': 'Maintenance',
  'Assign Maintenance Team': 'Maintenance',
  'Maintenance In Progress': 'Maintenance',
  'Maintenance Completed': 'Maintenance',
  // Complaints
  'New Complaint': 'Complaint',
  'Update Complaint': 'Complaint',
  'Close Complaint': 'Complaint',
  'Complaint Escalated': 'Complaint',
  'Complaint Resolved': 'Complaint',
  // Team
  'New Team': 'Team',
  'Update Team': 'Team',
  'Delete Team': 'Team',
  'Assign Team Member': 'Team',
  'Team Task Created': 'Team',
  'Team Task Completed': 'Team',
  // Registration / KYC
  'New Registration': 'Registration',
  'Account Verified': 'Registration',
  'KYC Document Uploaded': 'Registration',
  'KYC Document Approved': 'Registration',
  'KYC Document Rejected': 'Registration',
  // Payment
  'New Invoice': 'Payment',
  'Update Invoice': 'Payment',
  'Invoice Paid': 'Payment',
  'Invoice Overdue': 'Payment',
  'Refund Issued': 'Payment',
  'Payment Failed': 'Payment',
  // System
  'System Update': 'System',
  'Security Alert': 'System',
  'Backup Completed': 'System',
  'New Message': 'System',
  'New Notification': 'System',
  'Broadcast Announcement': 'System',
};

/* ============================================================================
 * 3) SEVERITY / CHANNEL / AUDIENCE
 * ==========================================================================*/
export type Severity = 'info' | 'success' | 'warning' | 'error';
export const SEVERITY_VALUES: Severity[] = ['info', 'success', 'warning', 'error'];

export type Channel = 'inapp' | 'email' | 'sms' | 'push';
export const CHANNEL_VALUES: Channel[] = ['inapp', 'email', 'sms', 'push'];

export type AudienceMode = 'user' | 'role' | 'broadcast';
export const AUDIENCE_MODE_VALUES: AudienceMode[] = ['user', 'role', 'broadcast'];

/* ============================================================================
 * 4) NORMALIZED ACTION TYPES (richer than CRUD)
 *    Added: 'permanent_delete' to support hard deletes.
 * ==========================================================================*/
export type DefinedTypes =
  // Generic lifecycle
  | 'create' | 'update' | 'delete' | 'archive' | 'restore' | 'permanent_delete'
  // Assignment / routing
  | 'assign' | 'reassign'
  // Approvals / verification / publishing
  | 'approve' | 'reject' | 'verify' | 'publish' | 'unpublish'
  // Lease lifecycle
  | 'renew' | 'terminate' | 'expire' | 'download'
  // Scheduling / progress
  | 'schedule' | 'start' | 'in_progress' | 'complete' | 'reschedule' | 'cancel'
  // Maintenance workflow
  | 'maintenance_request' | 'maintenance_ack' | 'maintenance_in_progress' | 'maintenance_completed' | 'maintenance_closed'
  // Payments & billing
  | 'payment_received' | 'payment_failed' | 'refund_issued' | 'invoice_created' | 'invoice_overdue'
  // Messaging / comms
  | 'notify' | 'reminder' | 'escalate' | 'broadcast'
  // Data ops
  | 'import' | 'export' | 'sync';

export const DEFINED_TYPE_VALUES = [
  'create', 'update', 'delete', 'archive', 'restore', 'permanent_delete',
  'assign', 'reassign',
  'approve', 'reject', 'verify', 'publish', 'unpublish',
  'renew', 'terminate', 'expire', 'download',
  'schedule', 'start', 'in_progress', 'complete', 'reschedule', 'cancel',
  'maintenance_request', 'maintenance_ack', 'maintenance_in_progress', 'maintenance_completed', 'maintenance_closed',
  'payment_received', 'payment_failed', 'refund_issued', 'invoice_created', 'invoice_overdue',
  'notify', 'reminder', 'escalate', 'broadcast',
  'import', 'export', 'sync',
] as const;

export const isDefinedType = (v: unknown): v is DefinedTypes =>
  typeof v === 'string' && (DEFINED_TYPE_VALUES as readonly string[]).includes(v as any);

/* ============================================================================
 * 5) Category → default icon & tags (safe defaults)
 * ==========================================================================*/
export const CATEGORY_ICON_MAP: Record<TitleCategory, string> = {
  User: 'person',
  Tenant: 'recent_actors',
  Property: 'home',
  Lease: 'description',
  Agent: 'support_agent',
  Developer: 'engineering',
  Maintenance: 'build',
  Complaint: 'report_problem',
  Team: 'groups',
  Registration: 'verified_user',
  Payment: 'payments',
  System: 'settings',
};

export const CATEGORY_DEFAULT_TAGS: Record<TitleCategory, string[]> = {
  User: ['user', 'account', 'profile', 'admin'],
  Tenant: ['tenant', 'renter', 'verification', 'occupancy'],
  Property: ['property', 'listing', 'inspection', 'maintenance'],
  Lease: ['lease', 'agreement', 'renewal', 'payment'],
  Agent: ['agent', 'assignment', 'brokering', 'staff'],
  Developer: ['developer', 'project', 'release', 'deployment'],
  Maintenance: ['maintenance', 'workorder', 'repair', 'service'],
  Complaint: ['complaint', 'ticket', 'issue', 'escalation'],
  Team: ['team', 'task', 'collaboration', 'member'],
  Registration: ['registration', 'onboarding', 'kyc', 'verification'],
  Payment: ['payment', 'invoice', 'billing', 'refund'],
  System: ['system', 'security', 'backup', 'announce'],
};

/* ============================================================================
 * 6) Helpers / sanitizers
 * ==========================================================================*/
const sanitizeString = (v: unknown) => (typeof v === 'string' ? v.trim() : v);
const dedupeTrim = (arr?: unknown[]) =>
  Array.isArray(arr)
    ? Array.from(new Set(arr.map(sanitizeString))).filter(Boolean) as string[]
    : [];
const capTags = (tags: string[], maxTags = 20, maxPerTag = 40) =>
  tags.map((t) => String(t).slice(0, maxPerTag)).slice(0, maxTags);
const isLikelyUrl = (v?: string) => !!v && /^(https?:)?\/\//i.test(v);

/* ============================================================================
 * 7) Title → normalized type mapping
 *    This drives analytics & server logic (restore/permanent delete routing).
 * ==========================================================================*/
const mapTitleToType = (title: Title): DefinedTypes => {
  const t = title.toLowerCase();

  // Generic patterns
  if(t.startsWith('new ')) return 'create';
  if(t.startsWith('update ')) return 'update';
  if(t.startsWith('delete ')) return 'delete';

  // Property specific
  if(t.includes('approved')) return 'approve';
  if(t.includes('listing expired')) return 'expire';
  if(t.includes('inspection')) return 'schedule';
  if(t.includes('maintenance requested')) return 'maintenance_request';
  if(t.includes('maintenance in progress')) return 'maintenance_in_progress';
  if(t.includes('maintenance completed')) return 'maintenance_completed';

  // Lease specific
  if(t.includes('lease renewed')) return 'renew';
  if(t.includes('lease terminated')) return 'terminate';
  if(t.includes('payment received')) return 'payment_received';
  if(t.includes('reminder sent')) return 'reminder';
  if(t.includes('agreement download')) return 'download';

  // Complaint / team / misc
  if(t.includes('close complaint')) return 'maintenance_closed'; // reuse closed semantic
  if(t.includes('task created')) return 'create';
  if(t.includes('task completed')) return 'complete';

  // Payments
  if(t.includes('invoice paid')) return 'payment_received';
  if(t.includes('invoice overdue')) return 'invoice_overdue';
  if(t.includes('refund issued')) return 'refund_issued';
  if(t.includes('payment failed')) return 'payment_failed';

  // System/admin/messaging
  if(t.includes('broadcast')) return 'broadcast';
  if(t.includes('security alert')) return 'notify';

  // Fallback
  return 'notify';
};

/* ============================================================================
 * 8) DOCUMENT INTERFACES
 * ==========================================================================*/
export interface DeliveryStatus {
  channel: Channel;                // 'inapp' | 'email' | 'sms' | 'push'
  status: 'pending' | 'sent' | 'failed';
  detail?: string;                 // optional failure message
  at?: Date;                       // when last status was recorded
}

export interface NotificationEntity extends Document {
  // Core
  title: Title;                    // fixed title
  category: TitleCategory;         // derived from title (stored)
  type: DefinedTypes;              // normalized action type (derived or provided)
  severity: Severity;              // info/success/warning/error
  body: string;                    // message body (plain text / short markdown)

  // Target of the notification (for restore / permanent delete routing)
  target?: {
    kind?: TitleCategory;          // usually same as category; can override if needed
    refId?: string;                // domain record id (Tenant/Property/Lease/…)
  };

  // Audience & delivery
  audience: {
    mode: AudienceMode;            // 'user' | 'role' | 'broadcast'
    usernames: string[];           // when mode=user
    roles: string[];               // when mode=role
  };
  channels: Channel[];             // e.g., ['inapp','email']
  deliveries?: DeliveryStatus[];   // per-channel status (optional)

  // Extras
  icon?: string;                   // material icon
  tags?: string[];                 // search keywords
  link?: string;                   // CTA link
  source?: string;                 // who/what emitted
  metadata?: Record<string, any>;  // arbitrary JSON payload

  // Read tracking
  readBy?: string[];               // usernames that have read this (master-level)

  // Timestamps
  createdAt: Date;
  expiresAt?: Date;
}

/* ============================================================================
 * 9) SCHEMAS
 * ==========================================================================*/
const AudienceSchema = new Schema<NotificationEntity['audience']>(
  {
    mode: {type: String, enum: AUDIENCE_MODE_VALUES, required: true, index: true},
    usernames: {
      type: [String],
      index: true,
      default: [],
      set: (v: unknown) => dedupeTrim(Array.isArray(v) ? v : []),
    },
    roles: {
      type: [String],
      index: true,
      default: [],
      set: (v: unknown) => dedupeTrim(Array.isArray(v) ? v : []),
    },
  },
  {_id: false}
);

const DeliverySchema = new Schema<DeliveryStatus>(
  {
    channel: {type: String, enum: CHANNEL_VALUES, required: true},
    status: {type: String, enum: ['pending', 'sent', 'failed'], required: true, default: 'pending'},
    detail: {type: String, trim: true},
    at: {type: Date, default: () => new Date()},
  },
  {_id: false}
);

const NotificationSchema = new Schema<NotificationEntity>(
  {
    title: {type: String, enum: TITLE_VALUES, required: true, trim: true},

    // Stored category (fast filter). Derived from title (see hooks).
    category: {
      type: String,
      enum: ['User', 'Tenant', 'Property', 'Lease', 'Agent', 'Developer', 'Maintenance', 'Complaint', 'Team', 'Registration', 'Payment', 'System'],
      required: true,
      index: true,
    },

    // Normalized action type (derived from title unless explicitly set)
    type: {
      type: String,
      enum: DEFINED_TYPE_VALUES,
      required: true,
      default: 'notify',
      trim: true,
      index: true,
    },

    severity: {type: String, enum: SEVERITY_VALUES, default: 'info', required: true},

    body: {type: String, required: true, trim: true},

    // Target pointer (helps restore/permanent-delete logic)
    target: {
      kind: {type: String, enum: ['User', 'Tenant', 'Property', 'Lease', 'Agent', 'Developer', 'Maintenance', 'Complaint', 'Team', 'Registration', 'Payment', 'System'], trim: true},
      refId: {type: String, trim: true, index: true},
    },

    // Audience & delivery
    audience: {type: AudienceSchema, required: true},

    channels: {
      type: [String],
      enum: CHANNEL_VALUES,
      default: ['inapp'],
      set: (v: unknown) => {
        const arr = Array.isArray(v) ? v : ['inapp'];
        const cleaned = dedupeTrim(arr).filter((c) => (CHANNEL_VALUES as string[]).includes(String(c)));
        return cleaned.length ? cleaned : ['inapp'];
      },
    },

    deliveries: {type: [DeliverySchema], default: []},

    // Timestamps
    createdAt: {type: Date, default: () => new Date(), index: true},
    expiresAt: {type: Date, index: true},

    // Extras
    metadata: {type: Schema.Types.Mixed},
    icon: {type: String, trim: true},
    tags: {
      type: [String],
      index: true,
      default: [],
      set: (v: unknown) => capTags(dedupeTrim(Array.isArray(v) ? v : [])),
    },
    link: {
      type: String,
      trim: true,
      set: (v: unknown) => {
        const s = typeof v === 'string' ? v.trim() : '';
        return isLikelyUrl(s) ? s : s;
      },
    },
    source: {type: String, trim: true},

    // Read tracking
    readBy: {
      type: [String],
      index: true,
      default: [],
      set: (v: unknown) => dedupeTrim(Array.isArray(v) ? v : []),
    },
  },
  {versionKey: false, minimize: true}
);

/* ============================================================================
 * 10) Defaults based on category (icon + tags) for NEW docs
 * ==========================================================================*/
function applyCategoryDefaults(doc: NotificationEntity) {
  // icon default (only if not provided)
  if(!doc.icon && doc.category) {
    doc.icon = CATEGORY_ICON_MAP[doc.category] ?? 'notifications';
  }
  // tags default (new docs only; only when not provided)
  if(doc.isNew) {
    const existing = Array.isArray(doc.tags) ? dedupeTrim(doc.tags) : [];
    const defaults = doc.category ? CATEGORY_DEFAULT_TAGS[doc.category] ?? [] : [];
    if(existing.length === 0 && defaults.length) {
      doc.tags = capTags(dedupeTrim(defaults));
    }
  }
}

/* ============================================================================
 * 11) Hooks: derive category/type/target.kind from title; apply defaults
 * ==========================================================================*/
NotificationSchema.pre('validate', function(next) {
  const doc = this as NotificationEntity;

  // Derive category from title
  if(doc.title) {
    const mapped = TITLE_CATEGORY_MAP[doc.title];
    if(!mapped) return next(new Error(`No category mapping for title "${doc.title}"`));
    doc.category = mapped;

    // If target.kind not explicitly set, align with category
    if(!doc.target) doc.target = {};
    if(!doc.target.kind) doc.target.kind = mapped;
  }

  // Derive normalized action type from title only if not explicitly provided
  if(!doc.type) {
    doc.type = mapTitleToType(doc.title);
  }

  // Category-based defaults (icon/tags)
  applyCategoryDefaults(doc);

  return next();
});

/* Keep category/type in sync when updating by query */
function syncOnQueryUpdate(this: any, next: Function) {
  const update: any = this.getUpdate() || {};
  const set = update.$set ?? update;

  if(set.title) {
    const mapped = TITLE_CATEGORY_MAP[set.title as Title];
    if(!mapped) return next(new Error(`No category mapping for title "${set.title}"`));
    (update.$set ??= {}).category = mapped;

    // Keep target.kind aligned if not explicitly overridden
    if(!update.$set?.['target.kind'] && !set?.target?.kind) {
      (update.$set ??= {})['target.kind'] = mapped;
    }

    // If type not explicitly provided in update, derive from new title
    if(!set.type && !(update.$set && update.$set.type)) {
      (update.$set ??= {}).type = mapTitleToType(set.title as Title);
    }
  }

  this.setUpdate(update);
  return next();
}
NotificationSchema.pre('findOneAndUpdate', syncOnQueryUpdate);
NotificationSchema.pre('updateOne', syncOnQueryUpdate);

/* ============================================================================
 * 12) Indexes (fast filters & lookups)
 * ==========================================================================*/
NotificationSchema.index({title: 1, createdAt: -1});
NotificationSchema.index({category: 1, type: 1, createdAt: -1});
NotificationSchema.index({'audience.mode': 1, createdAt: -1});
NotificationSchema.index({'audience.usernames': 1, createdAt: -1});
NotificationSchema.index({'audience.roles': 1, createdAt: -1});
NotificationSchema.index({severity: 1, createdAt: -1});
NotificationSchema.index({tags: 1, createdAt: -1});
NotificationSchema.index({'target.refId': 1, createdAt: -1}); // helps restore/permanent-delete

/* ============================================================================
 * 13) TTL (create at collection level in migration/init script)
 *     db.notifications.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
 * ==========================================================================*/
export const NotificationModel = model<NotificationEntity>(
  'Notification',
  NotificationSchema,
  'notifications'
);

/* ============================================================================
 * 14) Type guards / helpers
 * ==========================================================================*/
export const isTitle = (v: unknown): v is Title =>
  typeof v === 'string' && (TITLE_VALUES as readonly string[]).includes(v as any);
