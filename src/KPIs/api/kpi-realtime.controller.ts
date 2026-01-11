// ============================================================================
// Path: src/KPIs/api/kpi-realtime.controller.ts
// ============================================================================

import type { Request, Response } from 'express';
import { KpisRuntime } from '../kpis.runtime';

export class KpiRealtimeController {
  public constructor() {}

  public async health(req: Request, res: Response): Promise<void> {
    void req;

    // If runtime is alive, bridge is subscribed and hub exists.
    const runtime = KpisRuntime.getInstance();

    res.status(200).json({
      success: true,
      status: 'success',
      message: 'KPI realtime runtime is active.',
      timestamp: new Date().toISOString(),
      data: {
        transport: 'in-memory',
        runtime: 'started',
        hub: Boolean(runtime.getRealtimeHub()),
      },
    });
    return;
  }
}
