// Path: src/services/teamManagement/teamMain/teamManagement.rest.service.ts
// ============================================================================
// TeamManagementRestService — Server-side REST domain service (Team MAIN)
// ----------------------------------------------------------------------------
// PURPOSE
// - Move core Team MAIN business logic out of the router.
// - Router/controller remains thin: parse req, call service, respond via ApiResponseBuilder.
// - Service returns typed results and metadata (no res.json here).
//
// INCLUDED (core for your current needs)
// - createTeam (supports multipart payload extraction already done in router OR direct body)
// - updateTeam
// - deleteTeam (soft/hard)
// - getTeamByCode (enriched)
// - getTeamByName (enriched)
// - listTeams (advanced pagination + search + domain + isActive)
//
// IMPORTANT RULES (your rules)
// - 100% class-based
// - TypeScript strict friendly
// - exactOptionalPropertyTypes safe: omit optional properties (do NOT set undefined)
// ============================================================================

import type { FilterQuery, PipelineStage } from "mongoose";
import { Types } from "mongoose";

import type {
  TeamDomain,
  TeamMember,
  ISODateString,
  RoleInTeam,
  TeamManagementDto,
} from "../../../types/teamManagement/teamMain/teamManagement.types";

import { TEAM_ROLES } from "../../../types/teamManagement/teamMain/teamManagement.types";

import { TeamManagementModel } from "../../../models/teamManagement/teamMain/teamManagement.model";
import { UserModel, USER_MODEL_PROJECTION } from "../../../models/user.model";
import type { User } from "../../../models/user.model";

import type { PaginationMeta } from "../../../types/common";

// ---------------------------------------------------------------------------
// Service results (router/controller uses these to respond with ApiResponseBuilder)
// ---------------------------------------------------------------------------
export interface TeamListFilters {
  search?: string;
  domain?: TeamDomain;
  isActive?: boolean;
}

export interface TeamListResult {
  rows: TeamManagementDto[];
  pagination: PaginationMeta;
}

export interface TeamTotalsResult {
  totalTeams: number;
  totalActive: number;
  totalInactive: number;
  domainTotals: Record<TeamDomain, number>;
}

export interface TeamDomainTotalsResult {
  domain: TeamDomain;
  totalTeams: number;
  totalActive: number;
  totalInactive: number;
}

export interface TeamCreateInput {
  teamName: string;
  domain: TeamDomain;
  description?: string;
  members?: TeamMember[];
  captain: TeamMember;
  isActive?: boolean;

  // Optional logo/evidence already normalized by router/controller
  teamLogo?: unknown;

  // Optional tasks (if your model includes them)
  assignTasks?: unknown[];
}

export interface TeamUpdateInput {
  teamName?: string;
  domain?: TeamDomain;
  description?: string;
  members?: TeamMember[];
  captain?: TeamMember;
  isActive?: boolean;
  teamLogo?: unknown;
  assignTasks?: unknown[];
}

export class TeamManagementRestService {
  private readonly ALLOWED_TEAM_DOMAINS: TeamDomain[] = [
    "sales",
    "development",
    "support",
    "operations",
    "marketing",
    "finance",
    "other",
  ];

  public constructor() {}

  // ========================================================================
  // Domain validation helpers
  // ========================================================================

  public isValidTeamDomain(domain: string): domain is TeamDomain {
    return this.ALLOWED_TEAM_DOMAINS.includes(domain as TeamDomain);
  }

  public normalizeDomain(raw: string): TeamDomain | null {
    const d = raw.trim().toLowerCase();
    if (!d) return null;
    if (!this.isValidTeamDomain(d)) return null;
    return d as TeamDomain;
  }

  // ========================================================================
  // Pagination helper
  // ========================================================================

  public parsePagination(indexRaw: unknown, limitRaw: unknown, fallbackLimit: number = 10): {
    index: number;
    limit: number;
    skip: number;
  } {
    const indexNum = Number(indexRaw);
    const limitNum = Number(limitRaw);

    const index = Number.isFinite(indexNum) && indexNum >= 0 ? indexNum : 0;
    const limit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : fallbackLimit;

    return { index, limit, skip: index * limit };
  }

