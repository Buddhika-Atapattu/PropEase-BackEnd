// ============================================================================
// Path: src/api/teamManagement/teamKpi.router.ts
// ============================================================================

import { Router, type Request, type Response } from 'express';

import { ApiResponseBuilder } from '../../utils/api-combiner.builder';
import { KpiQueryService, type KpiDbWindow } from '../../KPIs/data/kpi-query.service';
import { MemberProfileController } from '../../controller/member-profile.controller';

import type { KpiQueryTarget, KpiQueryFilters } from '../../KPIs/shared/kpi-core.types';

export default class TeamKpiRouter {
  public readonly route: Router;

  private readonly router: Router;
  private readonly kpiQuery: KpiQueryService;

  public constructor() {
    this.router = Router();
    this.route = this.router;

    this.kpiQuery = new KpiQueryService();

    this.registerRoutes();
  }

  private registerRoutes(): void {
    // KPI Snapshot endpoints (REST)
    this.registerTaskCompletionRate();
    this.registerTaskCompletionRateByTeam();
    this.registerCustomerSatisfaction();
    this.registerTopOverdueHolders();

    // Member profile (REST snapshot)
    this.router.get('/member-profile', MemberProfileController.getMemberProfile);
  }

  // --------------------------------------------------------------------------
  // GET /task-completion-rate?scope=member|team|org&targetId=...&from=ISO&to=ISO
  // --------------------------------------------------------------------------
  private registerTaskCompletionRate(): void {
    this.router.get('/task-completion-rate', async (req: Request, res: Response): Promise<void> => {
      try {
        const target = this.parseTarget(req);
        if (!target) {
          ApiResponseBuilder.error(res, 422, 'Invalid target. Required: scope, targetId');
          return;
        }

        const window = this.parseWindow(req);
        if (!window) {
          ApiResponseBuilder.error(res, 422, 'Invalid window. Required: from, to (ISO date)');
          return;
        }

        const filters = this.parseFilters(req);

        const metric = await this.kpiQuery.getTaskCompletionRate(target, window, filters);

        ApiResponseBuilder.ok(res, 'other', { metric }, 'Task completion KPI loaded');
        return;
      } catch (error: unknown) {
        console.error('[Error:] [TeamKpiRouter:task-completion-rate]\n', error);
        ApiResponseBuilder.error(res, 500, 'Failed to load task completion KPI');
        return;
      }
    });
  }

  // --------------------------------------------------------------------------
  // GET /task-completion-rate/by-team?orgId=...&from=ISO&to=ISO
  // --------------------------------------------------------------------------
  private registerTaskCompletionRateByTeam(): void {
    this.router.get('/task-completion-rate/by-team', async (req: Request, res: Response): Promise<void> => {
      try {
        const orgId = String(req.query.orgId ?? '').trim();
        if (!orgId) {
          ApiResponseBuilder.error(res, 422, 'orgId is required');
          return;
        }

        const window = this.parseWindow(req);
        if (!window) {
          ApiResponseBuilder.error(res, 422, 'Invalid window. Required: from, to (ISO date)');
          return;
        }

        const filters = this.parseFilters(req);

        const target: KpiQueryTarget = { scope: 'org', targetId: orgId };
        const rows = await this.kpiQuery.getTaskCompletionRateByTeam(target, window, filters);

        ApiResponseBuilder.ok(res, 'other', { rows }, 'Task completion by team loaded');
        return;
      } catch (error: unknown) {
        console.error('[Error:] [TeamKpiRouter:task-completion-rate-by-team]\n', error);
        ApiResponseBuilder.error(res, 500, 'Failed to load task completion by team');
        return;
      }
    });
  }

