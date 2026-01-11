// ============================================================================
// Path: src/KPIs/api/kpi.routes.ts
// ============================================================================
// KPI REST Routes (Fact Submission)
// ----------------------------------------------------------------------------
// Purpose:
//   KPI submissions arrive via REST and are written as "facts" to MongoDB.
//   Displaying / realtime outputs happen later via WebSocket + Registry.
//
// Security:
//   - You already have firewall + guard token + session token systems.
//   - For now, we only expose router endpoints.
//   - Later you will wire this router into your guarded routes map.
// ============================================================================

import { Router } from 'express';
import { KpiSubmissionController } from './kpi-submission.controller';
import { KpisRuntime } from '../kpis.runtime';
import { KpiRealtimeController } from './kpi-realtime.controller';


export class KpiRoutes {
  private readonly router: Router;
  private readonly controller: KpiSubmissionController;
  private readonly realtimeController: KpiRealtimeController;


  public constructor () {
    KpisRuntime.getInstance().ensureStarted();

    this.router = Router();
    this.controller = new KpiSubmissionController();
    this.realtimeController = new KpiRealtimeController();

    this.mapRoutes();
  }


  public getRouter(): Router {
    return this.router;
  }

  private mapRoutes(): void {
    // Deals (property sales/rents) facts
    this.router.post( '/facts/deals', ( req, res ) => this.controller.submitDealFact( req, res ) );

    // Customer satisfaction facts
    this.router.post( '/facts/satisfaction', ( req, res ) => this.controller.submitSatisfactionFact( req, res ) );

    // Maintenance ticket events (timeline)
    this.router.post( '/facts/maintenance/events', ( req, res ) => this.controller.submitMaintenanceEvent( req, res ) );

    // Team task projection facts (for completion/overdue)
    this.router.post( '/facts/team/tasks', ( req, res ) => this.controller.submitTeamTaskFact( req, res ) );

    // ADD inside mapRoutes()

    this.router.post( '/facts/team/task-evidence', ( req, res ) => this.controller.submitTeamTaskEvidence( req, res ) );
    this.router.post( '/facts/team/task-events', ( req, res ) => this.controller.submitTeamTaskEvent( req, res ) );

    this.router.get('/realtime/health', (req, res) => this.realtimeController.health(req, res));


  }
}
