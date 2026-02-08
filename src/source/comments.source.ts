// Path: src/source/comments.source.ts
// ============================================================================
// PropEase — System-wide Comment Engine (Target Registry / Source of Truth)
// ----------------------------------------------------------------------------
// FUTURE-PROOF RULESET
// - A "section" MAY or MAY NOT have subSections.
// - This must NOT be hard-coded (e.g., not "Teams-only").
// - The registry defines:
//     1) Canonical sections
//     2) Canonical subsection sets (per section)
//     3) Optional legacy aliases -> canonical (section/subSection)
//     4) Authoritative mongoose modelName / collection / filePath
// ============================================================================

/* ========================================================================== *
 * 1) CANONICAL SECTION + SUBSECTION TYPES
 * ========================================================================== */

export type CommentSectionKey =
  | "Users"
  | "Properties"
  | "Complaints"
  | "Tenants"
  | "Leases"
  | "Teams";

export const CommentSectionKeyValues: ReadonlyArray<CommentSectionKey> = [
  "Users",
  "Properties",
  "Complaints",
  "Tenants",
  "Leases",
  "Teams",
] as const;

/**
 * SubSections are no longer hard-wired to Teams.
 * We keep a single union for storage/transport, but validation is per-section.
 *
 * Add new subsection domains here in the future.
 */
export type CommentSubSectionKey = "Teams" | "WorkItems" | "Events";
export const LEGACY_SECTION_SET: Set<string> = new Set<string>( [
  'teams',
  'workitems',
  'events'
] );

/* ========================================================================== *
 * 2) REF-ID RULES
 * ========================================================================== */

export interface RefIdRule {
  label: string;
  fieldHint: string;
  example: string;
  regex?: RegExp;
  notes?: string;
}

/* ========================================================================== *
 * 3) TARGET SOURCE ENTRY (one entry = one commentable target)
 * ========================================================================== */

export interface CommentTargetSource {
  section: CommentSectionKey;

  /**
   * Optional sub-section.
   * - Presence/requirement is decided by SECTION RULES, not hard-coded.
   */
  subSection?: CommentSubSectionKey;

  mongooseModelName: string;
  mongoCollectionName: string;
  modelFilePath: string;

  refId: RefIdRule;

  uiRouteTemplate?: string;
  apiRouteTemplate?: string;

  meta?: Record<string, unknown>;
}

/* ========================================================================== *
 * 4) REGISTRY CLASS
 * ========================================================================== */

export interface NormalizedTargetKey {
  section: CommentSectionKey;
  subSection?: CommentSubSectionKey;
}

export interface NormalizedTargetResult {
  section: CommentSectionKey;
  subSection?: CommentSubSectionKey;
  refId: string;
  source: CommentTargetSource;

  /** Derived convenience fields */
  mongooseModelName: string;
  mongoCollectionName: string;
  modelFilePath: string;
}

export class CommentsSourceRegistry {
  // =========================================================================
  // 4.1) SOURCES (canonical, authoritative)
  // =========================================================================

