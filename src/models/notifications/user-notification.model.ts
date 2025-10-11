import {Schema, model} from 'mongoose';
import {UserNotificationEntity} from '../../modules/notifications/user-notification.entity';

const UserNotificationSchema = new Schema<UserNotificationEntity>({
    username: {type: String, required: true, index: true},
    notificationId: {type: Schema.Types.String, required: true, index: true},
    isRead: {type: Boolean, default: false, index: true},
    isArchived: {type: Boolean, default: false, index: true},
    deliveredAt: {type: Date, default: () => new Date(), index: true},
    readAt: {type: Date},
});

UserNotificationSchema.index({username: 1, notificationId: 1}, {unique: true});
UserNotificationSchema.index({username: 1, isRead: 1, deliveredAt: -1});

export const UserNotificationModel = model<UserNotificationEntity>('UserNotification', UserNotificationSchema);