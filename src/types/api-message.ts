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
import type { WorkEventDto } from "../models/teamManagement/workEvent.model";
import type { RecycleBinEntryDto } from './recyclebin/recyclebin.types';
import type { MemberActivityDto } from "./teamManagement/memberActivities/memberActivities.types";
import type { MilestoneDto } from './teamManagement/milestones/milestone.types';
import type { TeamManagementDto } from "./teamManagement/teamMain/teamManagement.types";
import type { TeamTaskDto } from './teamManagement/teamTasks/team-tasks.type';
import type { WorkItemDto } from "./teamManagement/workItem/workItem.types";

// ✅ TYPE-ONLY import (prevents runtime dependency problems)
import type { CommentDto } from "./comment.types";
import type { FileMetaPacket, PaginationMeta, ValidationUnit } from "./common";
import type { NotificationCoreDto, NotificationInboxItemDto } from './notification/notification.types';
import type { BankAccountDto } from "./payments/bank-registry/bank-accounts/bank-account.types";
import type { BankCoreDto } from "./payments/bank-registry/banks/bank.types";
import type { PaymentTransactionCoreDto, PaymentTransactionListItemDto } from "./payments/transactions/payment-transaction.types";

// ──────────────────────────────────────────────────────────────
// 1) Core primitives
// ──────────────────────────────────────────────────────────────
export type ApiStatus = "success" | "error" | "fail";


// ──────────────────────────────────────────────────────────────
// 2) Domain payload (SystemData)
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
  memberActivity: MemberActivityDto;
  memberActivities: MemberActivityDto[];
  milestone: MilestoneDto;
  milestones: MilestoneDto[];

  // Comments
  comment?: CommentDto;
  comments?: CommentDto[];

  // RecycleBin
  recycleBinItem?: RecycleBinEntryDto;
  recycleBinItems?: RecycleBinEntryDto[];

  //Notifications
  notification?: NotificationInboxItemDto | NotificationCoreDto;
  notifications?: NotificationInboxItemDto[] | NotificationCoreDto[];

  //Payments
  bank?: BankCoreDto;
  banks?: BankCoreDto[];

  bankAccount?: BankAccountDto;
  bankAccounts?: BankAccountDto[];

  transaction?: PaymentTransactionCoreDto;
  transactions?: PaymentTransactionCoreDto[] | PaymentTransactionListItemDto[];

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

export type MemberActivitySystemData = Pick<SystemData, 'memberActivity' | 'memberActivities'>;

export type MilestoneSystemData = Pick<SystemData, 'milestone' | 'milestones'>;

export type RecycleBinSystemData = Pick<SystemData, 'recycleBinItem' | 'recycleBinItems'>;

export type NotificationSystemData = Pick<SystemData, 'notification' | 'notifications'>;



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
export type MemberActivityApiData = ApiData<MemberActivitySystemData>;
export type MilestoneApiData = ApiData<MilestoneSystemData>;
export type RecycleBinApiData = ApiData<RecycleBinSystemData>;
export type NotificationApiData = ApiData<NotificationSystemData>;

