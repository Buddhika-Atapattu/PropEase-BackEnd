// Path: src/socket/events/teamManagement/teamMain/teamManagement.ws.events.ts
// ============================================================================
// Team Management (Main) WebSocket Events (Canonical Source)
// ----------------------------------------------------------------------------
// GOAL
// - Single source of truth for Team Management MAIN event names.
// - Prevent typos by using typed unions + constants.
// - Ensure FE and BE share the same list.
//
// SCOPE (THIS FILE)
// - "team" domain = Team Management MAIN (NOT TeamTask, NOT KPI, NOT WorkItem).
// - Covers CRUD + Single team stream + Advanced list pagination sync.
//
// NAMING CONVENTION
// - Domain prefix: "team"
// - Direction is NOT embedded in the name (same name used both ways).
// - Verbs match service operations.
// ============================================================================

/**
 * TEAM — Client → Server events
 * ---------------------------------------------------------------------------
 * FE uses these events to request actions.
 *
 * NOTE:
 * - For list pagination, FE should send its current query state (filters/sort/page)
 *   and BE can respond with either data (if you support WS list) or a "reloadHint".
 * - If you keep LIST over REST (recommended), you still keep list/subscribe events
 *   to control room membership + count badges + invalidation signals.
 */
export type TeamClientEvent =
  // Subscription / context
  | "team:subscribe"              // join rooms for team list + optional single team
  | "team:unsubscribe"            // leave rooms

  // Reads
  | "team:get"                    // request single team (by teamCode or mongoId)
  | "team:list"                   // request list (advanced pagination) [optional]
  | "team:count"                  // request counts (badges/summary)

  // CRUD
  | "team:create"                 // create team
  | "team:update"                 // update team base fields
  | "team:delete"                 // delete team

  // Atomic operations (match TeamManagement service operations)
  | "team:setStatus"              // active/inactive/etc
  | "team:setCaptain"             // change captain
  | "team:setMembers"             // replace member set (or assign/unassign)
  | "team:setLogo"                // change logo (metadata; file upload usually REST)
  | "team:setTags"                // optional: labels/tags (if your model has it)
  | "team:setNotes";              // optional: internal notes/description updates

/**
 * TEAM — Server → Client events
 * ---------------------------------------------------------------------------
 * BE emits these events to notify FE about state changes.
 * FE should reload via REST or patch state depending on your UI strategy.
 *
 * RECOMMENDED UI STRATEGY
 * - Team list: listen to "team:list:invalidate" and refetch current page via REST.
 * - Team detail: patch from "team:updated" or refetch single team.
 */
export type TeamServerEvent =
  // System
  | "team:ready"                  // server confirms subscription / context ready
  | "team:error"                  // standardized error channel for WS actions

  // Entity lifecycle
  | "team:created"                // team created
  | "team:updated"                // team updated (single)
  | "team:deleted"                // team deleted
  | "team:bulkChanged"            // many teams changed; FE should refetch list

  // List sync (advanced pagination)
  | "team:list:invalidate"        // list potentially stale; FE refetch current page
  | "team:list:delta"             // optional: patch hint (later)

  // Lightweight UI hints (preferred over pushing full lists)
  | "team:reloadHint"             // light “operation completed” hint
  | "team:countsChanged";         // counts changed (sidebar totals/badges)

/**
 * Union of all Team WS event names
 * - Useful for internal typing of emit/on wrappers.
 */
export type TeamWsEvent = TeamClientEvent | TeamServerEvent;

// ----------------------------------------------------------------------------
// Optional: constants (so you can import like TeamWsEvents.Created)
// ----------------------------------------------------------------------------
export class TeamWsEvents {
  // Client → Server
  public static readonly Subscribe: TeamClientEvent = "team:subscribe";
  public static readonly Unsubscribe: TeamClientEvent = "team:unsubscribe";

  public static readonly Get: TeamClientEvent = "team:get";
  public static readonly List: TeamClientEvent = "team:list";
  public static readonly Count: TeamClientEvent = "team:count";

  public static readonly Create: TeamClientEvent = "team:create";
  public static readonly Update: TeamClientEvent = "team:update";
  public static readonly Delete: TeamClientEvent = "team:delete";

  public static readonly SetStatus: TeamClientEvent = "team:setStatus";
  public static readonly SetCaptain: TeamClientEvent = "team:setCaptain";
  public static readonly SetMembers: TeamClientEvent = "team:setMembers";
  public static readonly SetLogo: TeamClientEvent = "team:setLogo";
  public static readonly SetTags: TeamClientEvent = "team:setTags";
  public static readonly SetNotes: TeamClientEvent = "team:setNotes";

  // Server → Client
  public static readonly Ready: TeamServerEvent = "team:ready";
  public static readonly Error: TeamServerEvent = "team:error";

  public static readonly Created: TeamServerEvent = "team:created";
  public static readonly Updated: TeamServerEvent = "team:updated";
  public static readonly Deleted: TeamServerEvent = "team:deleted";
  public static readonly BulkChanged: TeamServerEvent = "team:bulkChanged";

  public static readonly ListInvalidate: TeamServerEvent = "team:list:invalidate";
  public static readonly ListDelta: TeamServerEvent = "team:list:delta";

  public static readonly ReloadHint: TeamServerEvent = "team:reloadHint";
  public static readonly CountsChanged: TeamServerEvent = "team:countsChanged";
}
