// Path: src/api/teamManagement/teamManagement.router.ts
// ============================================================================
// TeamManagementRouter (class-based) — TS strict safe
// ----------------------------------------------------------------------------
// ✅ Fixes the "ParamsDictionary vs {teamCode:string}" errors by:
// - typing each route params via router.get/post/patch generics
// - wrapping controller async methods into a RequestHandler<P>
// - keeping fixed-prefix ordering + catch-all LAST
// ============================================================================

import express, {
    type Router,
    type Request,
    type Response,
    type NextFunction,
    type RequestHandler,
} from "express";

// Controller (your path)
import { TeamManagementController } from "../../../controller/teamManagement/teamMain/teamManagement.controller";

type TeamCodeParams = { teamCode: string; };
type TeamNameParams = { teamName: string; };
type DomainParams = { domain: string; };

export default class TeamManagementRouter {
    private readonly router: Router;
    private readonly ctrl: TeamManagementController;

    public constructor () {
        this.router = express.Router();
        this.ctrl = new TeamManagementController();
        this.registerRoutes();
    }

    public get route(): Router {
        return this.router;
    }

    // ==========================================================================
    // ✅ Async wrapper: converts (req,res)=>Promise into Express RequestHandler<P>
    // ==========================================================================
    private h<P extends Record<string, string>>(
        fn: ( req: Request<P>, res: Response ) => Promise<void>
    ): RequestHandler<P> {
        return ( req: Request<P>, res: Response, next: NextFunction ): void => {
            Promise.resolve( fn( req, res ) ).catch( next );
        };
    }

    // ==========================================================================
    // Route registration (ORDER MATTERS)
    // ==========================================================================
    private registerRoutes(): void {
        // ─────────────────────────────────────────────
        // Core team operations (fixed paths first)
        // ─────────────────────────────────────────────
        this.router.post( "/create", this.h( this.ctrl.createTeam.bind( this.ctrl ) ) );

        this.router.get<TeamNameParams>(
            "/teamName/:teamName",
            this.h( this.ctrl.getTeamByTeamName.bind( this.ctrl ) )
        );

        this.router.get( "/all", this.h( this.ctrl.listTeams.bind( this.ctrl ) ) );
        // ⚠️ If your controller method names differ, map them 1:1:
        // e.g. getAll -> this.h(this.ctrl.getAll.bind(this.ctrl))

        // ─────────────────────────────────────────────
        // File upload only
        // ─────────────────────────────────────────────
        // If controller exposes upload middleware, mount it BEFORE handler.
        const anyCtrl = this.ctrl as unknown as {
            uploadMiddleware?: RequestHandler<TeamCodeParams>;
            uploadLogoMiddleware?: RequestHandler<TeamCodeParams>;
            uploadTeamLogo: ( req: Request<TeamCodeParams>, res: Response ) => Promise<void>;
        };

        const uploadMw =
            anyCtrl.uploadLogoMiddleware ?? anyCtrl.uploadMiddleware ?? undefined;

        if ( uploadMw ) {
            this.router.post<TeamCodeParams>(
                "/upload/logo/:teamCode",
                uploadMw,
                this.h( anyCtrl.uploadTeamLogo.bind( this.ctrl ) )
            );
        } else {
            this.router.post<TeamCodeParams>(
                "/upload/logo/:teamCode",
                this.h( this.ctrl.uploadTeamLogo.bind( this.ctrl ) as any )
            );
        }

        // ─────────────────────────────────────────────
        // Totals / Stats
        // ─────────────────────────────────────────────
        this.router.get(
            "/stats/teams-total",
            this.h( this.ctrl.getAllTeamTotals.bind( this.ctrl ) )
        );

        this.router.get<DomainParams>(
            "/stats/teams-total/domain/:domain",
            this.h( this.ctrl.getTeamTotalByDomain.bind( this.ctrl ) )
        );

        // ─────────────────────────────────────────────
        // User membership analytics (global)
        // ─────────────────────────────────────────────
        this.router.get(
            "/users/no-team",
            this.h( this.ctrl.usersWithoutAnyTeam.bind( this.ctrl ) )
        );

        this.router.get(
            "/users/no-team/count",
            this.h( this.ctrl.usersWithoutAnyTeamCount.bind( this.ctrl ) )
        );

        this.router.get(
            "/users/in-teams",
            this.h( this.ctrl.usersInAnyTeam.bind( this.ctrl ) )
        );

        this.router.get(
          "/users/in-teams/count",
          this.h( this.ctrl.usersInAnyTeamCount.bind( this.ctrl ) )
      );

        // ─────────────────────────────────────────────
        // User membership analytics (domain-specific)
        // ─────────────────────────────────────────────
        this.router.get<DomainParams>(
            "/users/no-team/domain/:domain",
            this.h( this.ctrl.usersWithoutTeamByDomain.bind( this.ctrl ) )
        );

        this.router.get<DomainParams>(
            "/users/no-team/domain/:domain/count",
            this.h( this.ctrl.usersWithoutTeamByDomainCount.bind( this.ctrl ) )
        );

        this.router.get<DomainParams>(
            "/users/in-teams/domain/:domain",
            this.h( this.ctrl.usersInTeamByDomain.bind( this.ctrl ) )
        );

        this.router.get<DomainParams>(
            "/users/in-teams/domain/:domain/count",
            this.h( this.ctrl.usersInTeamByDomainCount.bind( this.ctrl ) )
        );

        // ─────────────────────────────────────────────
        // All users + latest team/domain mapping
        // ─────────────────────────────────────────────
        this.router.get(
            "/users/all",
            this.h( this.ctrl.getAllUsersWithTeams.bind( this.ctrl ) )
        );

        // ─────────────────────────────────────────────
        // Mutations
        // ─────────────────────────────────────────────
        this.router.patch<TeamCodeParams>(
            "/update/:teamCode",
            this.h( this.ctrl.updateTeam.bind( this.ctrl ) )
        );

        this.router.delete<TeamCodeParams>(
            "/delete/:teamCode",
            this.h( this.ctrl.deleteTeam.bind( this.ctrl ) )
        );

        // ─────────────────────────────────────────────
        // ✅ CATCH-ALL MUST BE LAST
        // ─────────────────────────────────────────────
        this.router.get<TeamCodeParams>(
            "/:teamCode",
            this.h( this.ctrl.getTeamByCode.bind( this.ctrl ) )
        );
    }
}
