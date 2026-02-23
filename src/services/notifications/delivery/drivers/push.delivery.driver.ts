// Path: src/services/notifications/delivery/drivers/push.delivery.driver.ts
import type {
  NotificationDeliveryContext,
  NotificationDeliveryDriver,
  DeliveryAttemptResult,
  DeliveryChannel,
} from "../notification-delivery.types";

export class PushDeliveryDriver implements NotificationDeliveryDriver {
  private readonly enabled: boolean;

  public constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public channel(): DeliveryChannel {
    return "push";
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public async deliver(ctx: NotificationDeliveryContext): Promise<DeliveryAttemptResult> {
    const withTokens = ctx.recipients.filter((r) => Array.isArray(r.pushTokens) && r.pushTokens.length > 0);

    if (!withTokens.length) {
      return { channel: "push", status: "skipped", attempted: 0, delivered: 0, failed: 0 };
    }

    // Placeholder: FCM/APNs later
    // eslint-disable-next-line no-console
    console.log(`[Info:] PushDeliveryDriver sending ${withTokens.length} push notifications.\n`);

    return { channel: "push", status: "delivered", attempted: withTokens.length, delivered: withTokens.length, failed: 0 };
  }
}
