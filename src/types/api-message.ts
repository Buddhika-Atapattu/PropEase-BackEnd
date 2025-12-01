// src/types/api-message.ts
import { IComplaint } from '../models/complaint.model';
import { UserDocumentEntity } from '../models/file-upload.model';
import { LeasePayload, LeasePayloadWithProperty } from '../models/lease.model';
import { IProperty } from '../models/property.model';
import { ITenant } from '../models/tenant.model';
import { IUser } from '../models/user.model';

/* ──────────────────────────────────────────────────────────────
   Basic status type for consistency across all APIs
   ────────────────────────────────────────────────────────────── */
export type ApiStatus = 'success' | 'error' | 'fail';

/* ──────────────────────────────────────────────────────────────
   Pagination meta sent from backend to frontend
   ────────────────────────────────────────────────────────────── */

export interface DateRange {
   start: string | Date;
   end: string | Date;
}
export interface PaginationMeta {
   /** Zero-based page index used internally (ex: 0, 1, 2...) */
   index?: number;

   /** Page size (limit per page) */
   limit?: number;

   /** Total number of records in DB (after filters/search) */
   total?: number;

   /** First record position in this page (0-based) */
   start?: number | undefined;

   /** Last record position in this page (0-based, inclusive) */
   end?: number;

   /** Optional search term used to filter data */
   search?: string;

   /** Optional date range term used to filter data */
   dateRange?: DateRange;

   /** Convenience flags – can be calculated on backend or frontend */
   hasNext?: boolean;

   hasPrevious?: boolean;

   hasResults?: boolean;

   hasMore?: boolean;

   nextCursor?: string | undefined;
}

/* ──────────────────────────────────────────────────────────────
   Validation payload (JWT, CSRF, etc.)
   Extend this later if you want more validation info.
   ────────────────────────────────────────────────────────────── */
export interface ValidationUnit {
   /** Access / session / CSRF token */
   token?: string;

   /** Explicit flag for validity – optional */
   isValid?: boolean;

   /** ISO string expiry time if relevant (ex: JWT exp) */
   expiresAt?: string;
}

/* ──────────────────────────────────────────────────────────────
   Strongly-typed system data payload
   (All your core domain models live here)
   ────────────────────────────────────────────────────────────── */
export interface SystemData {
   user?: IUser;
   users?: IUser[];

   lease?: LeasePayload;
   leases?: LeasePayload[];

   leaseWithProperty?: LeasePayloadWithProperty;
   leaseWithProperties?: LeasePayloadWithProperty[];

   property?: IProperty;
   properties?: IProperty[];

   tenant?: ITenant;
   tenants?: ITenant[];

   complaint?: IComplaint;
   complaints?: IComplaint[];

   fileUpload?: UserDocumentEntity;
   fileUploads?: UserDocumentEntity[];

   /** Optional numeric summaries – very common in dashboards */
   totalUsers?: number;
   totalProperties?: number;
   totalTenants?: number;
   totalComplaints?: number;
}

/* ──────────────────────────────────────────────────────────────
   Generic Data wrapper
   - TSystem: shape of "system" (domain) payload
   - TOther:  any extra payload (charts, filters, etc.) WITHOUT using `any`
   ────────────────────────────────────────────────────────────── */
export interface ApiData<
   TSystem = SystemData,
   TOther extends Record<string, unknown> = Record<string, unknown>
> {
   pagination?: PaginationMeta;
   validation?: ValidationUnit;
   system?: TSystem;

   /**
    * Extra data that doesn’t belong to core domain models.
    * Example:
    *  - chartData
    *  - filters
    *  - temporary UI hints
    */
   other?: TOther;
}

/* ──────────────────────────────────────────────────────────────
   Base API response shape used everywhere
   ────────────────────────────────────────────────────────────── */
export interface ApiResponse<TData = ApiData> {
   /** Quick boolean flag for client checks (if (!res.success) ...) */
   success: boolean;

   /** Narrowed status values for better type safety */
   status: ApiStatus;

   /** Human-readable message (toast/alert) */
   message: string;

   /** Main payload */
   data: TData | null;

   /** Optional: ISO timestamp of response generation */
   timestamp?: string;

   /** Optional: backend route path (useful for logging/debugging) */
   path?: string;

   /** Optional: correlation ID / request ID for tracing */
   requestId?: string;
}

/* ──────────────────────────────────────────────────────────────
   Backwards-compatible alias (your old MSG name)
   ────────────────────────────────────────────────────────────── */
export type MSG<TData = ApiData> = ApiResponse<TData>;

export type PaginationType = NonNullable<MSG[ 'data' ]>[ 'pagination' ];

export type ValidationType = NonNullable<MSG[ 'data' ]>[ 'validation' ];

export type SystemType = NonNullable<MSG[ 'data' ]>[ 'system' ];

export type OtherType = NonNullable<MSG[ 'data' ]>[ 'other' ];

// Keep your existing imports and interfaces above...

/* ──────────────────────────────────────────────────────────────
   Narrowed "views" of SystemData for specific modules
   (These help us strongly type each endpoint)
   ────────────────────────────────────────────────────────────── */

// Lease-focused system slice
export type LeaseSystemData = Pick<
   SystemData,
   'lease' | 'leases' | 'leaseWithProperty' | 'leaseWithProperties'
>;

// Property-focused system slice
export type PropertySystemData = Pick<
   SystemData,
   'property' | 'properties'
>;

// Tenant-focused system slice
export type TenantSystemData = Pick<
   SystemData,
   'tenant' | 'tenants'
>;

// Complaint-focused system slice
export type ComplaintSystemData = Pick<
   SystemData,
   'complaint' | 'complaints'
>;

// File upload-focused system slice
export type FileUploadSystemData = Pick<
   SystemData,
   'fileUpload' | 'fileUploads'
>;

// You can also define dashboard summaries:
export type DashboardSystemData = Pick<
   SystemData,
   | 'totalUsers'
   | 'totalProperties'
   | 'totalTenants'
   | 'totalComplaints'
>;

/* Convenience aliases for ApiData with those slices */

export type LeaseApiData = ApiData<LeaseSystemData>;
export type PropertyApiData = ApiData<PropertySystemData>;
export type TenantApiData = ApiData<TenantSystemData>;
export type ComplaintApiData = ApiData<ComplaintSystemData>;
export type FileUploadApiData = ApiData<FileUploadSystemData>;
export type DashboardApiData = ApiData<DashboardSystemData>;


