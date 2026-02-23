// Path: src/services/notifications/delivery/drivers/mq.delivery.driver.ts
import type {
  NotificationDeliveryContext,
  NotificationDeliveryDriver,
  DeliveryAttemptResult,
  DeliveryChannel,
} from "../notification-delivery.types";

export class MessageQueueDeliveryDriver implements NotificationDeliveryDriver {
  private readonly enabled: boolean;

  public constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public channel(): DeliveryChannel {
    return "mq";
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public async deliver(ctx: NotificationDeliveryContext): Promise<DeliveryAttemptResult> {
    // Placeholder: publish ctx.notification to Kafka/Rabbit topic/queue
    // eslint-disable-next-line no-console
    console.log(`[Info:] MQDeliveryDriver published notificationId=${ctx.notificationId}.\n`);

    return { channel: "mq", status: "delivered", attempted: 1, delivered: 1, failed: 0 };
  }
}
