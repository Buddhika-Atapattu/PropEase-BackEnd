// ============================================================================
// Path: src/KPIs/notifications/kpi-email.sender.ts
// ============================================================================
// Email Sender Interface + Default Stub
// ----------------------------------------------------------------------------
// Replace stub with real provider later (SES, SendGrid, SMTP, etc.)
// ============================================================================

import type { KpiRecipient, KpiWarningMessage } from './kpi-notification.types';

export interface IKpiEmailSender {
  send(recipient: KpiRecipient, msg: KpiWarningMessage): Promise<void>;
}

export class KpiConsoleEmailSender implements IKpiEmailSender {
  public constructor() {}

  public async send(recipient: KpiRecipient, msg: KpiWarningMessage): Promise<void> {
    console.log(
      `[Info:] [KPI Email] To=${recipient.email ?? 'N/A'} Title=${msg.title}\n`,
      msg.body,
      '\n',
    );
  }
}