  private static readonly SOURCES: ReadonlyArray<CommentTargetSource> = [
    // Users
    {
      section: "Users",
      mongooseModelName: "User",
      mongoCollectionName: "users",
      modelFilePath: "src/models/user.model.ts",
      refId: {
        label: "Username (recommended business key)",
        fieldHint: "username",
        example: "john_doe",
        regex: /^[a-z0-9._-]{2,64}$/i,
      },
      uiRouteTemplate: "/dashboard/users/user-profile/:refId",
      apiRouteTemplate: "/api-user/:refId",
    },

    // Properties
    {
      section: "Properties",
      mongooseModelName: "Property",
      mongoCollectionName: "properties",
      modelFilePath: "src/models/property.model.ts",
      refId: {
        label: "Property business id",
        fieldHint: "id",
        example: "PROP-MKF8KHPM-3USA3L",
        regex: /^[a-z0-9][a-z0-9._-]{2,80}$/i,
      },
      uiRouteTemplate: "/dashboard/properties/view/:refId",
      apiRouteTemplate: "/api-property/:refId",
    },

    // Complaints
    {
      section: "Complaints",
      mongooseModelName: "Complaint",
      mongoCollectionName: "complaints",
      modelFilePath: "src/models/complaint.model.ts",
      refId: {
        label: "Complaint code",
        fieldHint: "code",
        example: "CMP-2026-000124",
        regex: /^[a-z0-9][a-z0-9._-]{2,80}$/i,
      },
      uiRouteTemplate: "/dashboard/complaints/view/:refId",
      apiRouteTemplate: "/api-complaint/:refId",
    },

    // Tenants
    {
      section: "Tenants",
      mongooseModelName: "Tenant",
      mongoCollectionName: "tenants",
      modelFilePath: "src/models/tenant.model.ts",
      refId: {
        label: "Tenant username",
        fieldHint: "username",
        example: "tenant_sahan",
        regex: /^[a-z0-9._-]{2,64}$/i,
      },
      uiRouteTemplate: "/dashboard/tenants/view/:refId",
      apiRouteTemplate: "/api-tenant/:refId",
    },

    // Leases
    {
      section: "Leases",
      mongooseModelName: "Lease",
      mongoCollectionName: "leases",
      modelFilePath: "src/models/lease.model.ts",
      refId: {
        label: "Lease business id",
        fieldHint: "leaseID",
        example: "LEASE-MKF8KHPM-3USA3L",
        regex: /^[a-z0-9][a-z0-9._-]{2,80}$/i,
      },
      uiRouteTemplate: "/dashboard/leases/view/:refId",
      apiRouteTemplate: "/api-lease/:refId",
    },

    // Teams (TeamManagement entity itself)
    {
      section: "Teams",
      subSection: "Teams",
      mongooseModelName: "TeamManagement",
      mongoCollectionName: "teams",
      modelFilePath: "src/models/teamManagement/teamManagement.model.ts",
      refId: {
        label: "Team code",
        fieldHint: "teamCode",
        example: "TEAM-MKF8KHPM",
        regex: /^[a-z0-9][a-z0-9._-]{2,80}$/i,
      },
    },

    // Teams -> WorkItems
    {
      section: "Teams",
      subSection: "WorkItems",
      mongooseModelName: "WorkItem",
      mongoCollectionName: "work_items",
      modelFilePath: "src/models/teamManagement/workItem.model.ts",
      refId: {
        label: "WorkItem business id",
        fieldHint: "id",
        example: "WORK-2026-000245",
        regex: /^[a-z0-9][a-z0-9._-]{2,80}$/i,
      },
    },

    // Teams -> Events
    {
      section: "Teams",
      subSection: "Events",
      mongooseModelName: "WorkEvent",
      mongoCollectionName: "work_events",
      modelFilePath: "src/models/teamManagement/workEvent.model.ts",
      refId: {
        label: "WorkEvent ObjectId string",
        fieldHint: "_id",
        example: "66b1c2d3e4f5a6b7c8d9e0f1",
        regex: /^[a-f0-9]{24}$/i,
      },
    },
  ] as const;

  // =========================================================================
  // 4.2) SECTION -> SUBSECTION RULES (future-proof)
  // =========================================================================
  /**
   * This is the REAL “rule engine”.
   * Add new sections with subSections here in the future.
   */
  private static readonly SECTION_SUBSECTION_RULES: Readonly<Record<CommentSectionKey, {
    allowSubSection: boolean;
    requireSubSection: boolean;
    allowed?: ReadonlyArray<CommentSubSectionKey>;
  }>> = {
    Users: { allowSubSection: false, requireSubSection: false },
    Properties: { allowSubSection: false, requireSubSection: false },
    Complaints: { allowSubSection: false, requireSubSection: false },
    Tenants: { allowSubSection: false, requireSubSection: false },
    Leases: { allowSubSection: false, requireSubSection: false },

    /**
     * Teams currently requires subSection (your DB rule).
     * Later you can add more section rules similarly, no code rewrite.
     */
    Teams: {
      allowSubSection: true,
      requireSubSection: true,
      allowed: [ "Teams", "WorkItems", "Events" ],
    },
  } as const;

