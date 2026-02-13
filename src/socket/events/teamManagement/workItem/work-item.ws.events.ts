// Path: src/socket/events/teamManagement/workItem/work-item.ws.events.ts
// ============================================================================
// Work Item WebSocket Events (Canonical Source)
// ----------------------------------------------------------------------------
// GOAL
// - Single source of truth for WorkItem event names.
// - Prevent typos by using typed unions.
// - Ensure FE and BE share the same list.
//
// NAMING CONVENTION
// - Domain prefix: "workItem"
// - Direction is NOT embedded in the name (same name used both ways).
// - Use verbs that match your WorkItem service operations.
// ============================================================================

/**
 * WORK ITEM — Client → Server events
 * ---------------------------------------------------------------------------
 * FE uses these events to request actions.
 *
 * NOTE:
 * Even if you do REST for writes today, keeping these names ready is useful
 * for Phase-2 WS actions (same pattern you used for TeamTask).
 */
export type WorkItemClientEvent =
  | "workItem:subscribe" // join rooms for a team / member stream
  | "workItem:unsubscribe"
  | "workItem:get"
  | "workItem:list"
  | "workItem:count"

  | "workItem:create"
  | "workItem:update"
  | "workItem:delete"

  // Atomic operations (match your future WorkItemService methods)
  | "workItem:setStatus"
  | "workItem:setPriority"
  | "workItem:setCaptain"
  | "workItem:setAssignedMembers"
  | "workItem:setDueAt"
  | "workItem:setBlocked"
  | "workItem:appendEvidence"
  | "workItem:removeEvidence"
  | "workItem:appendTag"
  | "workItem:removeTag"

  // Activity stream
  | "workItem:appendActivity";

/**
 * WORK ITEM — Server → Client events
 * ---------------------------------------------------------------------------
 * BE emits these events to notify FE about state changes.
 * FE may patch state or refetch via REST depending on your UI strategy.
 */
export type WorkItemServerEvent =
  | "workItem:ready"
  | "workItem:error"

  | "workItem:created"
  | "workItem:updated"
  | "workItem:deleted"
  | "workItem:bulkChanged"

  // Activity stream
  | "workItem:activityAppended"

  // UI hints
  | "workItem:reloadHint"
  | "workItem:countsChanged";

/**
 * Union of all WorkItem WS event names.
 */
export type WorkItemWsEvent = WorkItemClientEvent | WorkItemServerEvent;

// ----------------------------------------------------------------------------
// Optional: constants (so you can import like WorkItemWsEvents.Created)
// ----------------------------------------------------------------------------
export class WorkItemWsEvents {
  // Client → Server
  public static readonly Subscribe: WorkItemClientEvent = "workItem:subscribe";
  public static readonly Unsubscribe: WorkItemClientEvent = "workItem:unsubscribe";
  public static readonly Get: WorkItemClientEvent = "workItem:get";
  public static readonly List: WorkItemClientEvent = "workItem:list";
  public static readonly Count: WorkItemClientEvent = "workItem:count";

  public static readonly Create: WorkItemClientEvent = "workItem:create";
  public static readonly Update: WorkItemClientEvent = "workItem:update";
  public static readonly Delete: WorkItemClientEvent = "workItem:delete";

  public static readonly SetStatus: WorkItemClientEvent = "workItem:setStatus";
  public static readonly SetPriority: WorkItemClientEvent = "workItem:setPriority";
  public static readonly SetCaptain: WorkItemClientEvent = "workItem:setCaptain";
  public static readonly SetAssignedMembers: WorkItemClientEvent = "workItem:setAssignedMembers";
  public static readonly SetDueAt: WorkItemClientEvent = "workItem:setDueAt";
  public static readonly SetBlocked: WorkItemClientEvent = "workItem:setBlocked";

  public static readonly AppendEvidence: WorkItemClientEvent = "workItem:appendEvidence";
  public static readonly RemoveEvidence: WorkItemClientEvent = "workItem:removeEvidence";

  public static readonly AppendTag: WorkItemClientEvent = "workItem:appendTag";
  public static readonly RemoveTag: WorkItemClientEvent = "workItem:removeTag";

  public static readonly AppendActivity: WorkItemClientEvent = "workItem:appendActivity";

  // Server → Client
  public static readonly Ready: WorkItemServerEvent = "workItem:ready";
  public static readonly Error: WorkItemServerEvent = "workItem:error";

  public static readonly Created: WorkItemServerEvent = "workItem:created";
  public static readonly Updated: WorkItemServerEvent = "workItem:updated";
  public static readonly Deleted: WorkItemServerEvent = "workItem:deleted";
  public static readonly BulkChanged: WorkItemServerEvent = "workItem:bulkChanged";

  public static readonly ActivityAppended: WorkItemServerEvent = "workItem:activityAppended";

  public static readonly ReloadHint: WorkItemServerEvent = "workItem:reloadHint";
  public static readonly CountsChanged: WorkItemServerEvent = "workItem:countsChanged";
}
