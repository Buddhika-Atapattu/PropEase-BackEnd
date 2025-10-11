import { Schema, model } from 'mongoose';
import { NotificationEntity } from '../../modules/notifications/notification.entity';

const AudienceSchema = new Schema({
  mode: { type: String, enum: ['user', 'role', 'broadcast'], required: true },
  usernames: [{ type: String, index: true }],
  roles: [{ type: String, index: true }],
}, { _id: false });

const NotificationSchema = new Schema<NotificationEntity>({
  title: { type: String, required: true },
  body: { type: String, required: true },
  type: { type: String, default: 'general' },
  severity: { type: String, default: 'info' },
  audience: { type: AudienceSchema, required: true },
  createdAt: { type: Date, default: () => new Date(), index: true },
  expiresAt: { type: Date, index: true }, // add TTL below
  metadata: { type: Object },
  channels: [{ type: String, default: 'inapp' }],
});

NotificationSchema.index({ 'audience.mode': 1, createdAt: -1 });
NotificationSchema.index({ 'audience.usernames': 1, createdAt: -1 });
NotificationSchema.index({ 'audience.roles': 1, createdAt: -1 });

// TTL (Mongo will auto-delete expired docs). Set at collection level:
// db.notifications.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const NotificationModel = model<NotificationEntity>('Notification', NotificationSchema);