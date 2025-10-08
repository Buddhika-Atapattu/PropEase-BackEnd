import {Schema, model, Types, Document} from 'mongoose';

export interface INotificationDelivery extends Document {
    notificationId: Types.ObjectId;  // linked to Notification
    userId: Types.ObjectId;          // recipient user
    role: string;                    // Admin, Agent, Tenant, etc.
    isRead: boolean;
    readAt?: Date;
    isArchived: boolean;
    deliveredAt: Date;
}

const NotificationDeliverySchema = new Schema<INotificationDelivery>(
    {
        notificationId: {
            type: Schema.Types.ObjectId,
            ref: 'notifications',
            required: true,
        },
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'users', // your existing user collection
            required: true,
        },
        role: {type: String, required: true},
        isRead: {type: Boolean, default: false},
        readAt: {type: Date},
        isArchived: {type: Boolean, default: false},
        deliveredAt: {type: Date, default: Date.now},
    },
    {versionKey: false}
);

// optional indexes for performance
NotificationDeliverySchema.index({userId: 1, deliveredAt: -1});
NotificationDeliverySchema.index({userId: 1, isRead: 1});
NotificationDeliverySchema.index({notificationId: 1});

export const NotificationDeliveryModel = model<INotificationDelivery>(
    'notification_deliveries',
    NotificationDeliverySchema
);