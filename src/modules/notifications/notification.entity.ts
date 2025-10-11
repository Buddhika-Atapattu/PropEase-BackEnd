import {Mongoose, Types, Document, Schema} from "mongoose";
import {Role} from "../../types/roles";
import {NotificationAudience} from "../../types/roles";

export interface NotificationEntity {
    _id?: string;
    title: string;
    body: string;
    type?: 'system' | 'lease' | 'payment' | 'complaint' | 'general' | 'reminder' | 'alert' | 'promotion' | 'event' | 'update' | 'survey' | 'announcement' | 'maintenance' | 'emergency' | 'welcome' | 'farewell' | 'policy' | 'security' | 'custom' | 'other' | string;
    severity?: 'info' | 'success' | 'warning' | 'error';
    audience: NotificationAudience;
    createdAt: Date;
    expiresAt?: Date; // optional TTL
    metadata?: Record<string, any>;
    channels?: Array<'inapp' | 'email' | 'sms'>; // we’ll use 'inapp' now
}