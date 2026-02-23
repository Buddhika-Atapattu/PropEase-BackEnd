// ============================================================================
// Path: src/api/teamManagement/teamKpi.router.ts
// ============================================================================

import { Router, type Request, type Response } from "express";

import { ApiResponseBuilder } from "../../utils/api-combiner.builder";
import { MemberProfileController } from "../../controllers/member-profile.controller";

// ✅ Replace this import with your real engine service path/class name
import { TeamManagementKpiEngine } from "../../KPIs/teamManagement/kpi.engine";

import type { KpiTarget, KpiWindow } from "../../KPIs/shared/kpi.types";
import type { KpiFilters } from "../../KPIs/shared/kpi.types";

/**
 * TeamKpiRouter
 *
 * INTRODUCTION
 * - Key-driven KPI router for Team Management.
 * - One endpoint for all KPI metrics: /metric/:key
 * - Provides /keys and /batch for frontend dashboards.
 *
 * IMPORTANT MATTERS
 * - exactOptionalPropertyTypes-safe:
 *   - We never pass filters: undefined; we omit filters entirely.
 * - Scope is validated here, but your KPI engine should also enforce RBAC policy
 *   (Option A: scope depends on system role/team job role).
 *
 * WHY THIS ROUTER
 * - Avoids "endpoint-per-metric" explosion.
 * - Enables adding KPI modules later without changing router surface area.
 */
export default class TeamKpiRouter {
  public readonly route: Router;

  private readonly router: Router;
  private readonly engine: TeamManagementKpiEngine;

  public constructor () {
    this.router = Router();
    this.route = this.router;

    this.engine = new TeamManagementKpiEngine();

    this.registerRoutes(); 
  }

  private registerRoutes(): void {
    // KPI Discovery
    this.router.get( "/keys", this.handleListKeys );

    // Single metric (REST snapshot)
    this.router.get( "/metric/:key", this.handleMetricByKey );

    // Batch metrics (dashboard optimization)
    this.router.post( "/batch", this.handleBatch );

    // Member profile (existing)
    this.router.get( "/member-profile", MemberProfileController.getMemberProfile );
  }

  // ==========================================================================
  // Handlers
  // ==========================================================================

  private readonly handleListKeys = async ( req: Request, res: Response ): Promise<void> => {
    try {
      const keys = this.engine.listKeys();
      ApiResponseBuilder.ok( res, "other", { keys }, "KPI keys loaded" );
      return;
    } catch ( error: unknown ) {
      console.error( "[Error:] [TeamKpiRouter:keys]\n", error );
      ApiResponseBuilder.error( res, 500, "Failed to load KPI keys" );
      return;
    }
  };

  private readonly handleMetricByKey = async ( req: Request, res: Response ): Promise<void> => {
    try {
      const keyRaw = String( req.params.key ?? "" ).trim();
      if ( !keyRaw ) {
        ApiResponseBuilder.error( res, 422, "KPI key is required" );
        return;
      }

      if ( !this.engine.isKey( keyRaw ) ) {
        ApiResponseBuilder.error( res, 422, "Invalid KPI key" );
        return;
      }

      const target = this.parseTarget( req );
      if ( !target ) {
        ApiResponseBuilder.error( res, 422, "Invalid target. Required: scope, targetId" );
        return;
      }

      const window = this.parseWindow( req );
      if ( !window ) {
        ApiResponseBuilder.error( res, 422, "Invalid window. Required: from, to (ISO date)" );
        return;
      }

      const filters = this.parseFilters( req );

      const metric = await this.engine.computeMetric( {
        key: keyRaw, // ✅ now narrowed to union by type guard
        target,
        window,
        ...( filters ? { filters } : {} ),
      } );

      ApiResponseBuilder.ok( res, "other", { metric }, "KPI metric loaded" );
      return;
    } catch ( error: unknown ) {
      console.error( "[Error:] [TeamKpiRouter:metric]\n", error );
      ApiResponseBuilder.error( res, 500, "Failed to load KPI metric" );
      return;
    }
  };

