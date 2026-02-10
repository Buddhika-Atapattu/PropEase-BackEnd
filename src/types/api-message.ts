// Path: src/types/api-message.ts
// ============================================================================
// API Message Types (Backend → Frontend contract)
// ----------------------------------------------------------------------------
// Fixes applied:
// ✅ SystemData.comment/comments must be OPTIONAL (otherwise every response must include them)
// ✅ Import CommentDto as TYPE ONLY (avoid runtime import / TS config issues)
// ✅ Make “system” always a partial dictionary style (already optional fields)
// ✅ Keep API contract DTO-safe (no Document types)
// ✅ Keep MSG helper types safe (existing ones OK)
// ============================================================================

import type { IComplaint } from "../models/complaint.model";
import type { UserDocumentEntity } from "../models/file-upload.model";
import type { LeasePayload, LeasePayloadWithProperty } from "../models/lease.model";
import type { IProperty } from "../models/property.model";
import type { ITenant } from "../models/tenant.model";
import type { User } from "../models/user.model";

// IMPORTANT: Do NOT import Document-extended types into API contracts.
// These must be plain DTOs (Lean-safe).
import type { TeamManagementDto } from "../models/teamManagement/teamManagement.model";
import type { WorkItemDto } from "../models/teamManagement/workItem.model";
import type { WorkEventDto } from "../models/teamManagement/workEvent.model";
import type { ListResult, TeamTaskDto } from './teamManagement/teamTasks/team-tasks.type';

// ✅ TYPE-ONLY import (prevents runtime dependency problems)
import type { CommentDto } from "./comment.types";

// ──────────────────────────────────────────────────────────────
// 1) Core primitives
// ──────────────────────────────────────────────────────────────
export type ApiStatus = "success" | "error" | "fail";
export type IsoDateString = string;

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
  offset?: number;

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
 * NOTE:
 * - You also have FileMetaPacket in teamManagement.model.ts.
 * - Later, export and reuse ONE shared type to avoid drift.
 */
export interface FileMetaPacket {
  // Identity
  originalName: string;
  storedName: string;

  // Type + size
  extension: string;
  mimeType: string;
  sizeBytes: number;

  // Where it lives (filesystem + public mapping)
  relativePath: string;   // under "public/" no leading "/" (PropEase rule)
  publicUrl: string;      // absolute URL that clients can use
  absDiskPath: string;    // full path on disk (useful for internal ops)

  // Upload context
  fieldName: string;      // multer fieldname ("attachments", "files", "images"...)
  uploadedAtIso: IsoDateString;

  // Optional but valuable diagnostics/integrity
  encoding?: string;
  checksumSha256?: string;
}

// ──────────────────────────────────────────────────────────────
// 3) Domain payload (SystemData)
//    Typed “dictionary” of business models.
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
  file?: FileMetaPacket;
  files?: FileMetaPacket[];

  // Team Management (DTO ONLY)
  team?: TeamManagementDto;
  teams?: TeamManagementDto[];

  // Work items / events (DTO ONLY)
  teamTask?: TeamTaskDto;
  teamTasks?: TeamTaskDto[];
  workItem?: WorkItemDto;
  workItems?: WorkItemDto[];
  event?: WorkEventDto;
  events?: WorkEventDto[];

  // Comments
  comment?: CommentDto;
  comments?: CommentDto[];

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

  /**
   * Core “typed domain data”
   */
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
export type PaginationType = NonNullable<NonNullable<MSG[ "data" ]>[ "pagination" ]>;
export type ValidationType = NonNullable<NonNullable<MSG[ "data" ]>[ "validation" ]>;
export type SystemType = NonNullable<NonNullable<MSG[ "data" ]>[ "system" ]>;
export type OtherType = NonNullable<NonNullable<MSG[ "data" ]>[ "other" ]>;

// ──────────────────────────────────────────────────────────────
// 6) System slices (module-specific strong typing)
// ──────────────────────────────────────────────────────────────
export type LeaseSystemData = Pick<
  SystemData,
  "lease" | "leases" | "leaseWithProperty" | "leaseWithProperties"
>;

export type PropertySystemData = Pick<SystemData, "property" | "properties">;

export type TenantSystemData = Pick<SystemData, "tenant" | "tenants">;

export type ComplaintSystemData = Pick<SystemData, "complaint" | "complaints">;

export type FileUploadSystemData = Pick<SystemData, "fileUpload" | "fileUploads">;

export type TeamManagementSystemData = Pick<SystemData, "team" | "teams">;

export type WorkSystemData = Pick<SystemData, "workItem" | "workItems" | "event" | "events">;

export type TeamTaskSystemData = Pick<SystemData, 'teamTask' | 'teamTasks'>;

export type FileMetaSystemData = Pick<SystemData, "file" | "files">;

export type DashboardSystemData = Pick<
  SystemData,
  "totalUsers" | "totalProperties" | "totalTenants" | "totalComplaints"
>;

export type CommentSystemData = Pick<SystemData, "comment" | "comments">;

// ──────────────────────────────────────────────────────────────
// 7) Convenience ApiData aliases per module
// ──────────────────────────────────────────────────────────────
export type LeaseApiData = ApiData<LeaseSystemData>;
export type PropertyApiData = ApiData<PropertySystemData>;
export type TenantApiData = ApiData<TenantSystemData>;
export type ComplaintApiData = ApiData<ComplaintSystemData>;
export type FileUploadApiData = ApiData<FileUploadSystemData>;
export type TeamManagementApiData = ApiData<TeamManagementSystemData>;
export type WorkApiData = ApiData<WorkSystemData>;
export type TeamTaskData = ApiData<TeamTaskSystemData>;
export type FileMetaApiData = ApiData<FileMetaSystemData>;
export type DashboardApiData = ApiData<DashboardSystemData>;
export type CommentApiData = ApiData<CommentSystemData>;
