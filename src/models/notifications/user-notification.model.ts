// src/models/user-notification.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE: Per-user notification state rows. One doc per (username, notificationId).
// IMPORTANT: This model DOES NOT create any “room” collections (user or role).
//            It writes only to the 'user_notifications' collection.
//            If you see duplicate “rooms” in DB, that comes from a different
//            model/service (e.g., a Rooms schema) — not from this file.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Schema,
  model,
  type Document,
  Types,
  type ClientSession,
  type Model,
} from 'mongoose';

/** Central configuration kept class-based to meet your code-style rule. */
class UserNotifConfig {
  /**
   * If you prefer string-based notification IDs instead of ObjectIds,
   * set this to `true`. See the `notificationId` field below.
   */
  public static readonly USE_STRING_NOTIFICATION_ID = false as const;
}

/** Small utilities as a class (no free functions). */
class UserNotifUtil {
  /** Trim username safely (keeps types narrow). */
  public static sanitizeUsername(v: unknown) {
    return typeof v === 'string' ? v.trim() : v;
  }

  /**
   * Return `{}` or `{ session }` (never `{ session: undefined }`).
   * Avoids TS issues under exactOptionalPropertyTypes even if enabled globally.
   */
  public static optSession(session?: ClientSession): {} | { session: ClientSession } {
    return session ? { session } : {};
  }

  /**
   * Merge base options with optional session without leaking `undefined`.
   * (Kept for completeness; not used directly below.)
   */
  public static optSessionWith<T extends object>(base: T, session?: ClientSession): T | (T & { session: ClientSession }) {
    return session ? ({ ...base, session } as T & { session: ClientSession }) : base;
  }

  /** Normalize list of ids to ObjectId[] or string[] based on config. */
  public static normalizeIds(notificationIds: Array<string | Types.ObjectId>) {
    if (UserNotifConfig.USE_STRING_NOTIFICATION_ID) {
      return notificationIds.map(String);
    }
    return notificationIds.map((id) => (id instanceof Types.ObjectId ? id : new Types.ObjectId(String(id))));
  }
}

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

export interface UserNotificationEntity extends Document {
  /** The account/user who owns this per-notification state row. */
  username: string;

  /**
   * Pointer to the master Notification:
   *  - ObjectId (default) for performance and ref-compatibility.
   *  - Or string if you flip the config flag above.
   */
  notificationId: Types.ObjectId | string;

  /** Per-user state flags. */
  isRead: boolean;
  isArchived: boolean;

  /** First delivered/seen timestamp; readAt when user opened it. */
  deliveredAt: Date;
  readAt?: Date;
}

/** Static method interface (kept simple and call-site friendly). */
export interface UserNotificationModelType extends Model<UserNotificationEntity> {
  /** Hard delete ALL per-user rows for a given username. */
  deleteAllForUser(
    username: string,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; deletedCount: number }>;

  /** Hard delete a subset of rows by notification ids for a given user. */
  deleteManyForUser(
    username: string,
    notificationIds: Array<string | Types.ObjectId>,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; deletedCount: number }>;

  /** Mark all notifications as read for a user. */
  markAllRead(
    username: string,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; modifiedCount: number; matchedCount: number }>;

  /** Archive all notifications for a user (soft-deletion alternative). */
  archiveAll(
    username: string,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; modifiedCount: number; matchedCount: number }>;

  /**
   * Maintenance: remove per-user rows whose master Notification no longer exists.
   * Returns the number of deleted orphan docs.
   */
  pruneOrphans(session?: ClientSession): Promise<number>;
}

/* ----------------------------------------------------------------------------
 * Schema
 * -------------------------------------------------------------------------- */
const UserNotificationSchema = new Schema<UserNotificationEntity, UserNotificationModelType>(
  {
    /** Username key (string, trimmed, indexed). */
    username: {
      type: String,
      required: true,
      index: true,
      trim: true,
      set: UserNotifUtil.sanitizeUsername,
    },

    /**
     * Master notification pointer.
     * If you flip UserNotifConfig.USE_STRING_NOTIFICATION_ID = true,
     * this field becomes String (with trim).
     */
    notificationId: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: UserNotifConfig.USE_STRING_NOTIFICATION_ID ? (Schema.Types.String as any) : Schema.Types.ObjectId,
      required: true,
      index: true,
      // ref: 'Notification', // (optional) uncomment if you use Mongoose refs
      ...(UserNotifConfig.USE_STRING_NOTIFICATION_ID ? { trim: true } : {}),
    },

    /** Per-user flags and timing. */
    isRead: { type: Boolean, default: false, index: true },
    isArchived: { type: Boolean, default: false, index: true },

    deliveredAt: { type: Date, default: () => new Date(), index: true },
    readAt: { type: Date, required: false },
  },
  {
    versionKey: false,
    minimize: true,
    // deliveredAt acts as first-seen; set timestamps: true if you also want updatedAt
    timestamps: false,
  }
);

