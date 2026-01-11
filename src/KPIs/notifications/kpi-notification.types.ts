// ============================================================================
// Path: src/KPIs/notifications/kpi-notification.types.ts
// ============================================================================

export type KpiNotifyChannel = 'email' | 'sms';

export interface KpiRecipient {
  memberId?: string;
  teamId?: string;

  // Contact targets (resolved by your member/team directory later)
  email?: string;
  phone?: string;

  displayName?: string;
}

export interface KpiWarningMessage {
  title: string;
  body: string;

  // For audits/troubleshooting
  occurredAtISO: string;
  severity: 'info' | 'warning' | 'danger';
}