  // --------------------------------------------------------------------------
  // GET /customer-satisfaction?scope=member|team|org&targetId=...&from=ISO&to=ISO
  // --------------------------------------------------------------------------
  private registerCustomerSatisfaction(): void {
    this.router.get('/customer-satisfaction', async (req: Request, res: Response): Promise<void> => {
      try {
        const target = this.parseTarget(req);
        if (!target) {
          ApiResponseBuilder.error(res, 422, 'Invalid target. Required: scope, targetId');
          return;
        }

        const window = this.parseWindow(req);
        if (!window) {
          ApiResponseBuilder.error(res, 422, 'Invalid window. Required: from, to (ISO date)');
          return;
        }

        const filters = this.parseFilters(req);

        const metric = await this.kpiQuery.getCustomerSatisfaction(target, window, filters);

        ApiResponseBuilder.ok(res, 'other', { metric }, 'Customer satisfaction KPI loaded');
        return;
      } catch (error: unknown) {
        console.error('[Error:] [TeamKpiRouter:customer-satisfaction]\n', error);
        ApiResponseBuilder.error(res, 500, 'Failed to load customer satisfaction KPI');
        return;
      }
    });
  }

  // --------------------------------------------------------------------------
  // GET /top-overdue-holders?scope=team|org&targetId=...&from=ISO&to=ISO&top=10
  // --------------------------------------------------------------------------
  private registerTopOverdueHolders(): void {
    this.router.get('/top-overdue-holders', async (req: Request, res: Response): Promise<void> => {
      try {
        const target = this.parseTarget(req);
        if (!target) {
          ApiResponseBuilder.error(res, 422, 'Invalid target. Required: scope, targetId');
          return;
        }

        // limit this endpoint to team/org in practice (member scope is meaningless here)
        if (target.scope !== 'team' && target.scope !== 'org') {
          ApiResponseBuilder.error(res, 422, 'scope must be team or org for this endpoint');
          return;
        }

        const window = this.parseWindow(req);
        if (!window) {
          ApiResponseBuilder.error(res, 422, 'Invalid window. Required: from, to (ISO date)');
          return;
        }

        const topRaw = Number(req.query.top ?? 10);
        const top = Number.isFinite(topRaw) ? Math.max(1, Math.min(50, topRaw)) : 10;

        const filters = this.parseFilters(req);

        const rows = await this.kpiQuery.getTopOverdueTaskHolders(target, window, top, filters);

        ApiResponseBuilder.ok(res, 'other', { rows }, 'Top overdue task holders loaded');
        return;
      } catch (error: unknown) {
        console.error('[Error:] [TeamKpiRouter:top-overdue-holders]\n', error);
        ApiResponseBuilder.error(res, 500, 'Failed to load overdue holder leaderboard');
        return;
      }
    });
  }

  // ==========================================================================
  // Parsing helpers (strict, predictable)
  // ==========================================================================

  private parseTarget(req: Request): KpiQueryTarget | null {
    const scope = String(req.query.scope ?? '').trim().toLowerCase();
    const targetId = String(req.query.targetId ?? '').trim();

    const allowed = new Set<string>(['member', 'team', 'org', 'property', 'branch', 'region']);
    if (!allowed.has(scope) || !targetId) return null;

    return { scope: scope as KpiQueryTarget['scope'], targetId };
  }

  private parseWindow(req: Request): KpiDbWindow | null {
    const fromRaw = String(req.query.from ?? '').trim();
    const toRaw = String(req.query.to ?? '').trim();

    const from = new Date(fromRaw);
    const to = new Date(toRaw);

    if (!fromRaw || !toRaw) return null;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    if (from.getTime() > to.getTime()) return null;

    return { from, to };
  }

  private parseFilters(req: Request): KpiQueryFilters | undefined {
    const filters: Record<string, unknown> = {};

    const teamId = String(req.query.teamId ?? '').trim();
    if (teamId) filters.teamId = teamId;

    const agentId = String(req.query.agentId ?? '').trim();
    if (agentId) filters.agentId = agentId;

    const propertyType = String(req.query.propertyType ?? '').trim();
    if (propertyType) filters.propertyType = propertyType;

    const dealType = String(req.query.dealType ?? '').trim();
    if (dealType) filters.dealType = dealType;

    const currencyCode = String(req.query.currencyCode ?? '').trim();
    if (currencyCode) filters.currencyCode = currencyCode.toUpperCase();

    const priority = String(req.query.priority ?? '').trim();
    if (priority) filters.priority = priority;

    const category = String(req.query.category ?? '').trim();
    if (category) filters.category = category;

    return Object.keys(filters).length > 0 ? (filters as KpiQueryFilters) : undefined;
  }
}
