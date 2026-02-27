// Path: src/source/notifications/text-template.types.ts

import type { NotificationEmitInput } from "../../types/notification/notification.types";

export interface NotificationTextContext {
  actor?: string;
  username?: string;
  role?: string;
  team?: string;
  refId?: string;
  amount?: string;
  currency?: string;
  reason?: string;
}

export interface NotificationTextPacket {
  title: string;
  body: string;
}

export type { NotificationEmitInput };