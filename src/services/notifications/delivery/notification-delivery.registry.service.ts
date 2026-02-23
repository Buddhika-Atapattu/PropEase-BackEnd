// Path: src/services/notifications/delivery/notification-delivery.registry.service.ts
// =============================================================================
// Notification Delivery — Driver Registry
// =============================================================================
//
// 01) Purpose of this code
// - Central registry for all delivery drivers.
// - Allows enabling/disabling drivers and iterating in a stable order.
//
// 02) What this code is managing
// - Driver registration
// - Driver retrieval by channel
//
// 03) Key highlights
// - Class-based singleton style (static registry)
// - No external side effects here
//
// 04) Keep in mind
// - Bootstrap must register drivers once at startup.
// =============================================================================

import type { DeliveryChannel, NotificationDeliveryDriver } from "./notification-delivery.types";

export class NotificationDeliveryDriverRegistry {
  private constructor() {}

  private static readonly driversByChannel = new Map<DeliveryChannel, NotificationDeliveryDriver[]>();

  public static register(driver: NotificationDeliveryDriver): void {
    const ch = driver.channel();
    const list = this.driversByChannel.get(ch) ?? [];
    list.push(driver);
    this.driversByChannel.set(ch, list);
  }

  public static listAll(): NotificationDeliveryDriver[] {
    const out: NotificationDeliveryDriver[] = [];
    for (const list of this.driversByChannel.values()) {
      out.push(...list);
    }
    return out;
  }

  public static listEnabled(): NotificationDeliveryDriver[] {
    return this.listAll().filter((d) => d.isEnabled());
  }

  public static listByChannel(channel: DeliveryChannel): NotificationDeliveryDriver[] {
    return (this.driversByChannel.get(channel) ?? []).slice();
  }
}