  // =========================================================================
  // 4.3) LEGACY / ALIAS MAPPING (future-proof)
  // =========================================================================
  /**
   * Supports legacy "flat" sections that are now represented as subSections.
   * Example:
   *  - "WorkItems" used to be a section
   *  - now canonical is section="Teams", subSection="WorkItems"
   *
   * Add more legacy mappings here without touching normalization logic.
   */
  private static readonly LEGACY_SECTION_ALIASES: Readonly<Record<string, NormalizedTargetKey>> = {
    workitems: { section: "Teams", subSection: "WorkItems" },
    events: { section: "Teams", subSection: "Events" },
  } as const;

  // =========================================================================
  // 4.4) FAST LOOKUP MAPS
  // =========================================================================

  /** Key format: section or section/subSection */
  private static readonly SOURCE_BY_KEY: ReadonlyMap<string, CommentTargetSource> =
    CommentsSourceRegistry.buildSourceMap();

  /**
   * Your requested “model map”:
   * - key => mongooseModelName
   * This can be used by routers/services for model locking.
   */
  private static readonly MODEL_BY_KEY: ReadonlyMap<string, string> =
    CommentsSourceRegistry.buildModelMap();

  // =========================================================================
  // 4.5) PUBLIC: Lists
  // =========================================================================

  public static getAllSources(): ReadonlyArray<CommentTargetSource> {
    return this.SOURCES;
  }

  public static getAllSections(): ReadonlyArray<CommentSectionKey> {
    return CommentSectionKeyValues;
  }

  public static getModelNameByKey( section: CommentSectionKey, subSection?: CommentSubSectionKey ): string {
    const key = this.buildKey( section, subSection );
    const model = this.MODEL_BY_KEY.get( key );
    if ( !model ) {
      throw new Error( `[Error:] [CommentsSourceRegistry] No model mapping for "${ key }".\n` );
    }
    return model;
  }

  // =========================================================================
  // 4.6) NORMALIZATION (future-proof)
  // =========================================================================

  public static normalizeSection( input: unknown ): CommentSectionKey {
    const raw = String( input ?? "" ).trim();
    if ( !raw ) throw new Error( "[Error:] [CommentsSourceRegistry] section is required.\n" );

    // If input is a legacy alias, map first.
    const alias = this.LEGACY_SECTION_ALIASES[ raw.toLowerCase() ];
    if ( alias ) return alias.section;

    for ( const s of CommentSectionKeyValues ) {
      if ( s.toLowerCase() === raw.toLowerCase() ) return s;
    }

    throw new Error(
      `[Error:] [CommentsSourceRegistry] Invalid section "${ raw }". Allowed: ${ CommentSectionKeyValues.join( ", " ) }\n`,
    );
  }

  /**
   * Normalize (section + subSection) together.
   * This is the single safe entry point.
   *
   * - Supports legacy alias section -> canonical (section/subSection)
   * - Uses SECTION_SUBSECTION_RULES (not hard-coded Teams)
   */
  public static normalizeSectionAndSubSection(
    sectionInput: unknown,
    subSectionInput: unknown,
  ): { section: CommentSectionKey; subSection?: CommentSubSectionKey; } {
    const rawSection = String( sectionInput ?? "" ).trim();
    if ( !rawSection ) throw new Error( "[Error:] [CommentsSourceRegistry] section is required.\n" );

    // 1) legacy alias mapping first
    const alias = this.LEGACY_SECTION_ALIASES[ rawSection.toLowerCase() ];
    if ( alias ) {
      // If caller also sent subSection explicitly, we still allow it ONLY if it matches alias.
      const rawSub = String( subSectionInput ?? "" ).trim();
      if ( rawSub ) {
        if ( !alias.subSection || rawSub.toLowerCase() !== alias.subSection.toLowerCase() ) {
          throw new Error(
            `[Error:] [CommentsSourceRegistry] legacy section "${ rawSection }" cannot use subSection "${ rawSub }".\n`,
          );
        }
      }
      return { section: alias.section, ...( alias.subSection ? { subSection: alias.subSection } : {} ) };
    }

    // 2) canonical section normalize
    const section = this.normalizeSection( rawSection );

    // 3) apply rule-set for subsections
    const rule = this.SECTION_SUBSECTION_RULES[ section ];
    const rawSub = String( subSectionInput ?? "" ).trim();

    if ( !rule.allowSubSection ) {
      // if not allowed, always omit
      if ( rawSub ) {
        throw new Error(
          `[Error:] [CommentsSourceRegistry] subSection is not allowed for section "${ section }".\n`,
        );
      }
      return { section };
    }

    // allowSubSection = true
    if ( rule.requireSubSection && !rawSub ) {
      throw new Error(
        `[Error:] [CommentsSourceRegistry] subSection is required for section "${ section }".\n`,
      );
    }

    if ( !rawSub ) return { section }; // optional case

    const allowed = rule.allowed ?? [];
    for ( const s of allowed ) {
      if ( s.toLowerCase() === rawSub.toLowerCase() ) {
        return { section, subSection: s };
      }
    }

    throw new Error(
      `[Error:] [CommentsSourceRegistry] Invalid subSection "${ rawSub }" for section "${ section }". Allowed: ${ allowed.join( ", " ) }\n`,
    );
  }

