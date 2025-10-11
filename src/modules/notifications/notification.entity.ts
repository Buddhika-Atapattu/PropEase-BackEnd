// src/modules/notifications/notification.entity.ts
import {NotificationAudience} from '../../types/roles';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export type NotificationType =
    | 'system'
    | 'lease'
    | 'payment'
    | 'complaint'
    | 'general'
    | 'reminder'
    | 'alert'
    | 'promotion'
    | 'event'
    | 'update'
    | 'survey'
    | 'announcement'
    | 'maintenance'
    | 'emergency'
    | 'welcome'
    | 'farewell'
    | 'policy'
    | 'security'
    | 'custom'
    | 'other'
    | string; // allow custom strings while keeping common literals

export interface NotificationEntity {
    _id?: string; // stored as string in your codebase; if you switch to ObjectId, update accordingly
    title: string;
    body: string;
    type?: NotificationType;
    severity?: NotificationSeverity;
    audience: NotificationAudience;
    createdAt: Date;
    expiresAt?: Date; // optional TTL
    metadata?: Record<string, any>;
    channels?: Array<'inapp' | 'email' | 'sms'>; // using 'inapp' now
}
