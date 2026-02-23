// Path: src/models/notifications/user-notification.model.ts
// =============================================================================
// Notification Hub — User Notification State Model (Mongoose)
// -----------------------------------------------------------------------------
// PURPOSE:
// - Per-user notification state rows (Inbox rows)
// - One doc per (userId, notificationId)
// - Writes only to 'user_notifications'
// =============================================================================

import {
  Schema,
  model,
  Types,
  type Document,
  type ClientSession,
  type Model,
  type PipelineStage,
} from "mongoose";

/* =============================================================================
 * A) Config (class-based)
 * ========================================================================== */
class UserNotifConfig {
  private constructor () {}

  public static readonly USE_STRING_NOTIFICATION_ID = false as const;
}

/* =============================================================================
 * B) Utilities (class-based)
 * ========================================================================== */
class UserNotifUtil {
  private constructor () {}

  public static sanitizeUserId( v: unknown ): string {
    return typeof v === "string" ? v.trim() : "";
  }

  public static sanitizeUsername( v: unknown ): string {
    return typeof v === "string" ? v.trim() : "";
  }

  public static now(): Date {
    return new Date();
  }

  public static optSession(session?: ClientSession): {} | { session: ClientSession } {
    return session ? { session } : {};
  }

  /**
   * Aggregate.session() cannot accept null safely.
   * We expose a helper to apply session only when it exists.
   */
  public static applyAggregateSession<T>( agg: T, session?: ClientSession ): T {
    if ( !session ) return agg;

    // We intentionally avoid any loose helper functions.
    // Cast is safe because mongoose aggregate exposes .session(session)
    ( agg as unknown as { session: ( s: ClientSession ) => unknown; } ).session( session );
    return agg;
  }

  public static normalizeIds(
    notificationIds: Array<string | Types.ObjectId>
  ): Array<string> | Array<Types.ObjectId> {
    if (UserNotifConfig.USE_STRING_NOTIFICATION_ID) {
      return notificationIds.map( ( id ) => String( id ) );
    }

    return notificationIds.map( ( id ) =>
      id instanceof Types.ObjectId ? id : new Types.ObjectId( String( id ) )
    );
  }
}

/* =============================================================================
 * C) Types
 * ========================================================================== */
export interface UserNotificationEntity extends Document {
  userId: string;
  username?: string;

  notificationId: Types.ObjectId | string;

  isRead: boolean;
  readAt?: Date;

  /**
   * Soft delete (trash)
   */
  isDeleted: boolean;
  deletedAt?: Date;

  /**
   * Archive (hide without deleting)
   */
  isArchived: boolean;
  archivedAt?: Date;

  deliveredAt: Date;
}

export interface UserNotificationModelType extends Model<UserNotificationEntity> {
  deleteAllForUser(
    userId: string,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; deletedCount: number }>;

  deleteManyForUser(
    userId: string,
    notificationIds: Array<string | Types.ObjectId>,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; deletedCount: number }>;

  markAllRead(
    userId: string,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; modifiedCount: number; matchedCount: number }>;

  markManyDeleted(
    userId: string,
    notificationIds: Array<string | Types.ObjectId>,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; modifiedCount: number; matchedCount: number }>;

  restoreMany(
    userId: string,
    notificationIds: Array<string | Types.ObjectId>,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; modifiedCount: number; matchedCount: number; }>;

  archiveMany(
    userId: string,
    notificationIds: Array<string | Types.ObjectId>,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; modifiedCount: number; matchedCount: number; }>;

  unarchiveMany(
    userId: string,
    notificationIds: Array<string | Types.ObjectId>,
    session?: ClientSession
  ): Promise<{ acknowledged: boolean; modifiedCount: number; matchedCount: number; }>;

  pruneOrphans(session?: ClientSession): Promise<number>;
}

/* =============================================================================
 * D) Schema Factory (class-based)
 * ========================================================================== */
class UserNotificationSchemaFactory {
  private constructor () {}

  private static buildNotificationIdField(): Record<string, unknown> {
    if ( UserNotifConfig.USE_STRING_NOTIFICATION_ID ) {
      return { type: String, required: true, index: true, trim: true };
    }

    return { type: Schema.Types.ObjectId, required: true, index: true };
  }

