// Path: src/services/notifications/delivery/drivers/audit-stream.delivery.driver.ts
import type {
  NotificationDeliveryContext,
  NotificationDeliveryDriver,
  DeliveryAttemptResult,
  DeliveryChannel,
} from "../notification-delivery.types";

export class AuditStreamDeliveryDriver implements NotificationDeliveryDriver {
  private readonly enabled: boolean;

  public constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public channel(): DeliveryChannel {
    return "audit";
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public async deliver(ctx: NotificationDeliveryContext): Promise<DeliveryAttemptResult> {
    // Placeholder: stream audit record to file/db/ELK later
    // eslint-disable-next-line no-console
    console.log(`[Info:] AuditStreamDeliveryDriver audit for notificationId=${ctx.notificationId}.\n`);

    return { channel: "audit", status: "delivered", attempted: 1, delivered: 1, failed: 0 };
  }
}
