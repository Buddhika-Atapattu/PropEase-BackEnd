// src/models/notification.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// Notification model (Mongoose)
// PURPOSE of this file: Type declarations + DB schema only.
//   • No business logic, no room creation, no service operations here.
//   • Controllers/services will create documents and perform operations.
// NOTE on "user notification rooms":
//   • This model DOES NOT create any rooms/collections by itself.
//   • If you see two user-notification rooms in DB, that logic lives in the
//     separate user-notification model/service. Add a unique index + idempotent
//     upsert there. (See TODO near bottom for a reminder.)
// ─────────────────────────────────────────────────────────────────────────────

import {Schema, model, type Document} from 'mongoose';

/* ============================================================================
 * A) Encapsulate constants & helpers in a class (class-based requirement)
 *    - No service/ops methods here—only values + pure helpers
 * ==========================================================================*/
class NotificationCatalog {
  // ── A.1 Categories (domains)
  public static readonly CATEGORIES = [
    'User', 'Tenant', 'Property', 'Lease',
    'Agent', 'Developer', 'Maintenance', 'Complaint',
    'Team', 'Registration', 'Payment', 'System',
  ] as const;
  public static readonly CATEGORY_ICON_MAP: Record<TitleCategory, string> = {
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

  // ── A.2 Channels / severity / audience
  public static readonly SEVERITY_VALUES: Severity[] = ['info', 'success', 'warning', 'error'];
  public static readonly CHANNEL_VALUES: Channel[] = ['inapp', 'email', 'sms', 'push'];
  public static readonly AUDIENCE_MODE_VALUES: AudienceMode[] = ['user', 'role', 'broadcast'];

  // ── A.3 Titles (single source of truth)
  // Add Restore X / Permanent Delete X for EVERY category
  public static readonly TITLE_VALUES = [
    // User
    'New User', 'Update User', 'Delete User', 'Restore User', 'Permanent Delete User',
    'User Role Changed', 'User Password Reset', 'User Suspended', 'User Reactivated',

    // Tenant
    'New Tenant', 'Update Tenant', 'Delete Tenant', 'Restore Tenant', 'Permanent Delete Tenant',
    'Tenant Verified', 'Tenant Moved Out', 'Tenant Complaint Filed',

    // Property
    'New Property', 'Update Property', 'Delete Property', 'Restore Property', 'Permanent Delete Property',
    'Property Approved', 'Property Listing Expired', 'Property Maintenance Requested',
    'Property Maintenance Completed', 'Property Inspection Scheduled',

    // Lease
    'New Lease', 'Update Lease', 'Delete Lease', 'Restore Lease', 'Permanent Delete Lease',
    'Lease Renewed', 'Lease Terminated', 'Lease Payment Received', 'Lease Reminder Sent',
    'Lease Agreement Download',

    // Agent
    'New Agent', 'Update Agent', 'Delete Agent', 'Restore Agent', 'Permanent Delete Agent',
    'Agent Assigned Property',

    // Developer
    'New Developer', 'Update Developer', 'Delete Developer', 'Restore Developer', 'Permanent Delete Developer',

    // Maintenance
    'New Maintenance Request', 'Update Maintenance Request', 'Close Maintenance Request',
    'Restore Maintenance Request', 'Permanent Delete Maintenance Request',
    'Assign Maintenance Team', 'Maintenance In Progress', 'Maintenance Completed',

    // Complaint
    'New Complaint', 'Update Complaint', 'Close Complaint',
    'Restore Complaint', 'Permanent Delete Complaint',
    'Complaint Escalated', 'Complaint Resolved',

    // Team
    'New Team', 'Update Team', 'Delete Team', 'Restore Team', 'Permanent Delete Team',
    'Assign Team Member', 'Team Task Created', 'Team Task Completed',

    // Registration / KYC
    'New Registration', 'Update Registration', 'Delete Registration',
    'Restore Registration', 'Permanent Delete Registration',
    'Account Verified', 'KYC Document Uploaded', 'KYC Document Approved', 'KYC Document Rejected',

    // Payment
    'New Invoice', 'Update Invoice', 'Delete Invoice',
    'Restore Invoice', 'Permanent Delete Invoice',
    'Invoice Paid', 'Invoice Overdue', 'Refund Issued', 'Payment Failed',

    // System
    'New Notification', 'Update Notification', 'Delete Notification',
    'Restore Notification', 'Permanent Delete Notification',
    'System Update', 'Security Alert', 'Backup Completed', 'New Message', 'Broadcast Announcement',
  ] as const;

  // ── A.4 Normalized action types (includes restore & permanent_delete)
  public static readonly DEFINED_TYPE_VALUES = [
    'create', 'update', 'delete', 'restore', 'permanent_delete', 'archive',
    'assign', 'reassign',
    'approve', 'reject', 'verify', 'publish', 'unpublish',
    'renew', 'terminate', 'expire', 'download',
    'schedule', 'start', 'in_progress', 'complete', 'reschedule', 'cancel',
    'maintenance_request', 'maintenance_ack', 'maintenance_in_progress', 'maintenance_completed', 'maintenance_closed',
    'payment_received', 'payment_failed', 'refund_issued', 'invoice_created', 'invoice_overdue',
    'notify', 'reminder', 'escalate', 'broadcast',
    'import', 'export', 'sync',
  ] as const;

  // ── A.5 Mapping Title → Category (include Restore/PermDelete for all)
  public static readonly TITLE_CATEGORY_MAP: Record<Title, TitleCategory> = (() => {
    const M: Partial<Record<string, TitleCategory>> = {};

    // Helper to add a block of titles for one category
    const add = (cat: TitleCategory, titles: string[]) => {
      for(const t of titles) M[t] = cat;
    };

    add('User', [
      'New User', 'Update User', 'Delete User', 'Restore User', 'Permanent Delete User',
      'User Role Changed', 'User Password Reset', 'User Suspended', 'User Reactivated',
    ]);

    add('Tenant', [
      'New Tenant', 'Update Tenant', 'Delete Tenant', 'Restore Tenant', 'Permanent Delete Tenant',
      'Tenant Verified', 'Tenant Moved Out', 'Tenant Complaint Filed',
    ]);

    add('Property', [
      'New Property', 'Update Property', 'Delete Property', 'Restore Property', 'Permanent Delete Property',
      'Property Approved', 'Property Listing Expired', 'Property Maintenance Requested',
      'Property Maintenance Completed', 'Property Inspection Scheduled',
    ]);

    add('Lease', [
      'New Lease', 'Update Lease', 'Delete Lease', 'Restore Lease', 'Permanent Delete Lease',
      'Lease Renewed', 'Lease Terminated', 'Lease Payment Received', 'Lease Reminder Sent', 'Lease Agreement Download',
    ]);

    add('Agent', [
      'New Agent', 'Update Agent', 'Delete Agent', 'Restore Agent', 'Permanent Delete Agent',
      'Agent Assigned Property',
    ]);

    add('Developer', [
      'New Developer', 'Update Developer', 'Delete Developer', 'Restore Developer', 'Permanent Delete Developer',
    ]);

    add('Maintenance', [
      'New Maintenance Request', 'Update Maintenance Request', 'Close Maintenance Request',
      'Restore Maintenance Request', 'Permanent Delete Maintenance Request',
      'Assign Maintenance Team', 'Maintenance In Progress', 'Maintenance Completed',
    ]);

    add('Complaint', [
      'New Complaint', 'Update Complaint', 'Close Complaint',
      'Restore Complaint', 'Permanent Delete Complaint',
      'Complaint Escalated', 'Complaint Resolved',
    ]);

    add('Team', [
      'New Team', 'Update Team', 'Delete Team', 'Restore Team', 'Permanent Delete Team',
      'Assign Team Member', 'Team Task Created', 'Team Task Completed',
    ]);

    add('Registration', [
      'New Registration', 'Update Registration', 'Delete Registration',
      'Restore Registration', 'Permanent Delete Registration',
      'Account Verified', 'KYC Document Uploaded', 'KYC Document Approved', 'KYC Document Rejected',
    ]);

    add('Payment', [
      'New Invoice', 'Update Invoice', 'Delete Invoice',
      'Restore Invoice', 'Permanent Delete Invoice',
      'Invoice Paid', 'Invoice Overdue', 'Refund Issued', 'Payment Failed',
    ]);

    add('System', [
      'New Notification', 'Update Notification', 'Delete Notification',
      'Restore Notification', 'Permanent Delete Notification',
      'System Update', 'Security Alert', 'Backup Completed', 'New Message', 'Broadcast Announcement',
    ]);

    return M as Record<Title, TitleCategory>;
  })();

  // ── A.6 Helpers
  public static isLikelyUrl(v?: string) {return !!v && /^(https?:)?\/\//i.test(v);}
  public static dedupeTrim(arr?: unknown[]) {
    return Array.isArray(arr) ? Array.from(new Set(arr.map((x) => (typeof x === 'string' ? x.trim() : x)))).filter(Boolean) as string[] : [];
  }
  public static capTags(tags: string[], maxTags = 20, maxPerTag = 40) {
    return tags.map((t) => String(t).slice(0, maxPerTag)).slice(0, maxTags);
  }

  // ── A.7 Title → normalized DefinedType (now detects restore/permanent delete)
  public static mapTitleToType(title: Title): DefinedTypes {
    const t = title.toLowerCase();
    if(t.startsWith('new ')) return 'create';
    if(t.startsWith('update ')) return 'update';
    if(t.startsWith('delete ')) return 'delete';
    if(t.startsWith('restore ')) return 'restore';
    if(t.startsWith('permanent delete')) return 'permanent_delete';

    if(t.includes('approved')) return 'approve';
    if(t.includes('listing expired')) return 'expire';
    if(t.includes('inspection')) return 'schedule';
    if(t.includes('maintenance requested')) return 'maintenance_request';
    if(t.includes('maintenance in progress')) return 'maintenance_in_progress';
    if(t.includes('maintenance completed')) return 'maintenance_completed';

    if(t.includes('lease renewed')) return 'renew';
    if(t.includes('lease terminated')) return 'terminate';
    if(t.includes('payment received')) return 'payment_received';
    if(t.includes('reminder sent')) return 'reminder';
    if(t.includes('agreement download')) return 'download';

    if(t.includes('close complaint')) return 'maintenance_closed';
    if(t.includes('task created')) return 'create';
    if(t.includes('task completed')) return 'complete';

    if(t.includes('invoice paid')) return 'payment_received';
    if(t.includes('invoice overdue')) return 'invoice_overdue';
    if(t.includes('refund issued')) return 'refund_issued';
    if(t.includes('payment failed')) return 'payment_failed';

    if(t.includes('broadcast')) return 'broadcast';
    if(t.includes('security alert')) return 'notify';
    return 'notify';
  }
}

/* ============================================================================
 * B) Types derived from the catalog (single source)
 * ==========================================================================*/
export type Title = (typeof NotificationCatalog.TITLE_VALUES)[number];
export type TitleCategory = (typeof NotificationCatalog.CATEGORIES)[number];
export type Severity = 'info' | 'success' | 'warning' | 'error';
export type Channel = 'inapp' | 'email' | 'sms' | 'push';
export type AudienceMode = 'user' | 'role' | 'broadcast';
export type DefinedTypes = (typeof NotificationCatalog.DEFINED_TYPE_VALUES)[number];

/* ============================================================================
 * C) Document shape (DB)
 * ==========================================================================*/
export interface DeliveryStatus {
  channel: Channel;
  status: 'pending' | 'sent' | 'failed';
  detail?: string;
  at?: Date;
}

export interface NotificationEntity extends Document {
  title: Title;
  category: TitleCategory;               // derived + stored (fast filtering)
  type: DefinedTypes;                    // derived from title unless explicitly set
  severity: Severity;
  body: string;

  target?: {
    kind?: TitleCategory;                // defaults to category if missing
    refId?: string;
  };

  audience: {
    mode: AudienceMode;
    usernames: string[];
    roles: string[];
  };

  channels: Channel[];
  deliveries?: DeliveryStatus[];

  icon?: string;
  tags?: string[];
  link?: string;
  source?: string;
  metadata?: {
    refId: string;
    data?: Record<string, any>;
  };

  readBy?: string[];

  createdAt: Date;
  expiresAt?: Date;
}

/* ============================================================================
 * D) Schemas + hooks (derive category/type; defaults; indexes)
 * ==========================================================================*/
const AudienceSchema = new Schema<NotificationEntity['audience']>(
  {
    mode: {type: String, enum: NotificationCatalog.AUDIENCE_MODE_VALUES, required: true, index: true},
    usernames: {
      type: [String],
      index: true,
      default: [],
      set: (v: unknown) => NotificationCatalog.dedupeTrim(Array.isArray(v) ? v : []),
    },
    roles: {
      type: [String],
      index: true,
      default: [],
      set: (v: unknown) => NotificationCatalog.dedupeTrim(Array.isArray(v) ? v : []),
    },
  },
  {_id: false}
);

const DeliverySchema = new Schema<DeliveryStatus>(
  {
    channel: {type: String, enum: NotificationCatalog.CHANNEL_VALUES, required: true},
    status: {type: String, enum: ['pending', 'sent', 'failed'], required: true, default: 'pending'},
    detail: {type: String, trim: true},
    at: {type: Date, default: () => new Date()},
  },
  {_id: false}
);

const NotificationSchema = new Schema<NotificationEntity>(
  {
    title: {type: String, enum: NotificationCatalog.TITLE_VALUES, required: true, trim: true},

    // Stored category (derived in hook; keeps queries fast)
    category: {
      type: String,
      enum: NotificationCatalog.CATEGORIES,
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: NotificationCatalog.DEFINED_TYPE_VALUES,
      required: true,
      default: 'notify',
      trim: true,
      index: true,
    },

    severity: {type: String, enum: NotificationCatalog.SEVERITY_VALUES, default: 'info', required: true},

    body: {type: String, required: true, trim: true},

    target: {
      kind: {type: String, enum: NotificationCatalog.CATEGORIES, trim: true},
      refId: {type: String, trim: true, index: true},
    },

    audience: {type: AudienceSchema, required: true},

    channels: {
      type: [String],
      enum: NotificationCatalog.CHANNEL_VALUES,
      default: ['inapp'],
      set: (v: unknown) => {
        const arr = Array.isArray(v) ? v : ['inapp'];
        const cleaned = NotificationCatalog
          .dedupeTrim(arr)
          .filter((c) => (NotificationCatalog.CHANNEL_VALUES as string[]).includes(String(c)));
        return cleaned.length ? cleaned : ['inapp'];
      },
    },

    deliveries: {type: [DeliverySchema], default: []},

    createdAt: {type: Date, default: () => new Date(), index: true},
    expiresAt: {type: Date, index: true},

    metadata: {
      refId: {type: String, trim: true, required: true, default: ''},
      data: {type: Schema.Types.Mixed, required: false},
    },
    icon: {type: String, trim: true},
    tags: {
      type: [String],
      index: true,
      default: [],
      set: (v: unknown) => NotificationCatalog.capTags(NotificationCatalog.dedupeTrim(Array.isArray(v) ? v : [])),
    },
    link: {
      type: String,
      trim: true,
      set: (v: unknown) => {
        const s = typeof v === 'string' ? v.trim() : '';
        return NotificationCatalog.isLikelyUrl(s) ? s : s;
      },
    },
    source: {type: String, trim: true},

    readBy: {
      type: [String],
      index: true,
      default: [],
      set: (v: unknown) => NotificationCatalog.dedupeTrim(Array.isArray(v) ? v : []),
    },
  },
  {versionKey: false, minimize: true}
);

// ── Hook: derive category/type/target.kind from title; apply icon/tags defaults
NotificationSchema.pre('validate', function(next) {
  const doc = this as NotificationEntity;

  // 1) Category from title (single truth map)
  if(doc.title) {
    const mapped = NotificationCatalog.TITLE_CATEGORY_MAP[doc.title];
    if(!mapped) return next(new Error(`No category mapping for title "${doc.title}"`));
    doc.category = mapped;

    // 2) Keep target.kind aligned unless explicitly set
    if(!doc.target) doc.target = {};
    if(!doc.target.kind) doc.target.kind = mapped;
  }

  // 3) Normalized type from title (unless explicitly given)
  if(!doc.type) {
    doc.type = NotificationCatalog.mapTitleToType(doc.title);
  }

  // 4) Category icon default (if not provided)
  if(!doc.icon && doc.category) {
    doc.icon = NotificationCatalog.CATEGORY_ICON_MAP[doc.category] ?? 'notifications';
  }

  // 5) Category default tags (first create only, if not provided)
  if(doc.isNew) {
    const existing = Array.isArray(doc.tags) ? NotificationCatalog.dedupeTrim(doc.tags) : [];
    if(existing.length === 0) {
      // A tiny, safe default tag set per category (optional to extend later)
      const defaults: Record<TitleCategory, string[]> = {
        User: ['user', 'account'],
        Tenant: ['tenant', 'occupancy'],
        Property: ['property', 'listing'],
        Lease: ['lease', 'agreement'],
        Agent: ['agent', 'staff'],
        Developer: ['developer', 'project'],
        Maintenance: ['maintenance', 'workorder'],
        Complaint: ['complaint', 'ticket'],
        Team: ['team', 'task'],
        Registration: ['registration', 'kyc'],
        Payment: ['payment', 'invoice'],
        System: ['system', 'security'],
      };
      const dt = defaults[doc.category] || [];
      if(dt.length) doc.tags = NotificationCatalog.capTags(NotificationCatalog.dedupeTrim(dt));
    }
  }

  return next();
});

// ── Keep category/type in sync on update()
function syncOnQueryUpdate(this: any, next: Function) {
  const update: any = this.getUpdate() || {};
  const set = update.$set ?? update;

  if(set.title) {
    const mapped = NotificationCatalog.TITLE_CATEGORY_MAP[set.title as Title];
    if(!mapped) return next(new Error(`No category mapping for title "${set.title}"`));
    (update.$set ??= {}).category = mapped;

    if(!update.$set?.['target.kind'] && !(set?.target && set.target.kind)) {
      (update.$set ??= {})['target.kind'] = mapped;
    }

    if(!set.type && !(update.$set && update.$set.type)) {
      (update.$set ??= {}).type = NotificationCatalog.mapTitleToType(set.title as Title);
    }
  }

  this.setUpdate(update);
  return next();
}
NotificationSchema.pre('findOneAndUpdate', syncOnQueryUpdate);
NotificationSchema.pre('updateOne', syncOnQueryUpdate);

// ── Indexes (fast filters)
NotificationSchema.index({title: 1, createdAt: -1});
NotificationSchema.index({category: 1, type: 1, createdAt: -1});
NotificationSchema.index({'audience.mode': 1, createdAt: -1});
NotificationSchema.index({'audience.usernames': 1, createdAt: -1});
NotificationSchema.index({'audience.roles': 1, createdAt: -1});
NotificationSchema.index({severity: 1, createdAt: -1});
NotificationSchema.index({tags: 1, createdAt: -1});
NotificationSchema.index({'target.refId': 1, createdAt: -1});

/* ============================================================================
 * E) Model export
 * ==========================================================================*/
export const NotificationModel = model<NotificationEntity>('Notification', NotificationSchema, 'notifications');

/* ============================================================================
 * F) TODO (re: duplicate "user notification rooms")
 * ==========================================================================*
 * If you see duplicate user-notification rooms in DB:
 * 1) That logic belongs to your separate user-notification model/service.
 * 2) Add a UNIQUE index on the identifying tuple (e.g., { roomType, userId }).
 *    Example: RoomSchema.index({ roomType: 1, userId: 1 }, { unique: true });
 * 3) Use idempotent upsert patterns:
 *    await RoomModel.findOneAndUpdate(filter, {$setOnInsert: payload}, {upsert: true, new: true});
 * This Notification model does NOT create rooms.
 * ==========================================================================*/
