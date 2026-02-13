// Path: src/socket/events/teamManagement/memberActivities/memberActivities.ws.events.ts
// ============================================================================
// MemberActivities WebSocket Events (Canonical Source)
// ----------------------------------------------------------------------------
// GOAL
// - Single source of truth for MemberActivity event names.
// - Prevent typos by using typed unions.
// - Keep MemberActivity events separate from WorkItem events (your request).
//
// NAMING CONVENTION
// - Domain prefix: "memberActivity"
// - Direction is NOT embedded in the name.
// - Verbs match MemberActivity service operations (CRUD + evidence + blockers).
// ============================================================================

/**
 * MEMBER ACTIVITY — Client → Server events
 * ---------------------------------------------------------------------------
 * FE uses these events to request actions.
 *
 * NOTE:
 * Even if REST handles writes today, defining these names early prevents
 * future WS drift (same pattern you use across domains).
 */
export type MemberActivityClientEvent =
  | "memberActivity:subscribe"      // join rooms for team / member / workItem activity streams
  | "memberActivity:unsubscribe"
  | "memberActivity:get"
  | "memberActivity:list"
  | "memberActivity:count"

  | "memberActivity:create"
  | "memberActivity:update"
  | "memberActivity:delete"

  // Evidence operations (member uploads evidence for an activity)
  | "memberActivity:appendEvidence"
  | "memberActivity:removeEvidence"
  | "memberActivity:replaceEvidence"

  // Blocker operations
  | "memberActivity:appendBlocker"
  | "memberActivity:updateBlocker"
  | "memberActivity:resolveBlocker"
  | "memberActivity:removeBlocker";

/**
 * MEMBER ACTIVITY — Server → Client events
 * ---------------------------------------------------------------------------
 * BE emits these events to notify FE about state changes.
 */
export type MemberActivityServerEvent =
  | "memberActivity:ready"
  | "memberActivity:error"

  | "memberActivity:created"
  | "memberActivity:updated"
  | "memberActivity:deleted"
  | "memberActivity:bulkChanged"

  // Evidence events
  | "memberActivity:evidenceAppended"
  | "memberActivity:evidenceRemoved"
  | "memberActivity:evidenceReplaced"

  // Blocker events
  | "memberActivity:blockerAppended"
  | "memberActivity:blockerUpdated"
  | "memberActivity:blockerResolved"
  | "memberActivity:blockerRemoved"

  // UI hints / counters
  | "memberActivity:reloadHint"
  | "memberActivity:countsChanged";

/**
 * Union of all MemberActivity WS event names.
 */
export type MemberActivityWsEvent = MemberActivityClientEvent | MemberActivityServerEvent;

// ----------------------------------------------------------------------------
// Optional: constants (so you can import like MemberActivityWsEvents.Created)
// ----------------------------------------------------------------------------
export class MemberActivityWsEvents {
  // Client → Server
  public static readonly Subscribe: MemberActivityClientEvent = "memberActivity:subscribe";
  public static readonly Unsubscribe: MemberActivityClientEvent = "memberActivity:unsubscribe";
  public static readonly Get: MemberActivityClientEvent = "memberActivity:get";
  public static readonly List: MemberActivityClientEvent = "memberActivity:list";
  public static readonly Count: MemberActivityClientEvent = "memberActivity:count";

  public static readonly Create: MemberActivityClientEvent = "memberActivity:create";
  public static readonly Update: MemberActivityClientEvent = "memberActivity:update";
  public static readonly Delete: MemberActivityClientEvent = "memberActivity:delete";

  // Evidence
  public static readonly AppendEvidence: MemberActivityClientEvent = "memberActivity:appendEvidence";
  public static readonly RemoveEvidence: MemberActivityClientEvent = "memberActivity:removeEvidence";
  public static readonly ReplaceEvidence: MemberActivityClientEvent = "memberActivity:replaceEvidence";

  // Blockers
  public static readonly AppendBlocker: MemberActivityClientEvent = "memberActivity:appendBlocker";
  public static readonly UpdateBlocker: MemberActivityClientEvent = "memberActivity:updateBlocker";
  public static readonly ResolveBlocker: MemberActivityClientEvent = "memberActivity:resolveBlocker";
  public static readonly RemoveBlocker: MemberActivityClientEvent = "memberActivity:removeBlocker";

  // Server → Client
  public static readonly Ready: MemberActivityServerEvent = "memberActivity:ready";
  public static readonly Error: MemberActivityServerEvent = "memberActivity:error";

  public static readonly Created: MemberActivityServerEvent = "memberActivity:created";
  public static readonly Updated: MemberActivityServerEvent = "memberActivity:updated";
  public static readonly Deleted: MemberActivityServerEvent = "memberActivity:deleted";
  public static readonly BulkChanged: MemberActivityServerEvent = "memberActivity:bulkChanged";

  // Evidence events
  public static readonly EvidenceAppended: MemberActivityServerEvent = "memberActivity:evidenceAppended";
  public static readonly EvidenceRemoved: MemberActivityServerEvent = "memberActivity:evidenceRemoved";
  public static readonly EvidenceReplaced: MemberActivityServerEvent = "memberActivity:evidenceReplaced";

  // Blocker events
  public static readonly BlockerAppended: MemberActivityServerEvent = "memberActivity:blockerAppended";
  public static readonly BlockerUpdated: MemberActivityServerEvent = "memberActivity:blockerUpdated";
  public static readonly BlockerResolved: MemberActivityServerEvent = "memberActivity:blockerResolved";
  public static readonly BlockerRemoved: MemberActivityServerEvent = "memberActivity:blockerRemoved";

  // UI hints
  public static readonly ReloadHint: MemberActivityServerEvent = "memberActivity:reloadHint";
  public static readonly CountsChanged: MemberActivityServerEvent = "memberActivity:countsChanged";
}
