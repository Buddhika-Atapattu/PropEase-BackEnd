// Path: src/socket/events/team-task.ws.events.ts
// ============================================================================
// Team Task WebSocket Events (Canonical Source)
// ----------------------------------------------------------------------------
// GOAL
// - Single source of truth for TeamTask event names.
// - Prevent typos ("task:updated" vs "task:update") by using typed unions.
// - Ensure FE and BE share the same list.
//
// NAMING CONVENTION
// - Domain prefix: "teamTask"
// - Direction is NOT embedded in the name (same name used both ways).
// - Use verbs that match your service operations.
// ============================================================================

/**
 * TEAM TASK — Client → Server events
 * ---------------------------------------------------------------------------
 * FE uses these events to request actions.
 */
export type TeamTaskClientEvent =
  | "teamTask:subscribe"            // join rooms for a team/task stream
  | "teamTask:unsubscribe"          // leave rooms
  | "teamTask:get"                  // request single task
  | "teamTask:list"                 // request list (cursor/page)
  | "teamTask:count"                // request count

  | "teamTask:create"               // create task
  | "teamTask:update"               // update task base fields
  | "teamTask:delete"               // delete task

  // Atomic operations (match service methods)
  | "teamTask:setStatus"
  | "teamTask:setPriority"
  | "teamTask:setCaptain"
  | "teamTask:setAssignedMembers"
  | "teamTask:setDeadlinePolicy"
  | "teamTask:setLabels"
  | "teamTask:setNotes"

  // Evidence operations (if you decide to support via WS)
  | "teamTask:appendEvidence"
  | "teamTask:removeEvidence";

/**
 * TEAM TASK — Server → Client events
 * ---------------------------------------------------------------------------
 * BE emits these events to notify FE about state changes.
 * FE should reload via REST or patch state depending on your UI strategy.
 */
export type TeamTaskServerEvent =
  | "teamTask:ready"                // server confirms subscription / context ready
  | "teamTask:error"                // standardized error channel for WS actions

  | "teamTask:created"              // task created
  | "teamTask:updated"              // task updated (single)
  | "teamTask:deleted"              // task deleted
  | "teamTask:bulkChanged"          // many tasks changed; FE should refetch list

  | "teamTask:reloadHint"           // light “process completed” hint (preferred)
  | "teamTask:countsChanged";       // counts changed (badges, sidebar totals)

/**
 * Union of all TeamTask WS event names
 * - Useful for internal typing of emit/on wrappers.
 */
export type TeamTaskWsEvent = TeamTaskClientEvent | TeamTaskServerEvent;

// ----------------------------------------------------------------------------
// Optional: constants (so you can import like TeamTaskWsEvents.Created)
// ----------------------------------------------------------------------------
export class TeamTaskWsEvents {
  // Client → Server
  public static readonly Subscribe: TeamTaskClientEvent = "teamTask:subscribe";
  public static readonly Unsubscribe: TeamTaskClientEvent = "teamTask:unsubscribe";
  public static readonly Get: TeamTaskClientEvent = "teamTask:get";
  public static readonly List: TeamTaskClientEvent = "teamTask:list";
  public static readonly Count: TeamTaskClientEvent = "teamTask:count";

  public static readonly Create: TeamTaskClientEvent = "teamTask:create";
  public static readonly Update: TeamTaskClientEvent = "teamTask:update";
  public static readonly Delete: TeamTaskClientEvent = "teamTask:delete";

  public static readonly SetStatus: TeamTaskClientEvent = "teamTask:setStatus";
  public static readonly SetPriority: TeamTaskClientEvent = "teamTask:setPriority";
  public static readonly SetCaptain: TeamTaskClientEvent = "teamTask:setCaptain";
  public static readonly SetAssignedMembers: TeamTaskClientEvent = "teamTask:setAssignedMembers";
  public static readonly SetDeadlinePolicy: TeamTaskClientEvent = "teamTask:setDeadlinePolicy";
  public static readonly SetLabels: TeamTaskClientEvent = "teamTask:setLabels";
  public static readonly SetNotes: TeamTaskClientEvent = "teamTask:setNotes";

  public static readonly AppendEvidence: TeamTaskClientEvent = "teamTask:appendEvidence";
  public static readonly RemoveEvidence: TeamTaskClientEvent = "teamTask:removeEvidence";

  // Server → Client
  public static readonly Ready: TeamTaskServerEvent = "teamTask:ready";
  public static readonly Error: TeamTaskServerEvent = "teamTask:error";

  public static readonly Created: TeamTaskServerEvent = "teamTask:created";
  public static readonly Updated: TeamTaskServerEvent = "teamTask:updated";
  public static readonly Deleted: TeamTaskServerEvent = "teamTask:deleted";
  public static readonly BulkChanged: TeamTaskServerEvent = "teamTask:bulkChanged";

  public static readonly ReloadHint: TeamTaskServerEvent = "teamTask:reloadHint";
  public static readonly CountsChanged: TeamTaskServerEvent = "teamTask:countsChanged";
}
