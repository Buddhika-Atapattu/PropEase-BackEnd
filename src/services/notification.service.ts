import NotificationRepo from '../modules/notifications/notification.repo';
import UserNotificationRepo from '../modules/notifications/user-notification.repo';
import {NotificationEntity} from '../modules/notifications/notification.entity';
import {Role} from '../types/roles';

export interface ListOptions {limit?: number; skip?: number; onlyUnread?: boolean;}

export default class NotificationService {
    constructor (
        private readonly notifications = new NotificationRepo(),
        private readonly userNotifs = new UserNotificationRepo(),
    ) {}

    async createNotification(
        doc: Omit<NotificationEntity, 'createdAt'>,
        emit?: (rooms: string[], payload: any) => void
    ) {
        const saved = await this.notifications.create({...doc, createdAt: new Date()});
        const rooms: string[] = [];
        if(doc.audience.mode === 'broadcast') rooms.push('broadcast');
        if(doc.audience.mode === 'user') (doc.audience.usernames ?? []).forEach(u => rooms.push(`user:${u}`));
        if(doc.audience.mode === 'role') (doc.audience.roles ?? []).forEach(r => rooms.push(`role:${r}`));
        emit?.(rooms, {event: 'notification.new', data: saved});
        return saved;
    }

    private buildAudienceFilter(username: string, role: Role) {
        return {
            $or: [
                {'audience.mode': 'broadcast'},
                {'audience.mode': 'user', 'audience.usernames': username},
                {'audience.mode': 'role', 'audience.roles': role},
            ]
        };
    }

    async listForUser(username: string, role: Role, opts: ListOptions = {}) {
        const {limit = 50, skip = 0, onlyUnread} = opts;
        const now = new Date();

        const raw = await this.notifications.find({
            ...this.buildAudienceFilter(username, role),
            $or: [{expiresAt: {$exists: false}}, {expiresAt: {$gt: now}}],
        }, limit, skip);

        await Promise.all(raw.map(n => this.userNotifs.upsert(username, String(n._id))));
        const states = await this.userNotifs.findForUser(username, limit, skip, onlyUnread);
        const byId = new Map(states.map(s => [String(s.notificationId), s]));

        return raw.map(n => {
            const s = byId.get(String(n._id));
            if(onlyUnread && s?.isRead) return null;
            return {
                ...n.toObject(),
                userState: s ? {
                    isRead: s.isRead, isArchived: s.isArchived, deliveredAt: s.deliveredAt, readAt: s.readAt
                } : {isRead: false, isArchived: false}
            };
        }).filter(Boolean);
    }

    markRead(username: string, notificationId: string) {
        return this.userNotifs.markRead(username, notificationId);
    }
    markAllRead(username: string) {return this.userNotifs.markAllRead(username);}
}