  private readonly handleBatch = async ( req: Request, res: Response ): Promise<void> => {
    try {
      const body = ( req.body ?? {} ) as Record<string, unknown>;

      const keysRaw = body[ "keys" ];
      if ( !Array.isArray( keysRaw ) || keysRaw.length === 0 ) {
        ApiResponseBuilder.error( res, 422, "Body.keys must be a non-empty array" );
        return;
      }

      const keys = keysRaw
        .map( ( k ) => ( typeof k === "string" ? k.trim() : "" ) )
        .filter( ( k ) => !!k );

      if ( keys.length === 0 ) {
        ApiResponseBuilder.error( res, 422, "Body.keys contains no valid keys" );
        return;
      }

      const invalid = keys.filter( ( k ) => !this.engine.isKey( k ) );
      if ( invalid.length > 0 ) {
        ApiResponseBuilder.error( res, 422, `Invalid KPI keys: ${ invalid.join( ", " ) }` );
        return;
      }

      const typedKeys = keys as Array<TeamManagementKpiEngine.TeamManagementKpiKey>;

      const target = this.parseTarget( req );
      if ( !target ) {
        ApiResponseBuilder.error( res, 422, "Invalid target. Required: scope, targetId" );
        return;
      }

      const window = this.parseWindow( req );
      if ( !window ) {
        ApiResponseBuilder.error( res, 422, "Invalid window. Required: from, to (ISO date)" );
        return;
      }

      const filters = this.parseFilters( req );

      const results = await this.engine.computeBatch( {
        keys: typedKeys,
        target,
        window,
        ...( filters ? { filters } : {} ),
      } );

      ApiResponseBuilder.ok( res, "other", { results }, "KPI batch loaded" );
      return;
    } catch ( error: unknown ) {
      console.error( "[Error:] [TeamKpiRouter:batch]\n", error );
      ApiResponseBuilder.error( res, 500, "Failed to load KPI batch" );
      return;
    }
  };

  // ==========================================================================
  // Parsing helpers (strict, predictable, exactOptionalPropertyTypes-safe)
  // ==========================================================================

  private parseTarget( req: Request ): KpiTarget | null {
    const scope = String( req.query.scope ?? "" ).trim().toLowerCase();
    const targetId = String( req.query.targetId ?? "" ).trim();

    // Keep allowed set minimal and aligned to your KPI core types.
    const allowed = new Set<string>( [ "member", "team", "org" ] );
    if ( !allowed.has( scope ) || !targetId ) return null;

    return { scope: scope as KpiTarget[ "scope" ], targetId };
  }

  private parseWindow( req: Request ): KpiWindow | null {
    const fromRaw = String( req.query.from ?? "" ).trim();
    const toRaw = String( req.query.to ?? "" ).trim();

    if ( !fromRaw || !toRaw ) return null;

    const from = new Date( fromRaw );
    const to = new Date( toRaw );

    if ( Number.isNaN( from.getTime() ) || Number.isNaN( to.getTime() ) ) return null;
    if ( from.getTime() > to.getTime() ) return null;

    return { from, to };
  }

  /**
   * Filters
   * - Keep this very small and KPI-relevant.
   * - Do NOT add “random” filters unless the data services support them.
   */
  private parseFilters( req: Request ): KpiFilters | undefined {
    const filters: Record<string, unknown> = {};

    const teamId = String( req.query.teamId ?? "" ).trim();
    if ( teamId ) filters.teamId = teamId;

    const priority = String( req.query.priority ?? "" ).trim();
    if ( priority ) filters.priority = priority;

    const status = String( req.query.status ?? "" ).trim();
    if ( status ) filters.status = status;

    const type = String( req.query.type ?? "" ).trim();
    if ( type ) filters.type = type;

    const domain = String( req.query.domain ?? "" ).trim();
    if ( domain ) filters.domain = domain;

    return Object.keys( filters ).length > 0 ? ( filters as KpiFilters ) : undefined;
  }
}