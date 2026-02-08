// Path: src/types/comment.types.ts
import type { FilterQuery } from "mongoose";

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

// =============================================================================
// Comment Contract (Backend canonical types)
// =============================================================================

/**
 * Attachment URL source meaning:
 * - "unknown": legacy / cannot detect
 * - "remote": points to remote storage (cdn/s3/etc.)
 * - "local": points to your server (public/..., local file system)
 */
export type CommentAttachmentSource = "unknown" | "remote" | "local";
export const CommentAttachmentSourceValues = [ "unknown", "remote", "local" ] as const;

/**
 * CommentAudience
 * - Acts like "visibility group" / "role scope" for comments
 * - Covers real estate org structure: executives, finance, legal, HR,
 *   operations, facilities, leasing, customer care, auditors, IT, etc.
 */
export type CommentAudience =
  // ── Executive / Governance
  | "all"
  | "executive"
  | "board"
  | "director"
  | "ceo"
  | "cfo"
  | "coo"
  | "cto"
  | "cio"

  // ── Admin / Core
  | "admin"
  | "system"
  | "user"

  // ── Property business roles
  | "owner"
  | "tenant"
  | "agent"
  | "broker"
  | "landlord"
  | "leasing"
  | "leasing_manager"
  | "property_manager"
  | "facility_manager"
  | "estate_manager"

  // ── Operations / Teams
  | "operator"
  | "manager"
  | "lead"
  | "supervisor"
  | "captain"
  | "member"
  | "observer"

  // ── Backoffice / Corporate
  | "finance"
  | "accountant"
  | "accounts_payable"
  | "accounts_receivable"
  | "billing"
  | "payroll"
  | "procurement"
  | "legal"
  | "compliance"
  | "auditor"
  | "hr"
  | "reception"
  | "customer_support"
  | "call_center"

  // ── Tech / Internal
  | "developer"
  | "qa"
  | "devops"
  | "it_support"
  | "data_analyst"

  // ── Field / Maintenance roles
  | "mechanic"
  | "carpenter"
  | "electrician"
  | "plumber"
  | "technician"
  | "welder"
  | "driver"
  | "cleaner"
  | "security"
  | "gardener"
  | "painter"
  | "mason"
  | "helper"
  | "inspector"
  | "surveyor";

export const CommentAudienceValues = [
  "all",
  "executive",
  "board",
  "director",
  "ceo",
  "cfo",
  "coo",
  "cto",
  "cio",

  "admin",
  "system",
  "user",

  "owner",
  "tenant",
  "agent",
  "broker",
  "landlord",
  "leasing",
  "leasing_manager",
  "property_manager",
  "facility_manager",
  "estate_manager",

  "operator",
  "manager",
  "lead",
  "supervisor",
  "captain",
  "member",
  "observer",

  "finance",
  "accountant",
  "accounts_payable",
  "accounts_receivable",
  "billing",
  "payroll",
  "procurement",
  "legal",
  "compliance",
  "auditor",
  "hr",
  "reception",
  "customer_support",
  "call_center",

  "developer",
  "qa",
  "devops",
  "it_support",
  "data_analyst",

  "mechanic",
  "carpenter",
  "electrician",
  "plumber",
  "technician",
  "welder",
  "driver",
  "cleaner",
  "security",
  "gardener",
  "painter",
  "mason",
  "helper",
  "inspector",
  "surveyor",
] as const;

// =============================================================================
// Comment Targets (MATCHES comments.source.ts)
// =============================================================================

/**
 * ✅ Canonical sections (domain categories)
 * These MUST align with CommentsSourceRegistry in src/source/comments.source.ts
 */
export type CommentSection =
  | "Users"
  | "Properties"
  | "Complaints"
  | "Tenants"
  | "Leases"
  | "Teams";

/**
 * ✅ Teams-only sub-sections (target-model selector under Teams)
 * This is NOT "array keys of DTO".
 * This decides which model the comment belongs to inside Teams domain.
 */
export type TeamCommentSubSection =
  | "Teams"
  | "WorkItems"
  | "Events";

/**
 * For non-Teams sections, subSection must not exist.
 * For Teams section, subSection is required.
 *
 * NOTE about exactOptionalPropertyTypes:
 * - You asked to avoid that compiler behavior.
 * - Still, your project sometimes hits it, so we keep `?: string | undefined`
 *   for fields you pass through between FE/BE.
 */
export type CommentTargetDto =
  | {
    section: "Users";
    subSection?: never;
    refId: string;
    module?: string | undefined;
    scope?: Record<string, unknown> | null;
    modelName?: string | undefined;
  }
  | {
    section: "Properties";
    subSection?: never;
    refId: string;
    module?: string | undefined;
    scope?: Record<string, unknown> | null;
    modelName?: string | undefined;
  }
  | {
    section: "Complaints";
    subSection?: never;
    refId: string;
    module?: string | undefined;
    scope?: Record<string, unknown> | null;
    modelName?: string | undefined;
  }
  | {
    section: "Tenants";
    subSection?: never;
    refId: string;
    module?: string | undefined;
    scope?: Record<string, unknown> | null;
    modelName?: string | undefined;
  }
  | {
    section: "Leases";
    subSection?: never;
    refId: string;
    module?: string | undefined;
    scope?: Record<string, unknown> | null;
    modelName?: string | undefined;
  }
  | {
    section: "Teams";
    subSection: TeamCommentSubSection; // required ✅ (matches DB rule)
    refId: string;
    module?: string | undefined;
    scope?: Record<string, unknown> | null;
    modelName?: string | undefined;
  };

