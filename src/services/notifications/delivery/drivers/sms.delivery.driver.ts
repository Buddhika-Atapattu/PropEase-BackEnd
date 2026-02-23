// Path: src/services/notifications/delivery/drivers/sms.delivery.driver.ts
import type {
  NotificationDeliveryContext,
  NotificationDeliveryDriver,
  DeliveryAttemptResult,
  DeliveryChannel,
} from "../notification-delivery.types";

export class SmsDeliveryDriver implements NotificationDeliveryDriver {
  private readonly enabled: boolean;

  public constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public channel(): DeliveryChannel {
    return "sms";
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public async deliver(ctx: NotificationDeliveryContext): Promise<DeliveryAttemptResult> {
    const withPhone = ctx.recipients.filter((r) => !!r.phoneE164);

    if (!withPhone.length) {
      return { channel: "sms", status: "skipped", attempted: 0, delivered: 0, failed: 0 };
    }

    // Placeholder: Twilio / local SMS gateway later
    // eslint-disable-next-line no-console
    console.log(`[Info:] SmsDeliveryDriver sending ${withPhone.length} sms.\n`);

    return { channel: "sms", status: "delivered", attempted: withPhone.length, delivered: withPhone.length, failed: 0 };
  }
}
