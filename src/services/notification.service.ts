// src/services/notification.service.ts
import NotificationRepo from '../modules/notifications/notification.repo';
import UserNotificationRepo from '../modules/notifications/user-notification.repo';
import {NotificationEntity} from '../modules/notifications/notification.entity';
import {Role} from '../types/roles';

export interface ListOptions {
    limit?: number;
    skip?: number;
    onlyUnread?: boolean;
}

export default class NotificationService {
    constructor (
        private readonly notifications = new NotificationRepo(),
        private readonly userNotifs = new UserNotificationRepo(),
    ) {}

    /**
     * Create a notification and (optionally) emit it to audience rooms.
     * NOTE: we emit the saved document directly (no {event, data} wrapper).
     */
    async createNotification(
        doc: Omit<NotificationEntity, 'createdAt'>,
        emit?: (rooms: string[], payload: any) => void
    ) {
        const saved = await this.notifications.create({...doc, createdAt: new Date()});

        const rooms: string[] = [];
        if(doc.audience.mode === 'broadcast') rooms.push('broadcast');
        if(doc.audience.mode === 'user') (doc.audience.usernames ?? []).forEach(u => rooms.push(`user:${u}`));
        if(doc.audience.mode === 'role') (doc.audience.roles ?? []).forEach(r => rooms.push(`role:${r}`));

        // Emit the notification document itself; controller will emit with event name.
        emit?.(rooms, saved);
        return saved;
    }

    /** Build Mongo filter for items visible to this username/role */
    private buildAudienceFilter(username: string, role: Role) {
        return {
            $or: [
                {'audience.mode': 'broadcast'},
                {'audience.mode': 'user', 'audience.usernames': username},
                {'audience.mode': 'role', 'audience.roles': role},
            ],
        };
    }

    /**
     * List notifications for the user.
     * Ensures per-user state exists (fan-out on read), then merges master + state.
     */
    async listForUser(username: string, role: Role, opts: ListOptions = {}) {
        const {limit = 50, skip = 0, onlyUnread} = opts;
        const now = new Date();

        // 1) Load relevant master notifications
        const raw = await this.notifications.find(
            {
                ...this.buildAudienceFilter(username, role),
                $or: [{expiresAt: {$exists: false}}, {expiresAt: {$gt: now}}],
            },
            limit,
            skip
        );

        // 2) Ensure per-user state rows exist
        await Promise.all(raw.map(n => this.userNotifs.upsert(username, String(n._id))));

        // 3) Read back the user's states and merge
        const states = await this.userNotifs.findForUser(username, limit, skip, onlyUnread);
        const byId = new Map(states.map(s => [String(s.notificationId), s]));

        const merged = raw
            .map(n => {
                const s = byId.get(String(n._id));
                if(onlyUnread && s?.isRead) return null;

                // n may be a Mongoose doc; toObject() if available for clean JSON
                const base = typeof (n as any).toObject === 'function' ? (n as any).toObject() : n;

                return {
                    ...base,
                    userState: s
                        ? {
                            isRead: s.isRead,
                            isArchived: s.isArchived,
                            deliveredAt: s.deliveredAt,
                            readAt: s.readAt,
                        }
                        : {isRead: false, isArchived: false},
                };
            })
            // Type guard so TS knows nulls are removed
            .filter((x): x is NonNullable<typeof x> => Boolean(x));

        return merged;
    }

    markRead(username: string, notificationId: string) {
        return this.userNotifs.markRead(username, notificationId);
    }

    markAllRead(username: string) {
        return this.userNotifs.markAllRead(username);
    }
}