  public static build(): Schema<UserNotificationEntity, UserNotificationModelType> {
    const schema = new Schema<UserNotificationEntity, UserNotificationModelType>(
      {
        userId: {
          type: String,
          required: true,
          index: true,
          trim: true,
          set: UserNotifUtil.sanitizeUserId,
        },

        username: {
          type: String,
          required: false,
          index: true,
          trim: true,
          set: UserNotifUtil.sanitizeUsername,
        },

        notificationId: UserNotificationSchemaFactory.buildNotificationIdField(),

        isRead: { type: Boolean, default: false, index: true },
        readAt: { type: Date, required: false },

        // Trash / delete semantics
        isDeleted: { type: Boolean, default: false, index: true },
        deletedAt: { type: Date, required: false },

        // Archive semantics
        isArchived: { type: Boolean, default: false, index: true },
        archivedAt: { type: Date, required: false },

        // ✅ class-based default (no inline lambda)
        deliveredAt: { type: Date, default: UserNotifUtil.now, index: true },
      },
      { versionKey: false, minimize: true, timestamps: false }
    );

    // One row per (userId, notificationId)
    schema.index( { userId: 1, notificationId: 1 }, { unique: true, background: true } );

    // Inbox listing acceleration:
    // - unread first queries
    // - filter deleted/archived
    // - deliveredAt sort descending
    schema.index( {
      userId: 1,
      isRead: 1,
      isDeleted: 1,
      isArchived: 1,
      deliveredAt: -1,
      readAt: -1,
      deletedAt: -1,
      archivedAt: -1,
    } );

    return schema;
  }
}

/* =============================================================================
 * E) Statics attachment (class-based)
 * ========================================================================== */
class UserNotificationStatics {
  private constructor () {}

