// Path: src/services/notifications/delivery/drivers/external.delivery.driver.ts
import type {
  NotificationDeliveryContext,
  NotificationDeliveryDriver,
  DeliveryAttemptResult,
  DeliveryChannel,
} from "../notification-delivery.types";

export class ExternalIntegrationDeliveryDriver implements NotificationDeliveryDriver {
  private readonly enabled: boolean;

  public constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public channel(): DeliveryChannel {
    return "external";
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public async deliver(ctx: NotificationDeliveryContext): Promise<DeliveryAttemptResult> {
    // Placeholder: webhook / third-party integration later
    // eslint-disable-next-line no-console
    console.log(`[Info:] ExternalIntegrationDeliveryDriver executed for notificationId=${ctx.notificationId}.\n`);

    return { channel: "external", status: "delivered", attempted: 1, delivered: 1, failed: 0 };
  }
}
