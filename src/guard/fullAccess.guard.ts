// src/middleware/guards.ts
import { NextFunction, Request, RequestHandler, Response } from "express";
import { Role } from "../types/roles";

import {
    ACCESS_OPTIONS,
    type AccessActionKey,
    type AccessModuleKey,
} from "../source/access-map.source";

import type { PermissionEntry } from "../models/user.model";
import type { GuardedRequest } from "../source/guard-routes-map.source";

/**
 * Guards
 * ------
 * - requireRole: simple role gate
 * - requireFullAccess: "admin + all permissions from ACCESS_OPTIONS"
 */
export default class Guards {
    private static readonly FULL_ACCESS_ROLE: Role = "admin";

    private static readonly REQUIRED_PERMISSION_MAP: ReadonlyMap<
        AccessModuleKey,
        ReadonlySet<AccessActionKey>
    > = Guards.buildRequiredPermissionMap();

    // ───────────────────────────────────────────────────────────────────────────
    // Simple role guard
    // ───────────────────────────────────────────────────────────────────────────
    public static requireRole( required: Role ): RequestHandler {
        return ( req: Request, res: Response, next: NextFunction ): void => {
            if ( req.method === "OPTIONS" ) {
                next();
                return;
            }

            const gReq = req as GuardedRequest;      // ← use GuardedRequest here
            const user = gReq.user;

            if ( user?.role === required ) {
                next();
                return;
            }

            res.status( 403 ).json( { status: "error", message: "Forbidden" } );
            return;
        };
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Full-access guard: admin + all permissions
    // ───────────────────────────────────────────────────────────────────────────
    public static requireFullAccess(): RequestHandler {
        return ( req: Request, res: Response, next: NextFunction ): void => {
            if ( req.method === "OPTIONS" ) {
                next();
                return;
            }

            // apiGuard already attached user as GuardedUser
            const gReq = req as GuardedRequest;
            const user = gReq.user;

            // 1) Must be admin
            if ( !user || user.role !== Guards.FULL_ACCESS_ROLE ) {
                res.status( 403 ).json( {
                    status: "error",
                    message: "Forbidden: admin role required for full access",
                } );
                return;
            }

            const permissions: PermissionEntry[] = Array.isArray( user.permissions )
                ? ( user.permissions as PermissionEntry[] )
                : [];

            // 2) Must have the full permission matrix
            const hasAll = Guards.hasAllPermissions( permissions );
            if ( !hasAll ) {
                res.status( 403 ).json( {
                    status: "error",
                    message: "Forbidden: full permission set required",
                } );
                return;
            }

            next();
            return;
        };
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Internal helpers (unchanged)
    // ───────────────────────────────────────────────────────────────────────────
    private static buildRequiredPermissionMap(): ReadonlyMap<
        AccessModuleKey,
        ReadonlySet<AccessActionKey>
    > {
        const map = new Map<AccessModuleKey, ReadonlySet<AccessActionKey>>();

        for ( const option of ACCESS_OPTIONS ) {
            const actionIds: AccessActionKey[] = option.actions.map(
                ( a ) => a.id as AccessActionKey
            );
            map.set( option.module, new Set<AccessActionKey>( actionIds ) );
        }

        return map;
    }

    private static hasAllPermissions( permissions: PermissionEntry[] ): boolean {
        const byModule = new Map<AccessModuleKey, Set<AccessActionKey>>();

        for ( const entry of permissions ) {
            const mod = entry.module;
            let set = byModule.get( mod );
            if ( !set ) {
                set = new Set<AccessActionKey>();
                byModule.set( mod, set );
            }
            for ( const act of entry.actions ) {
                set.add( act );
            }
        }

        for ( const [ module, requiredActions ] of Guards.REQUIRED_PERMISSION_MAP.entries() ) {
            const userSet = byModule.get( module );
            if ( !userSet ) {
                return false;
            }

            for ( const action of requiredActions ) {
                if ( !userSet.has( action ) ) {
                    return false;
                }
            }
        }

        return true;
    }
}
