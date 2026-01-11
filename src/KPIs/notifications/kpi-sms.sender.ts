// ============================================================================
// Path: src/KPIs/notifications/kpi-sms.sender.ts
// ============================================================================
// SMS Sender Interface + Default Stub
// ----------------------------------------------------------------------------
// Replace stub with real provider later (Twilio, Dialog, etc.)
// ============================================================================

import type { KpiRecipient, KpiWarningMessage } from './kpi-notification.types';

export interface IKpiSmsSender {
  send(recipient: KpiRecipient, msg: KpiWarningMessage): Promise<void>;
}

export class KpiConsoleSmsSender implements IKpiSmsSender {
  public constructor() {}

  public async send(recipient: KpiRecipient, msg: KpiWarningMessage): Promise<void> {
    console.log(
      `[Info:] [KPI SMS] To=${recipient.phone ?? 'N/A'} Title=${msg.title}\n`,
      msg.body,
      '\n',
    );
  }
}
