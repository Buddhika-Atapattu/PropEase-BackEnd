// ============================================================================
// Path: src/KPIs/data/kpi-facts.types.ts
// ============================================================================
// KPI Fact Types (DB-Level Contracts)
// ----------------------------------------------------------------------------
// Why facts are needed:
//   You already have property insert/update,
//   but KPIs like sale/rent ratio, commission, satisfaction require "outcomes":
//     - a deal was closed
//     - commission earned
//     - customer rated the service
//
//   These are "facts" because they are authoritative records used for analytics.
// ----------------------------------------------------------------------------
// Key requirement:
//   KPIs must produce % and actual values,
//   so we store enough dimensions to compute both.
// ----------------------------------------------------------------------------
// This file contains pure interfaces and union types only (no DB code).
// Mongoose schemas will implement these in kpi-model.adapter.ts.
// ============================================================================

/**
 * Reusable dimension fields for large real estate org segmentation.
 * We keep them optional where they might not exist yet in your system.
 */
export interface KpiBaseDimensions {
  orgId: string;

  /**
   * Real estate business usually splits company by region/branch.
   * If you don't have them yet, keep null/undefined and add later.
   */
  regionId?: string;
  branchId?: string;

  /**
   * Teams are important for performance KPIs.
   */
  teamId?: string;
}

/**
 * Deal types for real estate business.
 */
export type DealType = 'sale' | 'rent';

/**
 * Deal status.
 * For KPIs you normally count only "won" deals,
 * but keeping lost/cancelled enables conversion KPIs later.
 */
export type DealStatus = 'won' | 'lost' | 'cancelled';

/**
 * Deal Fact (sale/rent closed event)
 * Enables:
 * - sale vs rent ratio (%)
 * - totals by value (actual money)
 * - commissions (actual money)
 * - top sale / top rent agents (leaderboards)
 */
export interface DealFact extends KpiBaseDimensions {
  /**
   * Who closed the deal (member/agent).
   */
  agentId: string;

  /**
   * Property linked to the deal (optional, but very valuable).
   */
  propertyId?: string;

  /**
   * Property type helps segmentation: "commercial deals performance", etc.
   */
  propertyType?: 'apartment' | 'house' | 'land' | 'commercial' | 'other';

  dealType: DealType;
  status: DealStatus;

  /**
   * dealValue:
   * - for sale: sale price
   * - for rent: contract total or monthly rent (choose one definition consistently)
   */
  dealValue: number;

  /**
   * currencyCode is required for money KPIs.
   */
  currencyCode: string;

  /**
   * commissionAmount:
   * Actual commission earned for this deal.
   */
  commissionAmount: number;

  /**
   * commissionRatePercent:
   * Optional but useful for reporting and explaining calculations.
   * Example: 2.5 (means 2.5%)
   */
  commissionRatePercent?: number;

  /**
   * closedAtISO is used for time windows.
   */
  closedAtISO: string;
}

/**
 * Customer Satisfaction Fact
 * Enables:
 * - satisfaction % by member/team/org
 * - rating trends
 * - top satisfaction agents
 */
export interface SatisfactionFact extends KpiBaseDimensions {
  agentId: string;

  /**
   * Link to deal/property if available.
   * This improves traceability.
   */
  dealId?: string;
  propertyId?: string;

  /**
   * rating is 1..5
   * KPI will convert to percent: (avgRating / 5) * 100
   */
  rating: number;

  submittedAtISO: string;
}

/**
 * Maintenance event types.
 * We store event facts rather than only final ticket state,
 * because event history enables:
 * - response time (opened -> assigned/started)
 * - resolution time (opened -> completed/closed)
 * - SLA compliance (%)
 * - backlog trends
 */
export type MaintenanceEventType =
  | 'opened'
  | 'assigned'
  | 'started'
  | 'completed'
  | 'closed';

export type MaintenancePriority = 'low' | 'medium' | 'high' | 'urgent';

/**
 * Maintenance Event Fact
 * Enables:
 * - completion rate %
 * - SLA compliance %
 * - average resolution time (actual duration)
 * - tickets per property/team/member
 */
export interface MaintenanceEventFact extends KpiBaseDimensions {
  /**
   * ticketId links all events of one maintenance request.
   */
  ticketId: string;

  /**
   * propertyId is essential in real estate maintenance KPIs.
   */
  propertyId?: string;

  /**
   * memberId: technician/handler responsible for the event (optional).
   */
  memberId?: string;

  eventType: MaintenanceEventType;
  priority: MaintenancePriority;

  /**
   * SLA target in minutes. This lets you compute SLA compliance.
   * Example: urgent tickets have 60 mins SLA.
   */
  slaMinutes: number;

  occurredAtISO: string;
}

/**
 * Task statuses (Team Management).
 * You already have team tasks. This fact projection supports KPI queries.
 */
export type TeamTaskStatus =
  | 'draft'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

/**
 * Team Task Fact (projection)
 * Enables:
 * - team productivity %
 * - overdue %
 * - velocity
 * - workload balance
 */
export interface TeamTaskFact extends KpiBaseDimensions {
  taskId: string;
  memberId: string; // who owns the task
  status: TeamTaskStatus;

  createdAtISO: string;
  startedAtISO?: string;
  dueAtISO?: string;
  completedAtISO?: string;

  /**
   * reopenedCount measures quality and rework.
   */
  reopenedCount?: number;

  priority?: 'low' | 'medium' | 'high' | 'urgent';
}

/**
 * (Optional future) Lead funnel facts for true conversion ratios.
 * Real estate companies often track:
 * lead -> viewing -> offer -> won/lost
 *
 * If you don't implement it now, keeping the type helps future proofing.
 */
export type LeadStage = 'new' | 'contacted' | 'viewing' | 'offer' | 'won' | 'lost';
export type LeadSource = 'walk_in' | 'facebook' | 'google' | 'referral' | 'partner' | 'other';

export interface LeadFact extends KpiBaseDimensions {
  leadId: string;

  agentId?: string;
  source: LeadSource;
  stage: LeadStage;

  updatedAtISO: string;
}