/* ----------------------------------------------------------------------------
 * Indexes
 * - Unique per (username, notificationId) to prevent duplicates.
 * - Compound index for fast inbox queries by status and recency.
 * -------------------------------------------------------------------------- */
UserNotificationSchema.index({ username: 1, notificationId: 1 }, { unique: true, background: true });

UserNotificationSchema.index({
  username: 1,
  isRead: 1,
  isArchived: 1,
  deliveredAt: -1,
  readAt: -1,
});

/* ----------------------------------------------------------------------------
 * Statics (DB-only convenience helpers; no business logic)
 * -------------------------------------------------------------------------- */

/** Delete all per-user notification states for a given username. */
UserNotificationSchema.statics.deleteAllForUser = async function (
  username: string,
  session?: ClientSession
) {
  const u = UserNotifUtil.sanitizeUsername(username);
  if (!u) {
    return { acknowledged: false, deletedCount: 0 };
  }

  const res = await this.deleteMany({ username: u }, UserNotifUtil.optSession(session));
  return { acknowledged: !!res.acknowledged, deletedCount: res.deletedCount ?? 0 };
};

/** Delete subset of states by a list of notification ids for a given user. */
UserNotificationSchema.statics.deleteManyForUser = async function (
  username: string,
  notificationIds: Array<string | Types.ObjectId>,
  session?: ClientSession
) {
  const u = UserNotifUtil.sanitizeUsername(username);
  if (!u || !Array.isArray(notificationIds) || notificationIds.length === 0) {
    return { acknowledged: false, deletedCount: 0 };
  }

  const ids = UserNotifUtil.normalizeIds(notificationIds);
  const res = await this.deleteMany(
    { username: u, notificationId: { $in: ids } },
    UserNotifUtil.optSession(session)
  );

  return { acknowledged: !!res.acknowledged, deletedCount: res.deletedCount ?? 0 };
};

/** Mark all notifications as read for a user. */
UserNotificationSchema.statics.markAllRead = async function (
  username: string,
  session?: ClientSession
) {
  const u = UserNotifUtil.sanitizeUsername(username);
  if (!u) {
    return { acknowledged: false, modifiedCount: 0, matchedCount: 0 };
    // Note: We keep the response shape consistent for your controllers.
  }

  const res = await this.updateMany(
    { username: u, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
    UserNotifUtil.optSession(session)
  );

  return {
    acknowledged: !!(res as any).acknowledged,
    matchedCount: (res as any).matchedCount ?? 0,
    modifiedCount: (res as any).modifiedCount ?? 0,
  };
};

/** Archive all notifications for a user (soft-delete alternative). */
UserNotificationSchema.statics.archiveAll = async function (
  username: string,
  session?: ClientSession
) {
  const u = UserNotifUtil.sanitizeUsername(username);
  if (!u) {
    return { acknowledged: false, modifiedCount: 0, matchedCount: 0 };
  }

  const res = await this.updateMany(
    { username: u, isArchived: false },
    { $set: { isArchived: true } },
    UserNotifUtil.optSession(session)
  );

  return {
    acknowledged: !!(res as any).acknowledged,
    matchedCount: (res as any).matchedCount ?? 0,
    modifiedCount: (res as any).modifiedCount ?? 0,
  };
};

/**
 * Maintenance: remove states that point to non-existing master Notifications.
 * - Efficient if `notificationId` is ObjectId with `ref`.
 * - Works with string IDs using $lookup too (slower).
 * Returns the number of deleted orphan docs.
 */
UserNotificationSchema.statics.pruneOrphans = async function (session?: ClientSession) {
  const pipeline: any[] = [
    {
      $lookup: {
        from: 'notifications',         // master collection name
        localField: 'notificationId',  // per-user pointer
        foreignField: '_id',           // master _id
        as: 'n',
      },
    },
    { $match: { n: { $size: 0 } } },   // keep only orphans
    { $project: { _id: 1 } },
  ];

  // aggregate().session(...) expects ClientSession | null
  const orphans = await this.aggregate(pipeline).session(session ?? null);
  if (!orphans.length) return 0;

  const ids = orphans.map((o: any) => o._id);
  const res = await this.deleteMany({ _id: { $in: ids } }, UserNotifUtil.optSession(session));
  return res.deletedCount ?? 0;
};

/* ----------------------------------------------------------------------------
 * Model
 * -------------------------------------------------------------------------- */
export const UserNotificationModel = model<UserNotificationEntity, UserNotificationModelType>(
  'UserNotification',
  UserNotificationSchema,
  'user_notifications' // single collection — no room collections are created here
);
