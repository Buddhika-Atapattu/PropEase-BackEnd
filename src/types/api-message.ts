// Path: src/types/api-message.ts
// ============================================================================
// API Message Types (Backend → Frontend contract)
// ----------------------------------------------------------------------------
// Design goals:
//  - One consistent ApiResponse shape for every endpoint
//  - Strong typing for domain payloads (SystemData)
//  - Optional "other" payload without using `any`
//  - Pagination/validation are consistent across modules
//  - Avoid leaking Mongoose Document types into API layer
// ============================================================================

import type { IComplaint } from "../models/complaint.model";
import type { UserDocumentEntity } from "../models/file-upload.model";
import type { LeasePayload, LeasePayloadWithProperty } from "../models/lease.model";
import type { IProperty } from "../models/property.model";
import type { ITenant } from "../models/tenant.model";
import type { User } from "../models/user.model";

// IMPORTANT:
// Do NOT import ITeamManagement (extends Document) into API contracts.
// Use a DTO/Base type from the model file instead.
// After you rename custom id to teamCode, export TeamManagementBase/Dto from that model file.
import type { TeamManagementDto } from "../models/teamManagement/teamManagement.model";

import type { IWorkItem } from "../models/teamManagement/workItem.model";
import type { IWorkEvent } from "../models/teamManagement/workEvent.model";

// ──────────────────────────────────────────────────────────────
// 1) Core primitives
// ──────────────────────────────────────────────────────────────

export type ApiStatus = "success" | "error" | "fail";

// ──────────────────────────────────────────────────────────────
// 2) Shared utility payloads
// ──────────────────────────────────────────────────────────────

export interface DateRange {
   start: string | Date;
   end: string | Date;
}

export interface PaginationMeta {
   index?: number;
   limit?: number;
   total?: number;

   start?: number;
   end?: number;

   search?: string;
   dateRange?: DateRange;

   hasNext?: boolean;
   hasPrevious?: boolean;
   hasResults?: boolean;
   hasMore?: boolean;

   nextCursor?: string;
}

export interface ValidationUnit {
   token?: string;
   isValid?: boolean;
   expiresAt?: string;
}

/**
 * Minimal file metadata used across backend.
 * NOTE: You already also have FileMetaBase in teamManagement.model.ts.
 * Prefer a single source later (export and reuse) to avoid drift.
 */
export interface FileMetaBase {
   originalName: string;
   storedName: string;
   extension: string;
   mimeType: string;
   sizeBytes: number;
}

// ──────────────────────────────────────────────────────────────
// 3) Domain payload (SystemData)
//    This is the “typed dictionary” of your business models.
// ──────────────────────────────────────────────────────────────

export interface SystemData {
   // Users
   user?: User;
   users?: User[];

   // Leases
   lease?: LeasePayload;
   leases?: LeasePayload[];
   leaseWithProperty?: LeasePayloadWithProperty;
   leaseWithProperties?: LeasePayloadWithProperty[];

   // Properties
   property?: IProperty;
   properties?: IProperty[];

   // Tenants
   tenant?: ITenant;
   tenants?: ITenant[];

   // Complaints
   complaint?: IComplaint;
   complaints?: IComplaint[];

   // Files
   fileUpload?: UserDocumentEntity;
   fileUploads?: UserDocumentEntity[];
   file?: FileMetaBase;
   files?: FileMetaBase[];

   // Team Management
   // DTO ONLY (plain JSON) — safe for aggregate() results
   team?: TeamManagementDto;
   teams?: TeamManagementDto[];

   // Work items / events
   workItem?: IWorkItem;
   workItems?: IWorkItem[];
   event?: IWorkEvent;
   events?: IWorkEvent[];

   // Dashboard summaries
   totalUsers?: number;
   totalProperties?: number;
   totalTenants?: number;
   totalComplaints?: number;
}

// ──────────────────────────────────────────────────────────────
// 4) Generic wrappers (ApiData, ApiResponse)
// ──────────────────────────────────────────────────────────────

export interface ApiData<
   TSystem = SystemData,
   TOther extends Record<string, unknown> = Record<string, unknown>
> {
   pagination?: PaginationMeta;
   validation?: ValidationUnit;
   system?: TSystem;

  /**
   * Extra payload that is NOT core domain data.
   * Keep this typed (Record<string, unknown>) instead of any.
   */
   other?: TOther;
}

export interface ApiResponse<TData = ApiData> {
   success: boolean;
   status: ApiStatus;
   message: string;

   data: TData | null;

   timestamp?: string;
   path?: string;
   requestId?: string;
}

// Backwards-compatible alias
export type MSG<TData = ApiData> = ApiResponse<TData>;

// ──────────────────────────────────────────────────────────────
// 5) Convenience extraction types
// ──────────────────────────────────────────────────────────────

export type PaginationType = NonNullable<MSG[ "data" ]>[ "pagination" ];
export type ValidationType = NonNullable<MSG[ "data" ]>[ "validation" ];
export type SystemType = NonNullable<MSG[ "data" ]>[ "system" ];
export type OtherType = NonNullable<MSG[ "data" ]>[ "other" ];

// ──────────────────────────────────────────────────────────────
// 6) System slices (module-specific strong typing)
//    These are “views” of SystemData for specific endpoints.
// ──────────────────────────────────────────────────────────────

// Lease-focused system slice
export type LeaseSystemData = Pick<
   SystemData,
   "lease" | "leases" | "leaseWithProperty" | "leaseWithProperties"
>;

// Property-focused system slice
export type PropertySystemData = Pick<SystemData, "property" | "properties">;

// Tenant-focused system slice
export type TenantSystemData = Pick<SystemData, "tenant" | "tenants">;

// Complaint-focused system slice
export type ComplaintSystemData = Pick<SystemData, "complaint" | "complaints">;

// File upload-focused system slice
export type FileUploadSystemData = Pick<SystemData, "fileUpload" | "fileUploads">;

// Team management system slice (DTO)
export type TeamManagementSystemData = Pick<SystemData, "team" | "teams">;

// File meta slice
export type FileMetaSystemData = Pick<SystemData, "file" | "files">;

// Dashboard summary slice
export type DashboardSystemData = Pick<
   SystemData,
   "totalUsers" | "totalProperties" | "totalTenants" | "totalComplaints"
>;

// ──────────────────────────────────────────────────────────────
// 7) Convenience ApiData aliases per module
// ──────────────────────────────────────────────────────────────

export type LeaseApiData = ApiData<LeaseSystemData>;
export type PropertyApiData = ApiData<PropertySystemData>;
export type TenantApiData = ApiData<TenantSystemData>;
export type ComplaintApiData = ApiData<ComplaintSystemData>;
export type FileUploadApiData = ApiData<FileUploadSystemData>;
export type TeamManagementApiData = ApiData<TeamManagementSystemData>;
export type FileMetaApiData = ApiData<FileMetaSystemData>;
export type DashboardApiData = ApiData<DashboardSystemData>;
