// Path: src/services/notifications/delivery/drivers/email.delivery.driver.ts
import type {
  NotificationDeliveryContext,
  NotificationDeliveryDriver,
  DeliveryAttemptResult,
  DeliveryChannel,
} from "../notification-delivery.types";

export class EmailDeliveryDriver implements NotificationDeliveryDriver {
  private readonly enabled: boolean;

  public constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public channel(): DeliveryChannel {
    return "email";
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public async deliver(ctx: NotificationDeliveryContext): Promise<DeliveryAttemptResult> {
    const withEmail = ctx.recipients.filter((r) => !!r.email);

    if (!withEmail.length) {
      return {
        channel: "email",
        status: "skipped",
        attempted: 0,
        delivered: 0,
        failed: 0,
      };
    }

    // Placeholder: real provider integration later (SendGrid, SES, etc.)
    // eslint-disable-next-line no-console
    console.log(`[Info:] EmailDeliveryDriver sending ${withEmail.length} emails.\n`);

    return {
      channel: "email",
      status: "delivered",
      attempted: withEmail.length,
      delivered: withEmail.length,
      failed: 0,
    };
  }
}
