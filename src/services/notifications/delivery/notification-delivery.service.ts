// Path: src/services/notifications/delivery/notification-delivery.service.ts
// =============================================================================
// Notification Delivery — Orchestrator Service
// =============================================================================
//
// 01) Purpose of this code
// -----------------------------------------------------------------------------
// - Executes all enabled drivers for ONE notification delivery request.
// - Aggregates results into a single delivery report that can be stored/logged.
//
// 02) What this code is managing
// -----------------------------------------------------------------------------
// - Driver execution order
// - Per-notification channel enable flags (req.drivers)
// - Best-effort execution (continue even if one driver fails)
// - Result aggregation (attempted/delivered/failed totals)
//
// 03) Key things this code highlights
// -----------------------------------------------------------------------------
// - Does NOT throw on driver errors (by design)
//   -> returns "failed" result instead, while continuing other drivers
// - Strict typing, class-based only
// - Channel enable logic is centralized and explicit (easy to audit)
//
// 04) Need to keep in mind
// -----------------------------------------------------------------------------
// - This service assumes NotificationDeliveryDriverRegistry exists and returns drivers.
// - “Enabled” is two-layer:
//    (A) Driver is globally enabled (driver.isEnabled())
//    (B) Channel is enabled for this notification (req.drivers.<channel>)
// - Later you can add retries, DLQ, backoff, and persistence of delivery logs.
// =============================================================================

import type {
  NotificationDeliveryRequest,
  NotificationDeliveryResult,
  DeliveryAttemptResult,
  DeliveryChannel,
  NotificationDeliveryDriver,
} from "./notification-delivery.types";

import { NotificationDeliveryDriverRegistry } from "./notification-delivery.registry.service";
import type { ClientSession } from "mongoose";
import { UserModel } from "../../../models/user.model";
import { MongoIdUtil } from "../../../utils/mongo-id.util";

export class NotificationDeliveryService {
  public constructor () {}

  /* ===========================================================================
   * Method: deliver()
   * ===========================================================================
   * 01) Why this method
   * - This is the single entrypoint used by the Hub Engine after persistence.
   * - It runs all registered delivery drivers in a controlled best-effort manner.
   *
   * 02) How to use this method
   * - Called by NotificationHubEngineService.emit():
   *     await this.delivery.deliver({
   *       notificationId,
   *       notification,
   *       recipients,
   *       drivers,
   *     })
   *
   * 03) Parameters to pass and why
   * - req: NotificationDeliveryRequest
   *    - notificationId : identifies the master notification
   *    - notification   : canonical NotificationCoreDto used by drivers
   *    - recipients     : resolved identities (usernames, optional contacts)
   *    - drivers        : per-notification channel flags (audit/email/sms/...)
   *
   * 04) Linkage and return
   * - Uses NotificationDeliveryDriverRegistry.listEnabled()
   * - Runs each driver:
   *    - if channel disabled => "skipped"
   *    - else driver.deliver(req) => "delivered/failed"
   * - Returns aggregated NotificationDeliveryResult
   * ========================================================================= */
  public async deliver( req: NotificationDeliveryRequest ): Promise<NotificationDeliveryResult> {
    // -------------------------------------------------------------------------
    // 1) Basic safety
    // -------------------------------------------------------------------------
    if ( !req ) {
      return this.summarize( "", [
        {
          channel: "audit",
          status: "failed",
          attempted: 0,
          delivered: 0,
          failed: 0,
          errorMessage: "NotificationDeliveryService.deliver: request is missing",
        },
      ] );
    }

    const notificationId = typeof req.notificationId === "string" ? req.notificationId.trim() : "";
    const recipients = Array.isArray( req.recipients ) ? req.recipients : [];

    // -------------------------------------------------------------------------
    // 2) Load globally enabled drivers (registry-level enable)
    // -------------------------------------------------------------------------
    const drivers: NotificationDeliveryDriver[] = NotificationDeliveryDriverRegistry.listEnabled();

    // -------------------------------------------------------------------------
    // 3) Execute drivers (best-effort)
    // -------------------------------------------------------------------------
    const results: DeliveryAttemptResult[] = [];

    for ( const d of drivers ) {
      const channel = d.channel();

      try {
        // 3.1) Per-notification channel flag check (request-level enable)
        if ( !this.isChannelEnabled( req, channel ) ) {
          results.push( this.asSkipped( channel ) );
          continue;
        }

        // 3.2) If there are zero recipients, driver should skip
        //      (but we also handle it here so every driver behaves consistently)
        if ( recipients.length === 0 ) {
          results.push( {
            channel,
            status: "skipped",
            attempted: 0,
            delivered: 0,
            failed: 0,
            errorMessage: "No recipients",
          } );
          continue;
        }

        // 3.3) Run driver
        const r = await d.deliver( req );
        results.push( r );
      } catch ( err: unknown ) {
        // We DO NOT throw, we record failure and continue others.
        results.push( this.asDriverFailure( channel, recipients.length, err ) );
      }
    }

    // -------------------------------------------------------------------------
    // 4) Summarize totals
    // -------------------------------------------------------------------------
    return this.summarize( notificationId, results );
  }


