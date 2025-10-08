import {Schema, model, Types, Document} from 'mongoose';

export interface INotification extends Document {
    type: string;                // e.g. PROPERTY_CREATED, USER_CREATED
    title: string;               // e.g. "New property added"
    body: string;                // e.g. "Green Park Villa was added."
    meta?: Record<string, any>;  // extra data: { propertyId, userId, leaseId }
    createdAt: Date;
}

const NotificationSchema = new Schema<INotification>(
    {
        type: {type: String, required: true},
        title: {type: String, required: true},
        body: {type: String, required: true},
        meta: {type: Schema.Types.Mixed},
        createdAt: {type: Date, default: Date.now},
    },
    {versionKey: false}
);

export const NotificationModel = model<INotification>(
    'notifications',
    NotificationSchema
);