// Path: src/socket/events/teamManagement/milestones/milestone.ws.events.ts
// ============================================================================
// Milestone WebSocket Events (Canonical Source)
// ----------------------------------------------------------------------------
// GOAL
// - Single source of truth for Milestone event names.
// - Prevent typos by using typed unions.
// - Keep Milestone events separate from WorkItem + MemberActivity (your request).
//
// NAMING CONVENTION
// - Domain prefix: "milestone"
// - Direction is NOT embedded in the name.
// - Verbs match Milestone service operations (CRUD + evidence + tags + status).
// ============================================================================

/**
 * MILESTONE — Client → Server events
 * ---------------------------------------------------------------------------
 * FE uses these events to request actions.
 *
 * NOTE:
 * Even if REST handles writes today, defining these names early prevents
 * WS drift later (same pattern you use across domains).
 */
export type MilestoneClientEvent =
  | "milestone:subscribe" // join rooms for team / member / workItem milestone streams
  | "milestone:unsubscribe"
  | "milestone:get"
  | "milestone:list"
  | "milestone:count"

  | "milestone:create"
  | "milestone:update"
  | "milestone:delete"

  // Atomic operations (match future MilestoneRestService methods)
  | "milestone:setStatus"
  | "milestone:setPriority"
  | "milestone:setSchedule" // startAt/endAt/allDay/timezone
  | "milestone:setProgressTarget"

  // Evidence operations
  | "milestone:appendEvidence"
  | "milestone:removeEvidence"
  | "milestone:replaceEvidence"

  // Tags
  | "milestone:appendTag"
  | "milestone:removeTag"
  | "milestone:replaceTags";

/**
 * MILESTONE — Server → Client events
 * ---------------------------------------------------------------------------
 * BE emits these events to notify FE about state changes.
 */
export type MilestoneServerEvent =
  | "milestone:ready"
  | "milestone:error"

  | "milestone:created"
  | "milestone:updated"
  | "milestone:deleted"
  | "milestone:bulkChanged"

  // Evidence events
  | "milestone:evidenceAppended"
  | "milestone:evidenceRemoved"
  | "milestone:evidenceReplaced"

  // Tag events
  | "milestone:tagAppended"
  | "milestone:tagRemoved"
  | "milestone:tagsReplaced"

  // UI hints / counters
  | "milestone:reloadHint"
  | "milestone:countsChanged";

/**
 * Union of all Milestone WS event names.
 */
export type MilestoneWsEvent = MilestoneClientEvent | MilestoneServerEvent;

// ----------------------------------------------------------------------------
// Optional: constants (so you can import like MilestoneWsEvents.Created)
// ----------------------------------------------------------------------------
export class MilestoneWsEvents {
  // Client → Server
  public static readonly Subscribe: MilestoneClientEvent = "milestone:subscribe";
  public static readonly Unsubscribe: MilestoneClientEvent = "milestone:unsubscribe";
  public static readonly Get: MilestoneClientEvent = "milestone:get";
  public static readonly List: MilestoneClientEvent = "milestone:list";
  public static readonly Count: MilestoneClientEvent = "milestone:count";

  public static readonly Create: MilestoneClientEvent = "milestone:create";
  public static readonly Update: MilestoneClientEvent = "milestone:update";
  public static readonly Delete: MilestoneClientEvent = "milestone:delete";

  // Atomic ops
  public static readonly SetStatus: MilestoneClientEvent = "milestone:setStatus";
  public static readonly SetPriority: MilestoneClientEvent = "milestone:setPriority";
  public static readonly SetSchedule: MilestoneClientEvent = "milestone:setSchedule";
  public static readonly SetProgressTarget: MilestoneClientEvent = "milestone:setProgressTarget";

  // Evidence
  public static readonly AppendEvidence: MilestoneClientEvent = "milestone:appendEvidence";
  public static readonly RemoveEvidence: MilestoneClientEvent = "milestone:removeEvidence";
  public static readonly ReplaceEvidence: MilestoneClientEvent = "milestone:replaceEvidence";

  // Tags
  public static readonly AppendTag: MilestoneClientEvent = "milestone:appendTag";
  public static readonly RemoveTag: MilestoneClientEvent = "milestone:removeTag";
  public static readonly ReplaceTags: MilestoneClientEvent = "milestone:replaceTags";

  // Server → Client
  public static readonly Ready: MilestoneServerEvent = "milestone:ready";
  public static readonly Error: MilestoneServerEvent = "milestone:error";

  public static readonly Created: MilestoneServerEvent = "milestone:created";
  public static readonly Updated: MilestoneServerEvent = "milestone:updated";
  public static readonly Deleted: MilestoneServerEvent = "milestone:deleted";
  public static readonly BulkChanged: MilestoneServerEvent = "milestone:bulkChanged";

  // Evidence events
  public static readonly EvidenceAppended: MilestoneServerEvent = "milestone:evidenceAppended";
  public static readonly EvidenceRemoved: MilestoneServerEvent = "milestone:evidenceRemoved";
  public static readonly EvidenceReplaced: MilestoneServerEvent = "milestone:evidenceReplaced";

  // Tag events
  public static readonly TagAppended: MilestoneServerEvent = "milestone:tagAppended";
  public static readonly TagRemoved: MilestoneServerEvent = "milestone:tagRemoved";
  public static readonly TagsReplaced: MilestoneServerEvent = "milestone:tagsReplaced";

  // UI hints
  public static readonly ReloadHint: MilestoneServerEvent = "milestone:reloadHint";
  public static readonly CountsChanged: MilestoneServerEvent = "milestone:countsChanged";
}