  private async findUserIdByUsernameOrThrow(
    username: string,
    session?: ClientSession
  ): Promise<string> {
    const uname = typeof username === "string" ? username.trim() : "";
    if ( !uname ) {
      throw new Error( "Invalid username." );
    }

    const doc = await UserModel.findOne(
      { username: uname },
      { _id: 1 },
      session ? { session } : undefined
    )
      .lean()
      .exec();

    if ( !doc?._id ) {
      throw new Error( `User not found for username: ${ uname }` );
    }

    return MongoIdUtil.toIdString( doc._id );
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  private summarize( notificationId: string, results: DeliveryAttemptResult[] ): NotificationDeliveryResult {
    /**
     * 01) Why this method
     * - Aggregates results from all drivers into totals.
     *
     * 02) How to use
     * - Called internally by deliver()
     *
     * 03) Parameters
     * - notificationId: master notification id
     * - results: driver results
     *
     * 04) Return
     * - NotificationDeliveryResult with totals
     */
    let attemptedTotal = 0;
    let deliveredTotal = 0;
    let failedTotal = 0;

    const list = Array.isArray( results ) ? results : [];
    for ( const r of list ) {
      attemptedTotal += Number( r.attempted ?? 0 );
      deliveredTotal += Number( r.delivered ?? 0 );
      failedTotal += Number( r.failed ?? 0 );
    }

    return {
      notificationId,
      results: list,
      other: { attemptedTotal, deliveredTotal, failedTotal },
    };
  }

  private asSkipped( channel: DeliveryChannel ): DeliveryAttemptResult {
    /**
     * 01) Why this method
     * - Standard “skipped” result shape for disabled channels.
     */
    return {
      channel,
      status: "skipped",
      attempted: 0,
      delivered: 0,
      failed: 0,
    };
  }

  private asDriverFailure( channel: DeliveryChannel, attempted: number, err: unknown ): DeliveryAttemptResult {
    /**
     * 01) Why this method
     * - Normalizes any driver exception into a consistent failure result.
     *
     * 02) How it works
     * - attempted = recipients.length (how many we tried to deliver)
     * - delivered = 0
     * - failed = attempted
     */
    const msg = err instanceof Error ? err.message : "Unknown driver error";
    return {
      channel,
      status: "failed",
      attempted,
      delivered: 0,
      failed: attempted,
      errorMessage: msg,
    };
  }

  private isChannelEnabled( req: NotificationDeliveryRequest, channel: DeliveryChannel ): boolean {
    /**
     * 01) Why this method
     * - Enforces per-notification delivery switches.
     * - Keeps channel logic centralized and auditable.
     *
     * 02) How to use
     * - Called before executing each driver.
     *
     * 03) Parameters
     * - req: NotificationDeliveryRequest (contains req.drivers)
     * - channel: which driver channel is being checked
     *
     * 04) Return
     * - true if enabled, false if disabled
     */
    const d = req.drivers;

    // Safety if drivers object is missing (should not happen if hub normalizes)
    if ( !d ) return false;

    if ( channel === "audit" ) return !!d.audit;
    if ( channel === "email" ) return !!d.email;
    if ( channel === "external" ) return !!d.external;
    if ( channel === "mq" ) return !!d.mq;
    if ( channel === "push" ) return !!d.push;
    if ( channel === "sms" ) return !!d.sms;

    return false;
  }
}
