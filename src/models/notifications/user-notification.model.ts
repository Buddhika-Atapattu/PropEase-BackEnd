import {Schema, model, Document, Types, ClientSession, Model} from 'mongoose';

/**
 * If you prefer using string-based notification IDs instead of ObjectIds,
 * set this to `true`. See the `notificationId` field & comments below.
 */
const USE_STRING_NOTIFICATION_ID = false;

/** Small helpers */
const sanitizeUsername = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

/**
 * Options helper: return `{}` or `{ session }` (never `{ session: undefined }`).
 * This avoids TS errors with `exactOptionalPropertyTypes: true`.
 */
function optSession(session?: ClientSession): {} | {session: ClientSession} {
    return session ? {session} : {};
}

/**
 * Options helper: merge base options with an optional `session` key,
 * still avoiding `undefined` leakage.
 */
function optSessionWith<T extends object>(base: T, session?: ClientSession): T | (T & {session: ClientSession}) {
    return session ? ({...base, session} as T & {session: ClientSession}) : base;
}

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

export interface UserNotificationEntity extends Document {
    username: string;

    /** Either ObjectId ref or string, depending on USE_STRING_NOTIFICATION_ID */
    notificationId: Types.ObjectId | string;

    isRead: boolean;
    isArchived: boolean;
    deliveredAt: Date;
    readAt?: Date;
}

/**
 * Model statics:
 * - We return the common shape fields from Mongoose results to keep call sites simple.
 * - If you want exact return types, you can tighten these to use Mongoose result types directly.
 */
export interface UserNotificationModelType extends Model<UserNotificationEntity> {
    /** Hard delete _all_ per-user state rows for a given username */
    deleteAllForUser(
        username: string,
        session?: ClientSession
    ): Promise<{acknowledged: boolean; deletedCount: number}>;

    /** Hard delete per-user states for a list of notification ids */
    deleteManyForUser(
        username: string,
        notificationIds: Array<string | Types.ObjectId>,
        session?: ClientSession
    ): Promise<{acknowledged: boolean; deletedCount: number}>;

    /** Mark all notifications as read for a user */
    markAllRead(
        username: string,
        session?: ClientSession
    ): Promise<{acknowledged: boolean; modifiedCount: number; matchedCount: number}>;

    /** Archive all notifications for a user */
    archiveAll(
        username: string,
        session?: ClientSession
    ): Promise<{acknowledged: boolean; modifiedCount: number; matchedCount: number}>;

    /**
     * Optional maintenance: remove orphan states if their master Notification no longer exists.
     * Returns the number of deleted orphan docs.
     */
    pruneOrphans(session?: ClientSession): Promise<number>;
}

/* ----------------------------------------------------------------------------
 * Schema
 * -------------------------------------------------------------------------- */
const UserNotificationSchema = new Schema<UserNotificationEntity, UserNotificationModelType>(
    {
        username: {
            type: String,
            required: true,
            index: true,
            trim: true,
            set: sanitizeUsername,
        },

        /**
         * NOTE:
         * - If `USE_STRING_NOTIFICATION_ID === false` (default), we use ObjectId for better
         *   performance & automatic ref compatibility. You can uncomment `ref: 'Notification'`
         *   if you have a corresponding Notification model.
         * - If you switch to string IDs, set USE_STRING_NOTIFICATION_ID = true above and this
         *   field will switch to `Schema.Types.String` (with `trim: true` applied).
         */
        notificationId: {
            type: USE_STRING_NOTIFICATION_ID ? (Schema.Types.String as any) : Schema.Types.ObjectId,
            required: true,
            index: true,
            // ref: 'Notification',
            ...(USE_STRING_NOTIFICATION_ID ? {trim: true} : {}),
        },

        isRead: {type: Boolean, default: false, index: true},
        isArchived: {type: Boolean, default: false, index: true},

        deliveredAt: {type: Date, default: () => new Date(), index: true},
        readAt: {type: Date, required: false},
    },
    {
        versionKey: false,
        minimize: true,
        // deliveredAt covers first-seen; enable timestamps if you prefer automatic createdAt/updatedAt
        timestamps: false,
    }
);