export type CommentTargetPeekDto = {
  section: CommentSection;
  refId: string;
  subSection?: string; // optional here (transport)
  scope?: Record<string, unknown> | null;
  modelName?: string;
};
/**
 * Compile-time only map (helpful for developers).
 * This is NOT used for runtime resolution (comments.source.ts is).
 */
export type CommentTargetDtoTypeMap = {
  Users: User;
  Properties: IProperty;
  Complaints: IComplaint;
  Tenants: ITenant;
  Leases: LeasePayload | LeasePayloadWithProperty;

  // Teams domain uses subSection to decide which model you meant.
  Teams: TeamManagementDto | WorkItemDto | WorkEventDto;
};

// =============================================================================
// Comment DTOs (includes Facebook-style threading)
// =============================================================================

export interface CommentAuthorDto {
  authorId: string;
  name: string;
  username: string;
  role?: CommentAudience | null;
  image?: string | null;
}

export interface CommentAttachmentDto {
  url: string;
  name: string;
  source: CommentAttachmentSource;
  relativePath: string;
  mimetype?: string | null;
  sizeBytes?: number | null;
  uploadedAtIso?: string | null;
  checksumSha256?: string | null;
}

/**
 * Threading fields (Facebook-style):
 * - parentCommentId: null/undefined => top-level
 * - threadRootId: points to the top-level comment id for the thread
 * - depth: 0,1,2... (enforce max depth in service)
 * - path: stable ordering key (e.g. "rootId/replyId/replyId")
 *
 * NOTE:
 * - These are DTO fields; DB schema will enforce and index them.
 */
export interface CommentDto {
  commentTarget: CommentTargetDto;

  commentId: string;

  // Author
  byUserId: string;
  byUsername: string;
  byName: string;
  byAvatarUrl?: string | null;

  // Visibility
  audience: CommentAudience;

  // Content
  messageHtml: string;

  // Attachments
  attachments?: CommentAttachmentDto[] | null;

  // Optional enriched author block
  author?: CommentAuthorDto | null;

  // Threading (nested replies)
  parentCommentId?: string | null;
  threadRootId?: string | null;
  depth?: number | null;
  path?: string | null;

  // Pin support
  pinned?: boolean | null;
  pinnedAtIso?: string | null;
  pinnedByUserId?: string | null;

  // Timestamps
  createdAtIso: string;
  updatedAtIso: string;
}

// =============================================================================
// Advanced Pagination + Filtering Types
// =============================================================================

export type CommentSortOrder = "newest" | "oldest";

export interface CommentLoadFilters {
  // Target filtering
  section?: CommentSection;
  subSection?: string; // keep string for forward-compat; runtime validates via registry
  refId?: string;
  module?: string;

  // Scope match support (scope is object -> match by key/value)
  scopeKey?: string;
  scopeValue?: string;

  // Author / audience
  byUserId?: string;
  audience?: CommentAudience;

  // Thread filtering
  threadRootId?: string;
  parentCommentId?: string;
  topLevelOnly?: boolean; // true => parentCommentId null
  pinnedOnly?: boolean;

  // Date range (ISO strings)
  fromIso?: string; // >=
  toIso?: string; // <=

  // Search across byName, messageHtml(text), attachment names
  q?: string;
}

export interface OffsetPagination {
  mode: "offset";
  offset: number;
  limit: number;
}

export interface CursorPagination {
  mode: "cursor";
  limit: number;

  /**
   * Cursor format suggestion:
   *   `${createdAtIso}__${commentId}`
   *
   * IMPORTANT:
   * - If you don't have a cursor, OMIT the property.
   * - Do NOT pass `cursor: undefined`.
   */
  cursor?: string;
}

export type CommentPagination = OffsetPagination | CursorPagination;

// =============================================================================
// Requests / Responses
// =============================================================================

/**
 * NOTE (legacy compatibility):
 * - entityFilter is from your old embedded design.
 * - For the decoupled engine, entityFilter becomes {} or is removed.
 * - Keep it for now to avoid breaking older routes; we will deprecate later.
 */
export interface CommentLoadRequest {
  filters?: CommentLoadFilters;
  pagination: CommentPagination;
  sort?: CommentSortOrder;
}

export interface CommentLoadResponse {
  rows: CommentDto[];
  total: number;
  hasMore: boolean;

  // cursor pagination only
  nextCursor?: string | null;
}

export interface CommentCountRequest {
  entityFilter: FilterQuery<any>;
  filters?: CommentLoadFilters;
}

// =============================================================================
// Optional: Attachment entity (shared type)
// =============================================================================

export type CommentTargetAttachmentEntity = UserDocumentEntity;
