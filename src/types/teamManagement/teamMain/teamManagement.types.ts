// Path: src/types/teamManagement/teamMain/teamManagement.types.ts
// =============================================================================
// Team Management — Types & Contracts (NO TASKS HERE)
// -----------------------------------------------------------------------------
// ✅ Purpose:
// - Keep Team domain types stable and reusable
// - Remove task-related types (TaskStatus, AssignedTask, Evidence... etc.)
// - TeamTask module becomes the single source-of-truth for tasks
// =============================================================================

import type { Types } from "mongoose";
import type { User } from "../../../models/user.model";

// ─────────────────────────────────────────────
// Shared primitive
// ─────────────────────────────────────────────
export type ISODateString = string;

// ─────────────────────────────────────────────
// Domains
// ─────────────────────────────────────────────
export const TEAM_DOMAINS = [
  "sales",
  "development",
  "support",
  "operations",
  "marketing",
  "finance",
  "other",
] as const;

export type TeamDomain = (typeof TEAM_DOMAINS)[number];

// ─────────────────────────────────────────────
// Organization unit type
// ─────────────────────────────────────────────
export type OrgUnitType = "team" | "department" | "squad" | "board";

// ─────────────────────────────────────────────
// Roles inside a team
// ─────────────────────────────────────────────
export const TEAM_ROLES = [
  "captain",
  "member",
  "lead",
  "supervisor",
  "observer",
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
] as const;

export type RoleInTeam = (typeof TEAM_ROLES)[number];

// ─────────────────────────────────────────────
// Logo / file meta (team-only)
// -----------------------------------------------------------------------------
// Note:
// - Keep this generic enough for future (e.g., team cover image)
// - Avoid task naming: "TaskEvidence" etc.
// ─────────────────────────────────────────────
export interface FileMetaBase {
  originalName: string;
  storedName: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
}

export interface TeamLogoMeta {
  name: string;
  file?: FileMetaBase;
  url?: string;
  storageKey?: string;

  uploadedById?: Types.ObjectId;
  uploadedByUsername?: User["username"];
  uploadedAt?: ISODateString;
}

// ─────────────────────────────────────────────
// Member structures
// ─────────────────────────────────────────────
export type UserTeams = {
  teamName: TeamManagementBase["teamName"];
  domain: TeamDomain;
};

export interface TeamMember {
  id: Types.ObjectId;
  username: User["username"];

  // Optional enrich fields from pipelines (NOT stored necessarily)
  user?: User | null;
  teams?: UserTeams[] | null;

  roleInTeam?: RoleInTeam | null;
  reason?: string | null;
  joinedAt?: ISODateString | null;

  // denormalized snapshot for quick UI
  domain?: TeamDomain | null;
  teamName?: TeamManagementBase["teamName"] | null;
  teamReason?: string | null;
}

// ─────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────
export interface TeamAuditMeta {
  createdByUserId?: Types.ObjectId;
  createdByUsername?: string;

  lastUpdatedByUserId?: Types.ObjectId;
  lastUpdatedByUsername?: string;

  lastActivityAt?: ISODateString;
}

// ─────────────────────────────────────────────
// Root team entity (NO TASKS HERE)
// ─────────────────────────────────────────────
export interface TeamManagementBase {
  _id: Types.ObjectId;
  teamCode: string;
  teamName: string;

  orgType?: OrgUnitType;

  domain: TeamDomain;

  description: string;

  members: TeamMember[];
  captain: TeamMember;

  memberTotal: number;

  teamLogo?: TeamLogoMeta;

  createdAt: ISODateString;
  updatedAt: ISODateString;

  isActive?: boolean;

  audit?: TeamAuditMeta;
}

// DTO used in controllers/services
export type TeamManagementDto = TeamManagementBase;