  public static normalizeRefId( input: unknown ): string {
    const refId = String( input ?? "" ).trim();
    if ( !refId ) throw new Error( "[Error:] [CommentsSourceRegistry] refId is required.\n" );
    return refId;
  }

  // =========================================================================
  // 4.7) RESOLUTION
  // =========================================================================

  public static resolveSource( sectionInput: unknown, subSectionInput: unknown ): CommentTargetSource {
    const normalized = this.normalizeSectionAndSubSection( sectionInput, subSectionInput );
    const key = this.buildKey( normalized.section, normalized.subSection );
    const source = this.SOURCE_BY_KEY.get( key );

    if ( !source ) {
      throw new Error( `[Error:] [CommentsSourceRegistry] No target source found for "${ key }".\n` );
    }
    return source;
  }

  public static validateTargetOrThrow( target: {
    section: unknown;
    subSection?: unknown;
    refId: unknown;
    module?: unknown;
    scope?: unknown;
  } ): NormalizedTargetResult {
    const normalized = this.normalizeSectionAndSubSection( target.section, target.subSection );
    const refId = this.normalizeRefId( target.refId );

    const key = this.buildKey( normalized.section, normalized.subSection );
    const source = this.SOURCE_BY_KEY.get( key );

    if ( !source ) {
      throw new Error( `[Error:] [CommentsSourceRegistry] Unsupported target "${ key }".\n` );
    }

    if ( source.refId.regex && !source.refId.regex.test( refId ) ) {
      throw new Error(
        `[Error:] [CommentsSourceRegistry] Invalid refId "${ refId }" for ${ key }. Expected: ${ source.refId.label } (field: ${ source.refId.fieldHint }).\n`,
      );
    }

    return {
      section: normalized.section,
      ...( normalized.subSection ? { subSection: normalized.subSection } : {} ),
      refId,
      source,

      mongooseModelName: source.mongooseModelName,
      mongoCollectionName: source.mongoCollectionName,
      modelFilePath: source.modelFilePath,
    };
  }
  // =========================================================================
  // 4.8) INTERNALS
  // =========================================================================

  private static buildKey( section: CommentSectionKey, subSection?: CommentSubSectionKey ): string {
    return subSection ? `${ section }/${ subSection }` : section;
  }

  private static buildSourceMap(): ReadonlyMap<string, CommentTargetSource> {
    const map = new Map<string, CommentTargetSource>();

    for ( const s of this.SOURCES ) {
      const key = this.buildKey( s.section, s.subSection );
      map.set( key, s );
    }

    return map;
  }

  private static buildModelMap(): ReadonlyMap<string, string> {
    const map = new Map<string, string>();

    for ( const s of this.SOURCES ) {
      const key = this.buildKey( s.section, s.subSection );
      map.set( key, s.mongooseModelName );
    }

    return map;
  }
}