  public parseBooleanQuery(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const n = value.trim().toLowerCase();
      if (n === "true" || n === "1") return true;
      if (n === "false" || n === "0") return false;
    }
    return undefined;
  }

  // ========================================================================
  // Identity generator (same logic as router; centralized here)
  // ========================================================================

  public generateTeamIdentity(): string {
    const PREFIX = "PROPEASE-TEAM";
    const now = new Date();

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    const millis = String(now.getMilliseconds()).padStart(3, "0");

    const dateBlock = `${year}${month}${day}`;
    const timeBlock = `${hours}${minutes}${seconds}-${millis}`;

    const SAFE_CHARS = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";
    const entropy = Array.from({ length: 6 })
      .map(() => SAFE_CHARS[Math.floor(Math.random() * SAFE_CHARS.length)])
      .join("");

    const seed = `${dateBlock}${timeBlock}${entropy}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) % 9973;
    }

    const c1 = SAFE_CHARS[hash % SAFE_CHARS.length];
    const c2 = SAFE_CHARS[(hash >> 3) % SAFE_CHARS.length];

    return `${PREFIX}-${dateBlock}-${timeBlock}-${entropy}-${c1}${c2}`;
  }

  // ========================================================================
  // TeamMember parsing helpers (reused in controller/router, but available here)
  // ========================================================================

  public resolveRoleInTeam(raw: unknown): RoleInTeam | undefined {
    if (typeof raw !== "string") return undefined;
    const r = raw.trim().toLowerCase();
    if (!r) return undefined;

    const matched = (TEAM_ROLES as readonly string[]).find((x) => x === r);
    return matched ? (matched as RoleInTeam) : undefined;
  }

  public extractTeamMembersFromArray(input: unknown): TeamMember[] {
    if (!Array.isArray(input)) return [];

    const result: TeamMember[] = [];
    for (const raw of input as unknown[]) {
      if (!raw || typeof raw !== "object") continue;

      const anyU = raw as {
        _id?: unknown;
        id?: unknown;
        userId?: unknown;
        username?: unknown;
        userName?: unknown;
        name?: unknown;
        roleInTeam?: unknown;
        reason?: unknown;
        joinedAt?: unknown;
      };

      const idSource = anyU._id ?? anyU.id ?? anyU.userId;
      const usernameSource = anyU.username ?? anyU.userName ?? anyU.name;

      if (!idSource || typeof usernameSource !== "string") continue;

      const username = usernameSource.trim();
      if (!username) continue;

      let oid: Types.ObjectId;
      try {
        oid = new Types.ObjectId(String(idSource));
      } catch {
        continue;
      }

      const member: TeamMember = {
        id: oid,
        username: username as User["username"],
      };

      const role = this.resolveRoleInTeam(anyU.roleInTeam);
      if (role) member.roleInTeam = role;

      if (typeof anyU.reason === "string") {
        const rr = anyU.reason.trim();
        if (rr) member.reason = rr;
      }

      if (typeof anyU.joinedAt === "string") {
        const ja = anyU.joinedAt.trim();
        if (ja && !Number.isNaN(Date.parse(ja))) member.joinedAt = ja as ISODateString;
      }

      result.push(member);
    }

    return result;
  }

  public extractTeamMember(input: unknown): TeamMember | null {
    if (!input || typeof input !== "object") return null;

    const anyU = input as {
      _id?: unknown;
      id?: unknown;
      userId?: unknown;
      username?: unknown;
      userName?: unknown;
      name?: unknown;
      roleInTeam?: unknown;
      reason?: unknown;
      joinedAt?: unknown;
    };

    const idSource = anyU._id ?? anyU.id ?? anyU.userId;
    const usernameSource = anyU.username ?? anyU.userName ?? anyU.name;

    if (!idSource || typeof usernameSource !== "string") return null;

    const username = usernameSource.trim();
    if (!username) return null;

    let oid: Types.ObjectId;
    try {
      oid = new Types.ObjectId(String(idSource));
    } catch {
      return null;
    }

    const member: TeamMember = {
      id: oid,
      username: username as User["username"],
    };

    const role = this.resolveRoleInTeam(anyU.roleInTeam);
    if (role) member.roleInTeam = role;

    if (typeof anyU.reason === "string") {
      const rr = anyU.reason.trim();
      if (rr) member.reason = rr;
    }

    if (typeof anyU.joinedAt === "string") {
      const ja = anyU.joinedAt.trim();
      if (ja && !Number.isNaN(Date.parse(ja))) member.joinedAt = ja as ISODateString;
    }

    return member;
  }

  // ========================================================================
  // Enrichment pipeline (ported from router; kept centralized here)
  // ========================================================================

  private getUserSafeProjectionForLookup(): typeof USER_MODEL_PROJECTION {
    return USER_MODEL_PROJECTION;
  }

  private buildTeamUserEnrichmentStages(): PipelineStage.FacetPipelineStage[] {
    const usersCollection = UserModel.collection.name;
    const teamsCollection = TeamManagementModel.collection.name;

    const safeUserProject: Record<string, unknown> = this.getUserSafeProjectionForLookup();

    const stages: PipelineStage.FacetPipelineStage[] = [
      {
        $addFields: {
          memberIds: { $map: { input: "$members", as: "m", in: "$$m.id" } },
          memberUsernames: { $map: { input: "$members", as: "m", in: "$$m.username" } },

          captainId: "$captain.id",
          captainUsername: "$captain.username",

          allUserIds: {
            $setUnion: [
              { $map: { input: "$members", as: "m", in: "$$m.id" } },
              { $cond: [{ $ifNull: ["$captain.id", null] }, ["$captain.id"], []] },
            ],
          },
        },
      },
      {
        $lookup: {
          from: usersCollection,
          let: {
            ids: {
              $setUnion: [
                "$memberIds",
                { $cond: [{ $ifNull: ["$captain.id", null] }, ["$captain.id"], []] },
              ],
            },
            usernames: {
              $setUnion: [
                "$memberUsernames",
                { $cond: [{ $ifNull: ["$captain.username", null] }, ["$captain.username"], []] },
              ],
            },
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $in: ["$_id", "$$ids"] },
                    { $in: ["$username", "$$usernames"] },
                  ],
                },
              },
            },
            { $project: safeUserProject },
          ],
          as: "allUsersResolved",
        },
      },
      {
        $lookup: {
          from: teamsCollection,
          let: { allIds: "$allUserIds" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $in: ["$captain.id", "$$allIds"] },
                    {
                      $gt: [
                        {
                          $size: {
                            $filter: {
                              input: "$members",
                              as: "m",
                              cond: { $in: ["$$m.id", "$$allIds"] },
                            },
                          },
                        },
                        0,
                      ],
                    },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 0,
                teamName: 1,
                domain: 1,
                captain: {
                  id: "$captain.id",
                  joinedAt: "$captain.joinedAt",
                  roleInTeam: "$captain.roleInTeam",
                  reason: "$captain.reason",
                },
                members: {
                  $map: {
                    input: "$members",
                    as: "m",
                    in: {
                      id: "$$m.id",
                      joinedAt: "$$m.joinedAt",
                      roleInTeam: "$$m.roleInTeam",
                      reason: "$$m.reason",
                    },
                  },
                },
              },
            },
          ],
          as: "allTeamsForPeople",
        },
      },
      {
        $addFields: {
          members: {
            $map: {
              input: "$members",
              as: "m",
              in: {
                $let: {
                  vars: {
                    userCandidates: {
                      $filter: {
                        input: "$allUsersResolved",
                        as: "u",
                        cond: {
                          $or: [
                            { $eq: ["$$u._id", "$$m.id"] },
                            { $eq: ["$$u.username", "$$m.username"] },
                          ],
                        },
                      },
                    },
                  },
                  in: {
                    id: { $toString: "$$m.id" },
                    username: "$$m.username",
                    user: { $ifNull: [{ $first: "$$userCandidates" }, null] },
                  },
                },
              },
            },
          },
          captain: {
            $let: {
              vars: {
                captainCandidates: {
                  $filter: {
                    input: "$allUsersResolved",
                    as: "u",
                    cond: {
                      $or: [
                        { $eq: ["$$u._id", "$captain.id"] },
                        { $eq: ["$$u.username", "$captain.username"] },
                      ],
                    },
                  },
                },
              },
              in: {
                id: { $toString: "$captain.id" },
                username: "$captain.username",
                user: { $ifNull: [{ $first: "$$captainCandidates" }, null] },
              },
            },
          },
        },
      },
      {
        $project: {
          memberIds: 0,
          memberUsernames: 0,
          captainId: 0,
          captainUsername: 0,
          allUserIds: 0,
          allUsersResolved: 0,
          allTeamsForPeople: 0,
        },
      },
    ];

    return stages;
  }

  // ========================================================================
  // Enriched fetch helpers
  // ========================================================================

  public async fetchEnrichedTeamByCode(teamCode: string): Promise<TeamManagementDto | null> {
    const pipeline: PipelineStage[] = [
      { $match: { teamCode } },
      ...this.buildTeamUserEnrichmentStages(),
      { $limit: 1 },
    ];

    const rows = await TeamManagementModel.aggregate<TeamManagementDto>(pipeline).exec();
    return rows.length > 0 && rows[0] ? rows[0] : null;
  }

  public async fetchEnrichedTeamByName(teamName: string): Promise<TeamManagementDto | null> {
    const escaped = teamName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const pipeline: PipelineStage[] = [
      { $match: { teamName: { $regex: `^${escaped}$`, $options: "i" } } },
      ...this.buildTeamUserEnrichmentStages(),
      { $limit: 1 },
    ];

    const rows = await TeamManagementModel.aggregate<TeamManagementDto>(pipeline).exec();
    return rows.length > 0 && rows[0] ? rows[0] : null;
  }

  // ========================================================================
  // Core operations (CRUD)
  // ========================================================================

  public async createTeam(input: TeamCreateInput): Promise<{ teamCode: string; enriched: TeamManagementDto | null; }> {
    const nowIso = new Date().toISOString();
    const teamCode = this.generateTeamIdentity();

    const teamName = input.teamName.trim();
    if (!teamName) throw new Error("Team name is required.");

    const createDoc: Record<string, unknown> = {
      teamCode,
      teamName,
      domain: input.domain,
      description: (input.description ?? "").toString().trim(),
      members: Array.isArray(input.members) ? input.members : [],
      captain: input.captain,
      memberTotal: Array.isArray(input.members) ? input.members.length : 0,
      createdAt: nowIso,
      updatedAt: nowIso,
      isActive: typeof input.isActive === "boolean" ? input.isActive : true,
    };

    if (Array.isArray(input.assignTasks)) createDoc.assignTasks = input.assignTasks;
    if (input.teamLogo) createDoc.teamLogo = input.teamLogo;

    await TeamManagementModel.create(createDoc as never);

    const enriched = await this.fetchEnrichedTeamByCode(teamCode);
    return { teamCode, enriched };
  }

  public async updateTeam(teamCode: string, input: TeamUpdateInput): Promise<TeamManagementDto | null> {
    const nowIso = new Date().toISOString();

    const update: Record<string, unknown> = { updatedAt: nowIso };

    if (typeof input.teamName === "string") {
      const t = input.teamName.trim();
      if (t) update.teamName = t;
    }

    if (typeof input.description === "string") update.description = input.description.trim();

    if (typeof input.isActive === "boolean") update.isActive = input.isActive;

    if (input.domain) update.domain = input.domain;

    if (Array.isArray(input.members)) {
      update.members = input.members;
      update.memberTotal = input.members.length;
    }

    if (input.captain) update.captain = input.captain;

    if (Array.isArray(input.assignTasks)) update.assignTasks = input.assignTasks;

    if (input.teamLogo) update.teamLogo = input.teamLogo;

    const updated = await TeamManagementModel.findOneAndUpdate(
      { teamCode },
      { $set: update },
      { new: true }
    ).lean().exec();

    if (!updated) return null;

    // Always return enriched for FE consistency
    const enriched = await this.fetchEnrichedTeamByCode(teamCode);
    return enriched;
  }

  public async deleteTeam(teamCode: string, soft: boolean): Promise<{ ok: boolean; soft: boolean; team: unknown | null; }> {
    if (soft) {
      const updated = await TeamManagementModel.findOneAndUpdate(
        { teamCode },
        { $set: { isActive: false, updatedAt: new Date().toISOString() } },
        { new: true }
      ).lean().exec();

      return { ok: !!updated, soft: true, team: updated ?? null };
    }

    const deleted = await TeamManagementModel.findOneAndDelete({ teamCode }).lean().exec();
    return { ok: !!deleted, soft: false, team: deleted ?? null };
  }

  // ========================================================================
  // Reads (single + list)
  // ========================================================================

  public async getTeamByCode(teamCode: string): Promise<TeamManagementDto | null> {
    return this.fetchEnrichedTeamByCode(teamCode);
  }

  public async getTeamByName(teamName: string): Promise<TeamManagementDto | null> {
    return this.fetchEnrichedTeamByName(teamName);
  }

  public async listTeams(filters: TeamListFilters, index: number, limit: number): Promise<TeamListResult> {
    const skip = index * limit;

    const match: FilterQuery<unknown> = {};

    if (filters.search) match.teamName = { $regex: filters.search, $options: "i" };
    if (filters.domain) match.domain = filters.domain;
    if (typeof filters.isActive === "boolean") match.isActive = filters.isActive;

    const pipeline: PipelineStage[] = [
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          meta: [{ $count: "total" }],
          rows: [{ $skip: skip }, { $limit: limit }, ...this.buildTeamUserEnrichmentStages()],
        },
      },
      {
        $addFields: {
          meta: {
            $cond: [{ $gt: [{ $size: "$meta" }, 0] }, "$meta", [{ total: 0 }]],
          },
        },
      },
    ];

    const agg = await TeamManagementModel.aggregate<{ meta: Array<{ total: number }>; rows: TeamManagementDto[] }>(
      pipeline
    ).exec();

    const total = agg?.[0]?.meta?.[0]?.total ?? 0;
    const rows = agg?.[0]?.rows ?? [];

    const pagination: PaginationMeta = { total, index, limit };

    return { rows, pagination };
  }

  // ========================================================================
  // Stats (used for badges; useful for "countsChanged" WS event later)
  // ========================================================================

  public async getAllTeamTotals(): Promise<TeamTotalsResult> {
    const [totalTeams, totalActive, totalInactive] = await Promise.all([
      TeamManagementModel.countDocuments({}).exec(),
      TeamManagementModel.countDocuments({ isActive: true }).exec(),
      TeamManagementModel.countDocuments({ isActive: false }).exec(),
    ]);

    const domainTotals = {} as Record<TeamDomain, number>;
    for (const domain of this.ALLOWED_TEAM_DOMAINS) {
      // eslint-disable-next-line no-await-in-loop
      const countForDomain = await TeamManagementModel.countDocuments({ domain }).exec();
      domainTotals[domain] = countForDomain;
    }

    return { totalTeams, totalActive, totalInactive, domainTotals };
  }

  public async getTeamTotalByDomain(domain: TeamDomain, active?: boolean): Promise<TeamDomainTotalsResult> {
    const activeSpecified = typeof active === "boolean";

    if (activeSpecified) {
      const totalTeams = await TeamManagementModel.countDocuments({ domain, isActive: active }).exec();
      const [totalActive, totalInactive] = await Promise.all([
        TeamManagementModel.countDocuments({ domain, isActive: true }).exec(),
        TeamManagementModel.countDocuments({ domain, isActive: false }).exec(),
      ]);

      return { domain, totalTeams, totalActive, totalInactive };
    }

    const [totalTeams, totalActive, totalInactive] = await Promise.all([
      TeamManagementModel.countDocuments({ domain }).exec(),
      TeamManagementModel.countDocuments({ domain, isActive: true }).exec(),
      TeamManagementModel.countDocuments({ domain, isActive: false }).exec(),
    ]);

    return { domain, totalTeams, totalActive, totalInactive };
  }
}