/* ----------------------------------------------------------------------------
 * Indexes
 * - Unique per (username, notificationId) pair to prevent duplicates
 * - Compound index to support common queries
 * -------------------------------------------------------------------------- */
UserNotificationSchema.index({username: 1, notificationId: 1}, {unique: true, background: true});

UserNotificationSchema.index({
    username: 1,
    isRead: 1,
    isArchived: 1,
    deliveredAt: -1,
    readAt: -1,
});

/* ----------------------------------------------------------------------------
 * Statics (Convenience + Safety)
 *  - All statics below avoid passing `{ session: undefined }` to Mongoose
 *    by using `optSession(...)` or `optSessionWith(...)`.
 * -------------------------------------------------------------------------- */

/** Delete all per-user notification states for a given username. */
UserNotificationSchema.statics.deleteAllForUser = async function(
    username: string,
    session?: ClientSession
) {
    const u = sanitizeUsername(username);
    if(!u) {
        return {acknowledged: false, deletedCount: 0};
    }

    const res = await this.deleteMany({username: u}, optSession(session));
    return {acknowledged: !!res.acknowledged, deletedCount: res.deletedCount ?? 0};
};

/** Delete subset of states by a list of notification ids for a given user. */
UserNotificationSchema.statics.deleteManyForUser = async function(
    username: string,
    notificationIds: Array<string | Types.ObjectId>,
    session?: ClientSession
) {
    const u = sanitizeUsername(username);
    if(!u || !Array.isArray(notificationIds) || notificationIds.length === 0) {
        return {acknowledged: false, deletedCount: 0};
    }

    const ids = USE_STRING_NOTIFICATION_ID
        ? notificationIds.map(String)
        : notificationIds.map((id) => (id instanceof Types.ObjectId ? id : new Types.ObjectId(String(id))));

    const res = await this.deleteMany({username: u, notificationId: {$in: ids}}, optSession(session));
    return {acknowledged: !!res.acknowledged, deletedCount: res.deletedCount ?? 0};
};

/** Mark all notifications as read for a user. */
UserNotificationSchema.statics.markAllRead = async function(username: string, session?: ClientSession) {
    const u = sanitizeUsername(username);
    if(!u) {
        return {acknowledged: false, modifiedCount: 0, matchedCount: 0};
    }

    const res = await this.updateMany(
        {username: u, isRead: false},
        {$set: {isRead: true, readAt: new Date()}},
        optSession(session)
    );

    // Mongoose UpdateResult has acknowledged/matchedCount/modifiedCount across v6–v8
    return {
        acknowledged: !!(res as any).acknowledged,
        matchedCount: (res as any).matchedCount ?? 0,
        modifiedCount: (res as any).modifiedCount ?? 0,
    };
};

/** Archive all notifications for a user (soft-delete alternative). */
UserNotificationSchema.statics.archiveAll = async function(username: string, session?: ClientSession) {
    const u = sanitizeUsername(username);
    if(!u) {
        return {acknowledged: false, modifiedCount: 0, matchedCount: 0};
    }

    const res = await this.updateMany(
        {username: u, isArchived: false},
        {$set: {isArchived: true}},
        optSession(session)
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
 * - If using string IDs, this still works (uses $lookup join).
 * Returns the number of deleted orphan docs.
 */
UserNotificationSchema.statics.pruneOrphans = async function(session?: ClientSession) {
    const pipeline: any[] = [
        {
            $lookup: {
                from: 'notifications',
                localField: 'notificationId',
                foreignField: '_id',
                as: 'n',
            },
        },
        {$match: {n: {$size: 0}}},
        {$project: {_id: 1}},
    ];

    // aggregate().session(...) expects ClientSession | null
    const orphans = await this.aggregate(pipeline).session(session ?? null);
    if(!orphans.length) return 0;

    const ids = orphans.map((o: any) => o._id);
    const res = await this.deleteMany({_id: {$in: ids}}, optSession(session));
    return res.deletedCount ?? 0;
};

/* ----------------------------------------------------------------------------
 * Model
 * -------------------------------------------------------------------------- */
export const UserNotificationModel = model<UserNotificationEntity, UserNotificationModelType>(
    'UserNotification',
    UserNotificationSchema,
    'user_notifications'
);
