// Path: tools/notifications/backfill-user-inbox.ts
import mongoose from "mongoose";
import { NotificationRecipientResolverRegistry } from "../../src/services/notifications/notification-recipient-resolver.registry.service";
import { UserNotificationModel } from "../../src/models/notifications/user-notification.model";

// adjust to your real master notification model import
import { NotificationModel } from "../../src/models/notifications/notification.model";

// reuse your bootstrap so resolvers are registered
import { NotificationResolversBootstrap } from "../../src/bootstrap/notifications/notification-resolvers.bootstrap";
import { NotificationRestService } from "../../src/services/notifications/notification.rest.service";

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/propease");

  NotificationResolversBootstrap.init();

  const notifRest = new NotificationRestService();

  const notifications = await NotificationModel.find({}, { audiences: 1, createdAt: 1 }).lean().exec();

  for (const n of notifications) {
    const audiences = Array.isArray((n as any)?.audiences) ? (n as any).audiences : [];
    if (audiences.length === 0) continue;

    const usernameSet = new Set<string>();

    for (const aud of audiences) {
      const res = await NotificationRecipientResolverRegistry.resolve(aud, {});
      for (const u of res.usernames) usernameSet.add(u);
    }

    for (const username of usernameSet) {
      const userId = await notifRest.findUserIdByUsernameOrThrow(username);

      await UserNotificationModel.updateOne(
        { userId, notificationId: (n as any)._id },
        {
          $setOnInsert: {
            userId,
            username,
            notificationId: (n as any)._id,
            isRead: false,
            isDeleted: false,
            isArchived: false,
            deliveredAt: (n as any).createdAt ? new Date((n as any).createdAt) : new Date(),
          },
        },
        { upsert: true }
      ).exec();
    }
  }

  // eslint-disable-next-line no-console
  console.log("[Success:] Notification inbox backfill completed.\n");

  await mongoose.disconnect();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.log(`[Error:] Backfill failed: ${(e as Error)?.message ?? "unknown"}\n`);
  process.exit(1);
});