  public static attach( schema: Schema<UserNotificationEntity, UserNotificationModelType> ): void {
    schema.statics.deleteAllForUser = async function ( userId: string, session?: ClientSession ) {
      const u = UserNotifUtil.sanitizeUserId( userId );
      if ( !u ) return { acknowledged: false, deletedCount: 0 };

      const res = await this.deleteMany( { userId: u }, UserNotifUtil.optSession( session ) );
      return { acknowledged: !!res.acknowledged, deletedCount: res.deletedCount ?? 0 };
    };

    schema.statics.deleteManyForUser = async function (
      userId: string,
      notificationIds: Array<string | Types.ObjectId>,
      session?: ClientSession
    ) {
      const u = UserNotifUtil.sanitizeUserId( userId );
      if ( !u || notificationIds.length === 0 ) return { acknowledged: false, deletedCount: 0 };

      const ids = UserNotifUtil.normalizeIds( notificationIds );
      const res = await this.deleteMany(
        { userId: u, notificationId: { $in: ids } },
        UserNotifUtil.optSession( session )
      );

      return { acknowledged: !!res.acknowledged, deletedCount: res.deletedCount ?? 0 };
    };

    schema.statics.markAllRead = async function ( userId: string, session?: ClientSession ) {
      const u = UserNotifUtil.sanitizeUserId( userId );
      if ( !u ) return { acknowledged: false, modifiedCount: 0, matchedCount: 0 };

      const res = await this.updateMany(
        { userId: u, isRead: false, isDeleted: false },
        { $set: { isRead: true, readAt: UserNotifUtil.now() } },
        UserNotifUtil.optSession( session )
      );

      return {
        acknowledged: !!res.acknowledged,
        matchedCount: res.matchedCount ?? 0,
        modifiedCount: res.modifiedCount ?? 0,
      };
    };

    schema.statics.markManyDeleted = async function (
      userId: string,
      notificationIds: Array<string | Types.ObjectId>,
      session?: ClientSession
    ) {
      const u = UserNotifUtil.sanitizeUserId( userId );
      if ( !u || notificationIds.length === 0 ) {
        return { acknowledged: false, modifiedCount: 0, matchedCount: 0 };
      }

      const ids = UserNotifUtil.normalizeIds( notificationIds );
      const res = await this.updateMany(
        { userId: u, notificationId: { $in: ids }, isDeleted: false },
        { $set: { isDeleted: true, deletedAt: UserNotifUtil.now() } },
        UserNotifUtil.optSession( session )
      );

      return {
        acknowledged: !!res.acknowledged,
        matchedCount: res.matchedCount ?? 0,
        modifiedCount: res.modifiedCount ?? 0,
      };
    };

    schema.statics.restoreMany = async function (
      userId: string,
      notificationIds: Array<string | Types.ObjectId>,
      session?: ClientSession
    ) {
      const u = UserNotifUtil.sanitizeUserId( userId );
      if ( !u || notificationIds.length === 0 ) {
        return { acknowledged: false, modifiedCount: 0, matchedCount: 0 };
      }

      const ids = UserNotifUtil.normalizeIds( notificationIds );
      const res = await this.updateMany(
        { userId: u, notificationId: { $in: ids }, isDeleted: true },
        { $set: { isDeleted: false }, $unset: { deletedAt: "" } },
        UserNotifUtil.optSession( session )
      );

      return {
        acknowledged: !!res.acknowledged,
        matchedCount: res.matchedCount ?? 0,
        modifiedCount: res.modifiedCount ?? 0,
      };
    };

    schema.statics.archiveMany = async function (
      userId: string,
      notificationIds: Array<string | Types.ObjectId>,
      session?: ClientSession
    ) {
      const u = UserNotifUtil.sanitizeUserId( userId );
      if ( !u || notificationIds.length === 0 ) {
        return { acknowledged: false, modifiedCount: 0, matchedCount: 0 };
      }

      const ids = UserNotifUtil.normalizeIds( notificationIds );
      const res = await this.updateMany(
        { userId: u, notificationId: { $in: ids }, isArchived: false, isDeleted: false },
        { $set: { isArchived: true, archivedAt: UserNotifUtil.now() } },
        UserNotifUtil.optSession( session )
      );

      return {
        acknowledged: !!res.acknowledged,
        matchedCount: res.matchedCount ?? 0,
        modifiedCount: res.modifiedCount ?? 0,
      };
    };

    schema.statics.unarchiveMany = async function (
      userId: string,
      notificationIds: Array<string | Types.ObjectId>,
      session?: ClientSession
    ) {
      const u = UserNotifUtil.sanitizeUserId( userId );
      if ( !u || notificationIds.length === 0 ) {
        return { acknowledged: false, modifiedCount: 0, matchedCount: 0 };
      }

      const ids = UserNotifUtil.normalizeIds( notificationIds );
      const res = await this.updateMany(
        { userId: u, notificationId: { $in: ids }, isArchived: true },
        { $set: { isArchived: false }, $unset: { archivedAt: "" } },
        UserNotifUtil.optSession( session )
      );

      return {
        acknowledged: !!res.acknowledged,
        matchedCount: res.matchedCount ?? 0,
        modifiedCount: res.modifiedCount ?? 0,
      };
    };

    schema.statics.pruneOrphans = async function ( session?: ClientSession ) {
      const pipeline: PipelineStage[] = [
        {
          $lookup: {
            from: "notifications",
            localField: "notificationId",
            foreignField: "_id",
            as: "n",
          },
        },
        { $match: { n: { $size: 0 } } },
        { $project: { _id: 1 } },
      ];

      // ✅ FIX: apply .session only when session exists
      const agg = this.aggregate( pipeline );
      UserNotifUtil.applyAggregateSession( agg, session );

      const orphans = await agg.exec();
      if ( orphans.length === 0 ) return 0;

      const ids = orphans
        .map( ( o ) => ( o as { _id?: unknown; } )._id )
        .filter( ( x ): x is Types.ObjectId => x instanceof Types.ObjectId );

      if ( ids.length === 0 ) return 0;

      const res = await this.deleteMany( { _id: { $in: ids } }, UserNotifUtil.optSession( session ) );
      return res.deletedCount ?? 0;
    };
  }
}

/* =============================================================================
 * F) Build + export model (critical typing fix)
 * ========================================================================== */
class UserNotificationModelBuilder {
  private constructor () {}

  public static build(): UserNotificationModelType {
    const schema = UserNotificationSchemaFactory.build();
    UserNotificationStatics.attach( schema );

    return model<UserNotificationEntity, UserNotificationModelType>(
      "UserNotification",
      schema,
      "user_notifications"
    );
  }
}

export const UserNotificationModel = UserNotificationModelBuilder.build();
