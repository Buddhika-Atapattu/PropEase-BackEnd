// Path: src/bootstrap/notifications/notification-delivery.bootstrap.ts
// =============================================================================
// Notification Delivery Bootstrap
// =============================================================================
//
// Purpose:
// - Register all delivery drivers at startup.
// - Enable/disable drivers from configuration (env flags later).
// =============================================================================

import { NotificationDeliveryDriverRegistry } from "../../services/notifications/delivery/notification-delivery.registry.service";

import { EmailDeliveryDriver } from "../../services/notifications/delivery/drivers/email.delivery.driver";
import { SmsDeliveryDriver } from "../../services/notifications/delivery/drivers/sms.delivery.driver";
import { PushDeliveryDriver } from "../../services/notifications/delivery/drivers/push.delivery.driver";
import { MessageQueueDeliveryDriver } from "../../services/notifications/delivery/drivers/mq.delivery.driver";
import { AuditStreamDeliveryDriver } from "../../services/notifications/delivery/drivers/audit-stream.delivery.driver";
import { ExternalIntegrationDeliveryDriver } from "../../services/notifications/delivery/drivers/external.delivery.driver";

export class NotificationDeliveryBootstrap {
  private constructor() {}

  public static init(): void {
    // For now, enable all drivers. Later read from env/config.
    NotificationDeliveryDriverRegistry.register(new EmailDeliveryDriver(true));
    NotificationDeliveryDriverRegistry.register(new SmsDeliveryDriver(true));
    NotificationDeliveryDriverRegistry.register(new PushDeliveryDriver(true));
    NotificationDeliveryDriverRegistry.register(new MessageQueueDeliveryDriver(true));
    NotificationDeliveryDriverRegistry.register(new AuditStreamDeliveryDriver(true));
    NotificationDeliveryDriverRegistry.register(new ExternalIntegrationDeliveryDriver(true));

    // eslint-disable-next-line no-console
    console.log("[Success:] NotificationDeliveryBootstrap initialized.\n");
  }
}
