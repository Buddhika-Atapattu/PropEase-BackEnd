// src/source/guard-routes-map.source.ts
import type { Request } from "express";
import type { PermissionEntry } from "../models/user.model";
import type { Role } from "../types/roles";
import {
    type AccessActionKey,
    type AccessModuleKey
} from "./access-map.source";


// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";

export interface GuardRouteDefinition {
    /** Internal id for logging / debugging (e.g. "user:create") */
    id: string;
    method: HttpMethod;
    pattern: RegExp;
    module: AccessModuleKey;
    action: AccessActionKey;
    description?: string;
}

export interface GuardedUser {
    username: string;
    role: Role;
    permissions?: PermissionEntry[];
}

export type GuardedRequest = Request & { user?: GuardedUser; };

// ─────────────────────────────────────────────────────────────────────────────
// Global Express.Request augmentation
//   - Makes req.user (GuardedUser | undefined) available everywhere
//   - Safe: only adds an optional property, does not break existing code
// ─────────────────────────────────────────────────────────────────────────────
declare global {
    namespace Express {
        interface Request {
            /** Authenticated user injected by apiGuard (if any) */
            user?: GuardedUser;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public endpoints (bypass guard)
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicEndpoint {
    method: HttpMethod;
    pattern: RegExp;
    reason: string;
}

/**
 * Endpoints that do NOT require tokens or permission checks.
 * Keep this list small and very explicit.
 */
export const PUBLIC_ENDPOINTS: ReadonlyArray<PublicEndpoint> = [
    // Auth controller (if mounted as /api-auth)
    {
        method: "POST",
        pattern: /^\/api\/auth\/login$/,
        reason: "AuthController login",
    },
    {
        method: "POST",
        pattern: /^\/api\/auth\/logout$/,
        reason:
            "AuthController logout (should still be callable even with broken cookies)",
    },
    {
        method: "POST",
        pattern: /^\/api\/auth\/regenerate-challenge$/,
        reason:
            "Regenerate the login challenge",
    },

    // /ws-token/rotate/:username
    {
        method: "POST",
        pattern: /^\/api\/auth\/ws-token\/rotate\/[^/]+$/,
        reason:
            "Regenerate the login challenge",
    },

    // MFA
    {
        method: "POST",
        pattern: /^\/api\/mfa\/initiate$/,
        reason: "MFA initiate (before session/guard enforcement)",
    },
    {
        method: "POST",
        pattern: /^\/api\/mfa\/confirm$/,
        reason: "MFA confirm (foreign app → backend)",
    },
    {
        method: "POST",
        pattern: /^\/api\/mfa\/activate$/,
        reason: "MFA confirm (alias)",
    },
    {
        method: "POST",
        pattern: /^\/api\/mfa\/initial-verify$/,
        reason: "MFA initial verify",
    },
    {
        method: "POST",
        pattern: /^\/api\/mfa\/user-verify$/,
        reason: "MFA user verify",
    },
    // /status/:pairingToken
    {
        method: "GET",
        pattern: /^\/api\/mfa\/status\/[^/]+$/,
        reason: "MFA status (alias)",
    },
    {
        method: "POST",
        pattern: /^\/api\/mfa\/deactive\/[^/]+$/,
        reason: "MFA deactive",
    },

    // Email validator
    {
        method: "GET",
        pattern: /^\/api-validator\/email-validator\/.+$/,
        reason: "Public email validation",
    },

    // Security incident reporting
    {
        method: "POST",
        pattern: /^\/api-report\/security$/,
        reason: "Security incident reporting from FE",
    },
];

export const GUARD_ROUTES: ReadonlyArray<GuardRouteDefinition> = [
    // =========================================================================
    // USER MANAGEMENT (/api-user)
    // =========================================================================

    // GET /api-user/users
    {
        id: "user:list-all",
        method: "GET",
        pattern: /^\/api-user\/users$/,
        module: "UserManagement",
        action: "view",
        description: "List all users",
    },

    // GET /api-user/users-count
    {
        id: "user:count-all",
        method: "GET",
        pattern: /^\/api-user\/users-count$/,
        module: "UserManagement",
        action: "view",
        description: "Get total user count",
    },

    // GET /api-user/users-with-pagination/:start/:limit
    {
        id: "user:list-paginated",
        method: "GET",
        pattern: /^\/api-user\/users-with-pagination\/\d+\/\d+$/,
        module: "UserManagement",
        action: "view",
        description: "List users with pagination",
    },

    // POST /api-user/create-user
    {
        id: "user:create",
        method: "POST",
        pattern: /^\/api-user\/create-user$/,
        module: "UserManagement",
        action: "create",
        description: "Create user",
    },

    // PUT /api-user/user-update/:username
    {
        id: "user:update",
        method: "PUT",
        pattern: /^\/api-user\/user-update\/[^/]+$/,
        module: "UserManagement",
        action: "update",
        description: "Update user by username",
    },

    // DELETE /api-user/user-delete/:username/:deletedBy
    {
        id: "user:delete",
        method: "DELETE",
        pattern: /^\/api-user\/user-delete\/[^/]+\/[^/]+$/,
        module: "UserManagement",
        action: "delete",
        description: "Delete user by username",
    },

    // POST /api-user/user-document-upload/:username
    {
        id: "user:documents-upload",
        method: "POST",
        pattern: /^\/api-user\/user-document-upload\/[^/]+$/,
        module: "UserManagement",
        action: "update",
        description: "Upload documents for a user",
    },

    // GET /api-user/uploads/:username/documents
    {
        id: "user:documents-list",
        method: "GET",
        pattern: /^\/api-user\/uploads\/[^/]+\/documents$/,
        module: "UserManagement",
        action: "view",
        description: "List uploaded documents for a user",
    },

    // GET /api-user/user-username/:username
    {
        id: "user:get-by-username",
        method: "GET",
        pattern: /^\/api-user\/user-username\/[^/]+$/,
        module: "UserManagement",
        action: "view",
        description: "Get user by username",
    },

    // GET /api-user/user-email/:email
    {
        id: "user:get-by-email",
        method: "GET",
        pattern: /^\/api-user\/user-email\/[^/]+$/,
        module: "UserManagement",
        action: "view",
        description: "Get user by email",
    },

    // POST /api-user/user-phone/:phone
    {
        id: "user:get-by-phone",
        method: "POST",
        pattern: /^\/api-user\/user-phone$/,
        module: "UserManagement",
        action: "view",
        description: "Get user by phone number",
    },

    // GET /api-user/emailverifycation/:token
    {
        id: "user:email-verification",
        method: "GET",
        pattern: /^\/api-user\/emailverifycation\/[^/]+$/,
        module: "UserManagement",
        action: "update",
        description: "Verify user email by token",
    },

    // POST /api-user/generate-token
    {
        id: "user:generate-token",
        method: "POST",
        pattern: /^\/api-user\/generate-token$/,
        module: "UserManagement",
        action: "update",
        description: "Generate verification/reset token for a user",
    },

    // GET /api-user/user-token/:token
    {
        id: "user:get-by-token",
        method: "GET",
        pattern: /^\/api-user\/user-token\/[^/]+$/,
        module: "UserManagement",
        action: "view",
        description: "Get user by verification token",
    },

    // GET /api-user/user-data/:username
    {
        id: "user:get-user-data",
        method: "GET",
        pattern: /^\/api-user\/user-data\/[^/]+$/,
        module: "UserManagement",
        action: "view",
        description: "Get rich user data by username",
    },

    // GET /api-user/user-section-key/:username/:key
    {
        id: "user:get-section-key",
        method: "GET",
        pattern: /^\/api-user\/user-section-key\/[^/]+\/[^/]+$/,
        module: "UserManagement",
        action: "view",
        description: "Get specific user section by key",
    },

    // (LOGIN / VERIFY routes like POST /api-user/verify-user are public and handled in PUBLIC_ENDPOINTS)

    // =========================================================================
    // NOTIFICATION CENTER (/api-notification)
    // =========================================================================

    // POST /api-notification/create
    {
        id: "notification:create",
        method: "POST",
        pattern: /^\/api-notification\/create$/,
        module: "NotificationCenter",
        action: "create",
        description: "Create notification",
    },

    // POST /api-notification/:id/read
    {
        id: "notification:mark-read",
        method: "POST",
        pattern: /^\/api-notification\/[^/]+\/read$/,
        module: "NotificationCenter",
        action: "update",
        description: "Mark notification as read",
    },

    // POST /api-notification/read-many
    {
        id: "notification:mark-read-many",
        method: "POST",
        pattern: /^\/api-notification\/read-many$/,
        module: "NotificationCenter",
        action: "update",
        description: "Bulk mark notifications as read",
    },

    // POST /api-notification/read-all
    {
        id: "notification:mark-read-all",
        method: "POST",
        pattern: /^\/api-notification\/read-all$/,
        module: "NotificationCenter",
        action: "update",
        description: "Mark all notifications as read",
    },

    // POST /api-notification/restore
    {
        id: "notification:restore",
        method: "POST",
        pattern: /^\/api-notification\/restore$/,
        module: "NotificationCenter",
        action: "restore",
        description: "Restore items via notification (domain restore)",
    },

    // POST /api-notification/permanent-delete
    {
        id: "notification:permanent-delete",
        method: "POST",
        pattern: /^\/api-notification\/permanent-delete$/,
        module: "NotificationCenter",
        action: "permanentDelete",
        description: "Permanent delete via notification (domain hard-delete)",
    },

    // GET /api-notification?limit=...
    {
        id: "notification:list-mine",
        method: "GET",
        pattern: /^\/api-notification\/?$/,
        module: "NotificationCenter",
        action: "view",
        description: "List current user's notifications",
    },

    // =========================================================================
    // TRACKING & AUDIT (/api-tracking)
    // =========================================================================

    // POST /api-tracking/track-logged-user-login
    {
        id: "tracking:track-login",
        method: "POST",
        pattern: /^\/api-tracking\/track-logged-user-login$/,
        module: "TrackingAndAudit",
        action: "create",
        description: "Track a login event for the logged-in user",
    },

    // GET /api-tracking/get-logged-user-tracking-count/:username
    {
        id: "tracking:user-login-count",
        method: "GET",
        pattern: /^\/api-tracking\/get-logged-user-tracking-count\/[^/]+$/,
        module: "TrackingAndAudit",
        action: "view",
        description: "Get total login count for a user",
    },

    // GET /api-tracking/get-logged-user-tracking/:username
    {
        id: "tracking:user-login-tracking",
        method: "GET",
        pattern: /^\/api-tracking\/get-logged-user-tracking\/[^/]+$/,
        module: "TrackingAndAudit",
        action: "view",
        description: "Get paged login tracking for a user",
    },

    // GET /api-tracking/get-all-users-login-counts
    {
        id: "tracking:all-users-login-counts",
        method: "GET",
        pattern: /^\/api-tracking\/get-all-users-login-counts$/,
        module: "TrackingAndAudit",
        action: "view",
        description: "Get login counts for all users (date range via query)",
    },

    // GET /api-tracking/user-file-management-activity/:username/:start/:limit
    {
        id: "tracking:file-activity",
        method: "GET",
        pattern: /^\/api-tracking\/user-file-management-activity\/[^/]+\/\d+\/\d+$/,
        module: "TrackingAndAudit",
        action: "view",
        description: "Get user file management activity",
    },

    // POST /api-tracking/track-activity
    {
        id: "tracking:track-activity",
        method: "POST",
        pattern: /^\/api-tracking\/track-activity$/,
        module: "TrackingAndAudit",
        action: "create",
        description: "Track generic activity event",
    },

    // GET /api-tracking/activities/:username/:start/:limit
    {
        id: "tracking:activities-by-user",
        method: "GET",
        pattern: /^\/api-tracking\/activities\/[^/]+\/\d+\/\d+$/,
        module: "TrackingAndAudit",
        action: "view",
        description: "Get tracked activities for a user (paged)",
    },

    // GET /api-tracking/get-total-of-created-users-based-on-creator/:username
    {
        id: "tracking:created-users-total-by-creator",
        method: "GET",
        pattern: /^\/api-tracking\/get-total-of-created-users-based-on-creator\/[^/]+$/,
        module: "TrackingAndAudit",
        action: "view",
        description: "Get total number of users created by a given creator",
    },

    // GET /api-tracking/get-created-users-based-on-creator/:username
    {
        id: "tracking:created-users-by-creator",
        method: "GET",
        pattern: /^\/api-tracking\/get-created-users-based-on-creator\/[^/]+$/,
        module: "TrackingAndAudit",
        action: "view",
        description: "Get users created by a given creator (paged via query)",
    },

    // GET /api-tracking/recent
    {
        id: "tracking:recent-feed",
        method: "GET",
        pattern: /^\/api-tracking\/recent$/,
        module: "TrackingAndAudit",
        action: "view",
        description: "Recent activity feed",
    },

    // =========================================================================
    // FILE TRANSFER (/api-file-transfer)
    // =========================================================================

    // POST /api-file-transfer/get-tenant-mobile-file-upload/:token
    {
        id: "file-transfer:tenant-mobile-upload",
        method: "POST",
        pattern: /^\/api-file-transfer\/get-tenant-mobile-file-upload\/[^/]+$/,
        module: "FileManagement",
        action: "create",
        description: "Receive file uploads from tenant mobile app by token",
    },

    // GET /api-file-transfer/get-reason-file-uploads-by-tenant-username/:tenant
    {
        id: "file-transfer:get-by-tenant-reason",
        method: "GET",
        pattern: /^\/api-file-transfer\/get-reason-file-uploads-by-tenant-username\/[^/]+$/,
        module: "FileManagement",
        action: "view",
        description: "Get file uploads grouped by reason for a tenant username",
    },

    // POST /api-file-transfer/convert-to-pdf
    {
        id: "file-transfer:convert-to-pdf",
        method: "POST",
        pattern: /^\/api-file-transfer\/convert-to-pdf$/,
        module: "FileManagement",
        action: "create",
        description: "Convert uploaded file(s) to PDF",
    },

    // =========================================================================
    // LEASE MANAGEMENT (/api-lease)
    // =========================================================================

    // POST /api-lease/register/:leaseID
    {
        id: "lease:register",
        method: "POST",
        pattern: /^\/api-lease\/register\/[^/]+$/,
        module: "LeaseManagement",
        action: "create",
        description: "Register a new lease for a property",
    },

    // PUT /api-lease/update-lease-agreement/:leaseID
    {
        id: "lease:update-agreement",
        method: "PUT",
        pattern: /^\/api-lease\/update-lease-agreement\/[^/]+$/,
        module: "LeaseManagement",
        action: "renew", // or "update" based on your AccessActionKey
        description: "Update / renew lease agreement by leaseID",
    },

    // GET /api-lease/preview-lease-agreement/:leaseID
    {
        id: "lease:preview-agreement",
        method: "GET",
        pattern: /^\/api-lease\/preview-lease-agreement\/[^/]+$/,
        module: "LeaseManagement",
        action: "view",
        description: "Preview lease agreement by leaseID",
    },

    // GET /api-lease/lease-agreement-pdf/:leaseID/:type/:generator
    {
        id: "lease:agreement-pdf",
        method: "GET",
        pattern: /^\/api-lease\/lease-agreement-pdf\/[^/]+\/[^/]+\/[^/]+$/,
        module: "LeaseManagement",
        action: "view",
        description: "Generate/download lease agreement PDF (leaseID + type + generator)",
    },

    // GET /api-lease/lease-agreement/:leaseID
    {
        id: "lease:view-agreement",
        method: "GET",
        pattern: /^\/api-lease\/lease-agreement\/[^/]+$/,
        module: "LeaseManagement",
        action: "view",
        description: "View a single lease agreement by leaseID",
    },

    // GET /api-lease/lease-agreements/:username
    {
        id: "lease:list-by-user",
        method: "GET",
        pattern: /^\/api-lease\/lease-agreements\/[^/]+$/,
        module: "LeaseManagement",
        action: "view",
        description: "List lease agreements for a given username",
    },

    // PUT /api-lease/lease-status-updated/:leaseID
    {
        id: "lease:update-status",
        method: "PUT",
        pattern: /^\/api-lease\/lease-status-updated\/[^/]+$/,
        module: "LeaseManagement",
        action: "update",
        description: "Update status of a lease (active/expired/etc.)",
    },

    // GET /api-lease/all-leases
    {
        id: "lease:list-all",
        method: "GET",
        pattern: /^\/api-lease\/all-leases$/,
        module: "LeaseManagement",
        action: "view",
        description: "List all leases (supports query params for filters/paging)",
    },

    // GET /api-lease/get-lease-count
    {
        id: "lease:count-all",
        method: "GET",
        pattern: /^\/api-lease\/get-lease-count$/,
        module: "LeaseManagement",
        action: "view",
        description: "Get total lease count (filters via query)",
    },

    // GET /api-lease/get-properties-that-does-not-have-lease
    {
        id: "lease:properties-without-lease",
        method: "GET",
        pattern: /^\/api-lease\/get-properties-that-does-not-have-lease$/,
        module: "PropertyManagement",
        action: "view",
        description: "Get properties that currently do not have any lease",
    },

    // GET /api-lease/get-all-properties-count-without-leases
    {
        id: "lease:properties-without-lease-count",
        method: "GET",
        pattern: /^\/api-lease\/get-all-properties-count-without-leases$/,
        module: "PropertyManagement",
        action: "view",
        description: "Get total count of properties without leases",
    },

    // GET /api-lease/get-tenant-by-username/:username
    {
        id: "lease:get-tenant-by-username",
        method: "GET",
        pattern: /^\/api-lease\/get-tenant-by-username\/[^/]+$/,
        module: "UserManagement",
        action: "view",
        description: "Get tenant basic data by username (used by lease module)",
    },

    // =========================================================================
    // PAYMENTS (/api-payments)
    // =========================================================================

    // GET /api-payments/dashboard/summary
    {
        id: "payments:dashboard-summary",
        method: "GET",
        pattern: /^\/api-payments\/dashboard\/summary$/,
        module: "PaymentBilling",
        action: "view",
        description: "Payments dashboard summary",
    },

    // =========================================================================
    // PLACES / MAPS (/api-places)
    // =========================================================================

    // GET /api-places/autocomplete?query=...
    {
        id: "places:autocomplete",
        method: "GET",
        pattern: /^\/api-places\/autocomplete$/,
        module: "PlacesAndMaps",
        action: "view",
        description: "Places autocomplete for address/location search",
    },

    // =========================================================================
    // PROPERTY MANAGEMENT (/api-property)
    // =========================================================================

    // POST /api-property/insert-property/:propertyID
    {
        id: "property:create",
        method: "POST",
        pattern: /^\/api-property\/insert-property\/[^/]+$/,
        module: "PropertyManagement",
        action: "create",
        description: "Create/insert new property by ID",
    },

    // GET /api-property/get-all-properties-with-pagination/:start/:end/
    {
        id: "property:list-paginated",
        method: "GET",
        pattern: /^\/api-property\/get-all-properties-with-pagination\/\d+\/\d+\/?$/,
        module: "PropertyManagement",
        action: "view",
        description: "List properties with pagination",
    },

    // GET /api-property/get-single-property-by-id/:id
    {
        id: "property:get-by-id",
        method: "GET",
        pattern: /^\/api-property\/get-single-property-by-id\/[^/]+$/,
        module: "PropertyManagement",
        action: "view",
        description: "Get single property by ID",
    },

    // GET /api-property/get-single-property-section-by-id/:id
    {
        id: "property:get-section-by-id",
        method: "GET",
        pattern: /^\/api-property\/get-single-property-section-by-id\/[^/]+$/,
        module: "PropertyManagement",
        action: "view",
        description: "Get specific section of a property by ID",
    },

    // DELETE /api-property/delete-property/:id/:username
    {
        id: "property:delete",
        method: "DELETE",
        pattern: /^\/api-property\/delete-property\/[^/]+\/[^/]+$/,
        module: "PropertyManagement",
        action: "delete",
        description: "Delete property by ID and track deleting user",
    },

    // PUT /api-property/update-property/:id
    {
        id: "property:update",
        method: "PUT",
        pattern: /^\/api-property\/update-property\/[^/]+$/,
        module: "PropertyManagement",
        action: "update",
        description: "Update property by ID",
    },

    // GET /api-property/get-all-properties/
    {
        id: "property:list-all",
        method: "GET",
        pattern: /^\/api-property\/get-all-properties\/?$/,
        module: "PropertyManagement",
        action: "view",
        description: "List all properties",
    },

    // GET /api-property/get-all-properties-count/
    {
        id: "property:count-all",
        method: "GET",
        pattern: /^\/api-property\/get-all-properties-count\/?$/,
        module: "PropertyManagement",
        action: "view",
        description: "Get total property count",
    },

    // GET /api-property/dashboard/portfolio-summary
    {
        id: "property:dashboard-portfolio-summary",
        method: "GET",
        pattern: /^\/api-property\/dashboard\/portfolio-summary$/,
        module: "PropertyManagement",
        action: "view",
        description: "Property dashboard: portfolio summary",
    },

    // GET /api-property/dashboard/country-distribution
    {
        id: "property:dashboard-country-distribution",
        method: "GET",
        pattern: /^\/api-property\/dashboard\/country-distribution$/,
        module: "PropertyManagement",
        action: "view",
        description: "Property dashboard: country distribution",
    },

    // GET /api-property/dashboard/maintenance-summary
    {
        id: "property:dashboard-maintenance-summary",
        method: "GET",
        pattern: /^\/api-property\/dashboard\/maintenance-summary$/,
        module: "PropertyManagement",
        action: "view",
        description: "Property dashboard: maintenance summary",
    },

    // GET /api-property/dashboard/property-trends
    {
        id: "property:dashboard-property-trends",
        method: "GET",
        pattern: /^\/api-property\/dashboard\/property-trends$/,
        module: "PropertyManagement",
        action: "view",
        description: "Property dashboard: trends over time",
    },

    // GET /api-property/dashboard/status-counts
    {
        id: "property:dashboard-status-counts",
        method: "GET",
        pattern: /^\/api-property\/dashboard\/status-counts$/,
        module: "PropertyManagement",
        action: "view",
        description: "Property dashboard: status counts",
    },

    // GET /api-property/dashboard/top-cities
    {
        id: "property:dashboard-top-cities",
        method: "GET",
        pattern: /^\/api-property\/dashboard\/top-cities$/,
        module: "PropertyManagement",
        action: "view",
        description: "Property dashboard: top cities by metrics",
    },

    // GET /api-property/dashboard/price-histogram
    {
        id: "property:dashboard-price-histogram",
        method: "GET",
        pattern: /^\/api-property\/dashboard\/price-histogram$/,
        module: "PropertyManagement",
        action: "view",
        description: "Property dashboard: price histogram",
    },

    // =========================================================================
    // TEAM MANAGEMENT (/api-team-management)
    // =========================================================================

    // POST /api-team-management/create
    {
        id: "team:create",
        method: "POST",
        pattern: /^\/api-team-management\/create$/,
        module: "TeamManagement",
        action: "create",
        description: "Create a team",
    },

    // GET /api-team-management/teamName/:teamName
    {
        id: "team:get-team-by-name",
        method: "GET",
        pattern: /^\/api-team-management\/teamName\/[^/]+$/,
        module: "TeamManagement",
        action: "view",
        description: "Get team by team name",
    },

    // GET /api-team-management/all
    {
        id: "team:list-all",
        method: "GET",
        pattern: /^\/api-team-management\/all$/,
        module: "TeamManagement",
        action: "view",
        description: "List all teams",
    },

    // GET /api-team-management/:teamId
    {
        id: "team:get-team-by-id",
        method: "GET",
        pattern: /^\/api-team-management\/[^/]+$/,
        module: "TeamManagement",
        action: "view",
        description: "Get team details by ID",
    },

    // PATCH /api-team-management/update/:teamId
    {
        id: "team:update",
        method: "PATCH",
        pattern: /^\/api-team-management\/update\/[^/]+$/,
        module: "TeamManagement",
        action: "update",
        description: "Update team details by ID",
    },

    // POST /api-team-management/assign-task/:teamId
    {
        id: "team:assign-task",
        method: "POST",
        pattern: /^\/api-team-management\/assign-task\/[^/]+$/,
        module: "TeamManagement",
        action: "update",
        description: "Assign task to a team",
    },

    // POST /api-team-management/evidence/attach/:teamId/:taskId
    {
        id: "team:attach-evidence",
        method: "POST",
        pattern: /^\/api-team-management\/evidence\/attach\/[^/]+\/[^/]+$/,
        module: "TeamManagement",
        action: "update",
        description: "Attach evidence to a team task",
    },

    // DELETE /api-team-management/delete/:teamId
    {
        id: "team:delete",
        method: "DELETE",
        pattern: /^\/api-team-management\/delete\/[^/]+$/,
        module: "TeamManagement",
        action: "delete",
        description: "Delete a team by ID",
    },

    // POST /api-team-management/upload/logo/:teamId
    {
        id: "team:upload-logo",
        method: "POST",
        pattern: /^\/api-team-management\/upload\/logo\/[^/]+$/,
        module: "TeamManagement",
        action: "update",
        description: "Upload team logo",
    },

    // POST /api-team-management/upload/evidence/:teamId/:taskId
    {
        id: "team:upload-evidence",
        method: "POST",
        pattern: /^\/api-team-management\/upload\/evidence\/[^/]+\/[^/]+$/,
        module: "TeamManagement",
        action: "update",
        description: "Upload evidence file for a team task",
    },

    // GET /api-team-management/stats/teams-total
    {
        id: "team:stats-teams-total",
        method: "GET",
        pattern: /^\/api-team-management\/stats\/teams-total$/,
        module: "TeamManagement",
        action: "view",
        description: "Get total number of teams",
    },

    // GET /api-team-management/stats/teams-total/domain/:domain
    {
        id: "team:stats-teams-total-by-domain",
        method: "GET",
        pattern: /^\/api-team-management\/stats\/teams-total\/domain\/[^/]+$/,
        module: "TeamManagement",
        action: "view",
        description: "Get total number of teams for a given domain",
    },

    // GET /api-team-management/users/no-team
    {
        id: "team:users-no-team",
        method: "GET",
        pattern: /^\/api-team-management\/users\/no-team$/,
        module: "TeamManagement",
        action: "view",
        description: "List users without any team",
    },

    // GET /api-team-management/users/no-team/count
    {
        id: "team:users-no-team-count",
        method: "GET",
        pattern: /^\/api-team-management\/users\/no-team\/count$/,
        module: "TeamManagement",
        action: "view",
        description: "Get count of users without any team",
    },

    // GET /api-team-management/users/in-teams
    {
        id: "team:users-in-teams",
        method: "GET",
        pattern: /^\/api-team-management\/users\/in-teams$/,
        module: "TeamManagement",
        action: "view",
        description: "List users who are in teams",
    },

    // GET /api-team-management/users/in-teams/count
    {
        id: "team:users-in-teams-count",
        method: "GET",
        pattern: /^\/api-team-management\/users\/in-teams\/count$/,
        module: "TeamManagement",
        action: "view",
        description: "Get count of users who are in teams",
    },

    // GET /api-team-management/users/no-team/domain/:domain
    {
        id: "team:users-no-team-domain",
        method: "GET",
        pattern: /^\/api-team-management\/users\/no-team\/domain\/[^/]+$/,
        module: "TeamManagement",
        action: "view",
        description: "List users without team in a specific domain",
    },

    // GET /api-team-management/users/no-team/domain/:domain/count
    {
        id: "team:users-no-team-domain-count",
        method: "GET",
        pattern: /^\/api-team-management\/users\/no-team\/domain\/[^/]+\/count$/,
        module: "TeamManagement",
        action: "view",
        description: "Get count of users without team in a specific domain",
    },

    // GET /api-team-management/users/in-teams/domain/:domain
    {
        id: "team:users-in-teams-domain",
        method: "GET",
        pattern: /^\/api-team-management\/users\/in-teams\/domain\/[^/]+$/,
        module: "TeamManagement",
        action: "view",
        description: "List users in teams for a specific domain",
    },

    // GET /api-team-management/users/in-teams/domain/:domain/count
    {
        id: "team:users-in-teams-domain-count",
        method: "GET",
        pattern: /^\/api-team-management\/users\/in-teams\/domain\/[^/]+\/count$/,
        module: "TeamManagement",
        action: "view",
        description: "Get count of users in teams for a specific domain",
    },

    // GET /api-team-management/users/all?index=&limit=&search=
    {
        id: "team:users-with-team",
        method: "GET",
        pattern: /^\/api-team-management\/users\/all\/?$/,
        module: "TeamManagement",
        action: "view",
        description: "List all users with their team membership (paged via query)",
    },

    // GET /api-team-management/task/:taskId/
    {
        id: "team:get-all-team-tasks",
        method: "GET",
        pattern: /^\/api-team-management\/task\/get-tasks\/[^/]+\/?$/,
        module: "TeamManagement",
        action: "view",
        description: "Get all tasks for a given team task ID",
    },

    // =========================================================================
    // WORK EVENTS (/api-work-event)
    // =========================================================================

    // GET /api-work-event/all
    {
        id: "work-event:list-all",
        method: "GET",
        pattern: /^\/api-work-event\/all\/?$/,
        module: "TeamManagement",
        action: "view",
        description: "List all work events (filters via query: workItemId, teamId, domain, etc.)",
    },

    // GET /api-work-event/by-workitem/:workItemId
    {
        id: "work-event:list-by-workitem",
        method: "GET",
        pattern: /^\/api-work-event\/by-workitem\/[^/]+$/,
        module: "TeamManagement",
        action: "view",
        description: "List work events for a given work item",
    },

    // GET /api-work-event/by-team/:teamId
    {
        id: "work-event:list-by-team",
        method: "GET",
        pattern: /^\/api-work-event\/by-team\/[^/]+$/,
        module: "TeamManagement",
        action: "view",
        description: "List work events for all work items under a team",
    },

    // GET /api-work-event/stats/workitem/:workItemId
    {
        id: "work-event:stats-by-workitem",
        method: "GET",
        pattern: /^\/api-work-event\/stats\/workitem\/[^/]+$/,
        module: "TeamManagement",
        action: "view",
        description: "Get aggregated stats of events for a given work item",
    },


    // =========================================================================
    // TENANT & COMPLAINTS (/api-tenant)
    // =========================================================================

    // POST /api-tenant/insertTenant
    {
        id: "tenant:create",
        method: "POST",
        pattern: /^\/api-tenant\/insertTenant$/,
        module: "TenantManagement",
        action: "create",
        description: "Create/insert a new tenant",
    },

    // GET /api-tenant/get-all-tenants
    {
        id: "tenant:list-all",
        method: "GET",
        pattern: /^\/api-tenant\/get-all-tenants$/,
        module: "TenantManagement",
        action: "view",
        description: "List all tenants",
    },

    // GET /api-tenant/get-all-tenants-count
    {
        id: "tenant:count-all",
        method: "GET",
        pattern: /^\/api-tenant\/get-all-tenants-count$/,
        module: "TenantManagement",
        action: "view",
        description: "Get total tenant count",
    },

    // GET /api-tenant/get-all-tenants-with-pagination
    {
        id: "tenant:list-all-paginated",
        method: "GET",
        pattern: /^\/api-tenant\/get-all-tenants-with-pagination$/,
        module: "TenantManagement",
        action: "view",
        description: "List tenants with pagination (via query params)",
    },

    // GET /api-tenant/get-all-none-tenants-with-pagination
    {
        id: "tenant:list-none-tenants-paginated",
        method: "GET",
        pattern: /^\/api-tenant\/get-all-none-tenants-with-pagination$/,
        module: "TenantManagement",
        action: "view",
        description: "List users with no tenant mapping (paged via query)",
    },

    // GET /api-tenant/get-all-none-tenants-count
    {
        id: "tenant:count-none-tenants",
        method: "GET",
        pattern: /^\/api-tenant\/get-all-none-tenants-count$/,
        module: "TenantManagement",
        action: "view",
        description: "Get count of users with no tenant mapping",
    },

    // DELETE /api-tenant/delete-tenant/:username/:deletor
    {
        id: "tenant:delete",
        method: "DELETE",
        pattern: /^\/api-tenant\/delete-tenant\/[^/]+\/[^/]+$/,
        module: "TenantManagement",
        action: "delete",
        description: "Delete tenant by username",
    },

    // POST /api-tenant/create-complaint
    {
        id: "complaint:create",
        method: "POST",
        pattern: /^\/api-tenant\/create-complaint$/,
        module: "TenantManagement",
        action: "create",
        description: "Create a complaint",
    },

    // GET /api-tenant/complaint/:complaintID
    {
        id: "complaint:get-by-id",
        method: "GET",
        pattern: /^\/api-tenant\/complaint\/[^/]+$/,
        module: "TenantManagement",
        action: "view",
        description: "Get complaint by ID",
    },

    // GET /api-tenant/complaints/tenant/:username
    {
        id: "complaint:list-by-tenant",
        method: "GET",
        pattern: /^\/api-tenant\/complaints\/tenant\/[^/]+$/,
        module: "TenantManagement",
        action: "view",
        description: "List complaints for a particular tenant",
    },

    // GET /api-tenant/complaints-count/tenant/:username
    {
        id: "complaint:count-by-tenant",
        method: "GET",
        pattern: /^\/api-tenant\/complaints-count\/tenant\/[^/]+$/,
        module: "TenantManagement",
        action: "view",
        description: "Get complaint count for a tenant",
    },

    // GET /api-tenant/complaints/all
    {
        id: "complaint:list-all",
        method: "GET",
        pattern: /^\/api-tenant\/complaints\/all$/,
        module: "TenantManagement",
        action: "view",
        description: "List all complaints",
    },

    // GET /api-tenant/complaints-count/all
    {
        id: "complaint:count-all",
        method: "GET",
        pattern: /^\/api-tenant\/complaints-count\/all$/,
        module: "TenantManagement",
        action: "view",
        description: "Get total complaint count",
    },

    // GET /api-tenant/complaints-by-section/all/:section
    {
        id: "complaint:list-by-section",
        method: "GET",
        pattern: /^\/api-tenant\/complaints-by-section\/all\/[^/]+$/,
        module: "TenantManagement",
        action: "view",
        description: "List complaints grouped by section",
    },

    // POST /api-tenant/complaints/post-comments
    {
        id: "complaint:post-comments",
        method: "POST",
        pattern: /^\/api-tenant\/complaints\/post-comments$/,
        module: "TenantManagement",
        action: "update",
        description: "Add or update complaint comments",
    },

    // GET /api-tenant/complaints/:code/comments
    {
        id: "complaint:list-comments-by-code",
        method: "GET",
        pattern: /^\/api-tenant\/complaints\/[^/]+\/comments$/,
        module: "TenantManagement",
        action: "view",
        description: "Get comments for a complaint by complaint code",
    },

    // =========================================================================
    // KPI MANAGEMENT (/api-kpis)
    // =========================================================================

    // POST /api-kpis/facts/deals
    {
        id: "kpi:deal-fact",
        method: "POST",
        pattern: /^\/api-kpis\/facts\/deals$/,
        module: "KpiManagement",
        action: "create",
        description: "Submit deal fact",
    },

    // POST /api-kpis/facts/satisfaction
    {
        id: "kpi:satisfaction-fact",
        method: "POST",
        pattern: /^\/api-kpis\/facts\/satisfaction$/,
        module: "KpiManagement",
        action: "create",
        description: "Submit satisfaction fact",
    },

    // POST /api-kpis/facts/maintenance/events
    {
        id: "kpi:maintenance-event",
        method: "POST",
        pattern: /^\/api-kpis\/facts\/maintenance\/events$/,
        module: "KpiManagement",
        action: "create",
        description: "Submit maintenance event",
    },

    // POST /api-kpis/facts/team/tasks
    {
        id: "kpi:team-task-fact",
        method: "POST",
        pattern: /^\/api-kpis\/facts\/team\/tasks$/,
        module: "KpiManagement",
        action: "create",
        description: "Submit team task fact",
    },

    // POST /api-kpis/facts/team/task-evidence
    {
        id: "kpi:team-task-evidence",
        method: "POST",
        pattern: /^\/api-kpis\/facts\/team\/task-evidence$/,
        module: "KpiManagement",
        action: "create",
        description: "Submit team task evidence",
    },

    // POST /api-kpis/facts/team/task-events
    {
        id: "kpi:team-task-event",
        method: "POST",
        pattern: /^\/api-kpis\/facts\/team\/task-events$/,
        module: "KpiManagement",
        action: "create",
        description: "Submit team task event",
    },

    // GET /api-kpis/realtime/health
    {
        id: "kpi:realtime-health",
        method: "GET",
        pattern: /^\/api-kpis\/realtime\/health$/,
        module: "KpiManagement",
        action: "view",
        description: "Realtime KPI health",
    },

    // =====================================================================
    // NOTE:
    //  - Validator (/api-validator/email-validator/:email) and uploads
    //    (/api/uploads/richtext) are intentionally public and handled via
    //    PUBLIC_ENDPOINTS, so they are not added here.
    //  - Auth (/api/auth/...) and MFA (/api/mfa/...) also have their own
    //    logic/public endpoints.
    // =====================================================================
];

/**
 * Make this file a module so the `declare global` block is applied correctly
 * under moduleResolution: "NodeNext".
 */
export {};
