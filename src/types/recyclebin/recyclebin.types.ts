// Path: src/types/recyclebin/recyclebin.types.ts
// =============================================================================
// RecycleBin — Contracts / DTOs / Service Inputs (MODEL-ALIGNED)
// -----------------------------------------------------------------------------
// ✅ Goal
// - Keep types aligned to src/models/recyclebin/recyclebin-entry.model.ts
// - Separate DB-native fields vs API/FE DTO fields
//
// ✅ Key rule
// - Mongo stores Date/ObjectId; API/FE uses ISO strings + entryId string
// - exactOptionalPropertyTypes: optional fields are OMITTED (never `undefined`)
// =============================================================================

import type { ClientSession, Types } from "mongoose";

import type { AuthUser } from "../common";
import type { FileMetaPacket } from "../common";

// =============================================================================
// 0) Shared primitives
// =============================================================================

/** Your system uses ISO strings heavily for FE/API */
export type ISODateString = string;

/** Matches the model RecycleBinStatus union exactly */
export type RecycleBinStatus =
  | "recording"
  | "recorded"
  | "restore_in_progress"
  | "restored"
  | "purged"
  | "failed";

/**
 * Recycle source key (dynamic)
 * Examples: "teamTask", "workItem", "property", "lease"
 */
export type RecycleSourceKey = string;

// =============================================================================
// 1) DTO Shapes (Frontend/API)
// =============================================================================

/**
 * Canonical DTO for a recycle bin entry for API/FE.
 * - Dates are ISO strings
 * - Mongo _id is exposed as entryId string
 * - Mirrors the model fields 1:1 (but with DTO conversions)
 */
export interface RecycleBinEntryDto {
  entryId: string;

  sourceKey: string;
  refId: string;

  label: string;
  description?: string;

  deletedAtIso: ISODateString;
  deletedBy: AuthUser;

  recycleDirRelPath: string;
  snapshotRelPath: string;
  metaRelPath: string;
  filesDirRelPath: string;

  files: FileMetaPacket[];
  snapshotData: Record<string, unknown>;

  tags?: string[];
  module?: string;
  entity?: string;
  extra?: Record<string, unknown>;

  status: RecycleBinStatus;

  restoredAtIso?: ISODateString;
  restoredBy?: AuthUser;

  purgedAtIso?: ISODateString;
  purgedBy?: AuthUser;
}

export interface RecycleBinEntryLean {
  _id: Types.ObjectId;

  sourceKey: string;
  refId: string;

  label: string;
  description?: string;

  deletedAt: Date;
  deletedBy: AuthUser;

  recycleDirRelPath: string;
  snapshotRelPath: string;
  metaRelPath: string;
  filesDirRelPath: string;

  files: FileMetaPacket[];
  snapshotData: Record<string, unknown>;

  tags?: string[];
  module?: string;
  entity?: string;
  extra?: Record<string, unknown>;

  status: RecycleBinStatus;

  restoredAt?: Date;
  restoredBy?: AuthUser;

  purgedAt?: Date;
  purgedBy?: AuthUser;
}

/**
 * Lightweight DTO for list screens (faster + smaller payload).
 * Mirrors the model but intentionally excludes snapshotData by default.
 */
export interface RecycleBinListItemDto {
  entryId: string;

  sourceKey: string;
  refId: string;

  label: string;
  description?: string;

  deletedAtIso: ISODateString;
  deletedBy: AuthUser;

  status: RecycleBinStatus;

  filesCount: number;

  recycleDirRelPath: string;

  tags?: string[];
  module?: string;
  entity?: string;

  restoredAtIso?: ISODateString;
  purgedAtIso?: ISODateString;
}

/**
 * Snapshot read response used by "Preview" UI.
 * - snapshotData prefers disk snapshot.json, but API returns the final resolved data
 * - meta is loaded from meta.json (or fallback object)
 */
export interface RecycleBinSnapshotReadDto {
  entry: RecycleBinEntryDto;
  snapshotData: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/**
 * Restore prepare response
 * - Caller (domain module) uses snapshotData + files manifest to re-create record and move files back
 */
export interface RecycleBinRestorePrepareDto {
  entry: RecycleBinEntryDto;
  snapshotData: Record<string, unknown>;
  files: FileMetaPacket[];
}

// =============================================================================
// 2) Engine/Service Inputs (Backend internal contracts)
// =============================================================================

/**
 * Record input (matches your engine expectation).
 * Domain module MUST provide snapshotData + files manifest (engine will not guess).
 */
export interface RecycleBinRecordInput {
  sourceKey: RecycleSourceKey;
  refId: string;

  label: string;
  description?: string;

  deletedBy: AuthUser;

  tags?: string[];
  module?: string;
  entity?: string;
  extra?: Record<string, unknown>;

  snapshotData: Record<string, unknown>;
  files: FileMetaPacket[];
}

/**
 * Record result (what engine returns; controller can map to DTO if needed)
 */
export interface RecycleBinRecordResult {
  entryId: string;
  sourceKey: string;
  refId: string;
  status: RecycleBinStatus;

  recycleDirRelPath: string;
  snapshotRelPath: string;
  metaRelPath: string;
  filesDirRelPath: string;
}

/**
 * Listing filters (aligned to model fields)
 */
export interface RecycleBinListFilters {
  sourceKey?: string;
  search?: string; // label/refId/deletedBy.username

  status?: RecycleBinStatus;
  deletedByUsername?: string;

  deletedFromIso?: ISODateString; // inclusive
  deletedToIso?: ISODateString;   // inclusive

  tagsAny?: string[];
  module?: string;
  entity?: string;
}

/**
 * Pagination request (1-based)
 */
export interface PageQuery {
  page: number;
  limit: number;
}

/**
 * List result (generic form for controller/service)
 */
export interface RecycleBinListResult<TItem = RecycleBinListItemDto> {
  items: TItem[];
  other: { total: number };
}

/**
 * Count result
 */
export interface RecycleBinCountResult {
  total: number;
}

/**
 * Restore/Purge requests (controller-level contracts)
 */
export interface RecycleBinPrepareRestoreRequest {
  entryId: string;
  restoredBy: AuthUser;
  session?: ClientSession;
}

export interface RecycleBinMarkRestoredRequest {
  entryId: string;
  restoredBy: AuthUser;
  session?: ClientSession;
}

export interface RecycleBinPurgeRequest {
  entryId: string;
  purgedBy: AuthUser;
  session?: ClientSession;
}

export interface RecycleBinPurgeResult {
  purged: boolean;
  entryId: string;
}

// =============================================================================
// 3) Mapping Notes (for your controller/service implementation)
// =============================================================================
// - DB -> DTO conversions you MUST do (examples):
//   entryId: String(entry._id)
//   deletedAtIso: entry.deletedAt.toISOString()
//   restoredAtIso: entry.restoredAt?.toISOString()  (only if restoredAt exists)
//   purgedAtIso: entry.purgedAt?.toISOString()      (only if purgedAt exists)
// - exactOptionalPropertyTypes: only attach optional props when they exist
// =============================================================================
