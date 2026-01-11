// ============================================================================
// Path: src/KPIs/notifications/kpi-notification.dispatcher.ts
// ============================================================================

import type { KpiRecipient, KpiWarningMessage } from './kpi-notification.types';
import type { IKpiEmailSender } from './kpi-email.sender';
import type { IKpiSmsSender } from './kpi-sms.sender';

export class KpiNotificationDispatcher {
  private readonly email: IKpiEmailSender;
  private readonly sms: IKpiSmsSender;

  public constructor(email: IKpiEmailSender, sms: IKpiSmsSender) {
    this.email = email;
    this.sms = sms;
  }

  public async notify(recipient: KpiRecipient, msg: KpiWarningMessage): Promise<void> {
    // Send both when available (enterprise behavior)
    const jobs: Promise<void>[] = [];

    if (recipient.email) jobs.push(this.email.send(recipient, msg));
    if (recipient.phone) jobs.push(this.sms.send(recipient, msg));

    await Promise.all(jobs);
  }
}
