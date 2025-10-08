import {Types} from 'mongoose';
import {NotificationModel} from '../models/notification.model';
import {NotificationDeliveryModel} from '../models/notificationDelivery.model';
import {UserModel} from '../models/user.model';

export class NotificationService {
    /**
     * Create a notification and send to multiple users (admins, agents, tenants)
     */
    static async createAndSend(
        io: any,
        params: {
            type: string;
            title: string;
            body: string;
            meta?: Record<string, any>;
            recipients?: Types.ObjectId[]; // user IDs
            roles?: string[];              // optional role-based targeting
        }
    ) {
        // 1️⃣ Create the main notification
        const notification = await NotificationModel.create({
            type: params.type,
            title: params.title,
            body: params.body,
            meta: params.meta ?? {},
        });

        // 2️⃣ Determine recipients
        let userIds: Types.ObjectId[] = [];

        // If specific user IDs are passed
        if(params.recipients?.length) {
            userIds = params.recipients;
        }

        // If role-based targeting is requested
        if(params.roles?.length) {
            const usersByRole = (await UserModel.find(
                {role: {$in: params.roles}},
                {_id: 1}
            )
                .lean()) as unknown as Array<{_id: Types.ObjectId}>;   // ✅ strong cast + lean()

            const roleUserIds = usersByRole.map((u) => u._id);
            userIds = [...new Set([...userIds, ...roleUserIds])];
        }

        // No recipients → skip delivery
        if(!userIds.length) return notification;

        // 3️⃣ Create delivery records for each recipient
        const deliveries = userIds.map((userId) => ({
            notificationId: notification._id,
            userId,
            role: 'General',
            isRead: false,
            isArchived: false,
        }));

        await NotificationDeliveryModel.insertMany(deliveries);

        // 4️⃣ Emit real-time socket event to each user
        userIds.forEach((userId) => {
            io.to(`user:${userId}`).emit('notification:new', {
                id: notification._id,
                type: notification.type,
                title: notification.title,
                body: notification.body,
                meta: notification.meta,
                createdAt: notification.createdAt,
            });
        });

        return notification;
    }
}
