// src/models/tracking.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE:
//   1. Track user login sessions (IP + date).
//   2. Track user activity events after login.
//
// STRUCTURE:
//   - LoggedUserTracking: Keeps history of each user’s login IPs and timestamps.
//   - LoggedUserActivities: Records activity events for auditing.
//
// PATTERN: Class-based models (schema + model only, no business logic).
// ─────────────────────────────────────────────────────────────────────────────

import { Schema, model, type Document, type Model } from 'mongoose';

/* ============================================================================
 * 1️⃣ LOGGED USER LOGIN TRACKING
 * ==========================================================================*/

/** TypeScript interface for login records */
export interface ILoggedUserData {
  ip_address: string;
  date: Date;
}

/** TypeScript interface for user login tracking document */
export interface ILoggedUserTracking extends Document {
  username: string;
  data: ILoggedUserData[];
  createdAt: Date;
  updatedAt: Date;
}

/** Class-based builder for LoggedUserTracking schema and model */
export class LoggedUserTrackingModelBuilder {
  /** Build the schema for subdocument (login entries). */
  private static buildSubSchema(): Schema<ILoggedUserData> {
    return new Schema<ILoggedUserData>(
      {
        ip_address: { type: String, required: true, trim: true },
        date: { type: Date, required: true, default: Date.now },
      },
      { _id: false }
    );
  }

  /** Build the main schema for tracking user login sessions. */
  public static buildSchema(): Schema<ILoggedUserTracking> {
    const LoggedUserDataSchema = this.buildSubSchema();

    const LoggedUserTrackingSchema = new Schema<ILoggedUserTracking>(
      {
        username: { type: String, required: true, trim: true, index: true },
        data: { type: [ LoggedUserDataSchema ], default: [] },
      },
      { timestamps: true }
    );

    // Compound index for optimized username+date queries
    LoggedUserTrackingSchema.index( { username: 1, 'data.date': -1 } );

    return LoggedUserTrackingSchema;
  }

  /** Create and return the Mongoose model instance. */
  public static getModel(): Model<ILoggedUserTracking> {
    const schema = this.buildSchema();
    // Explicit collection name: 'logged_user_tracking'
    return model<ILoggedUserTracking>( 'LoggedUserTracking', schema, 'logged_user_tracking' );
  }
}

/** Ready-to-use model export for LoggedUserTracking */
export const TrackingLoggedUserModel = LoggedUserTrackingModelBuilder.getModel();

/* ============================================================================
 * 2️⃣ LOGGED USER ACTIVITY TRACKING
 * ==========================================================================*/

/** TypeScript interface for activity event subdocument */
export interface IUserActivity {
  activity: string;
  timestamp: Date;

  // Optional rich fields for recent feed / categorisation
  kind?: string;
  title?: string;
  refId?: string;
  severity?: string;        // e.g. 'info' | 'success' | 'warning' | 'error'
  sessionId?: string | null;
}

/** TypeScript interface for user activity document */
export interface ILoggedUserActivities extends Document {
  username: string;
  ip_address: string;
  activities: IUserActivity[];
  createdAt: Date;
  updatedAt: Date;
}

/** Class-based builder for LoggedUserActivities schema and model */
export class LoggedUserActivitiesModelBuilder {
  /** Build the sub-schema for individual user activity records. */
  private static buildSubSchema(): Schema<IUserActivity> {
    return new Schema<IUserActivity>(
      {
        activity: { type: String, required: true, trim: true },
        timestamp: { type: Date, default: Date.now },

        kind: { type: String, trim: true },
        title: { type: String, trim: true },
        refId: { type: String, trim: true },
        severity: { type: String, trim: true },
        sessionId: { type: String, trim: true },
      },
      { _id: false }
    );
  }

  /** Build the main schema for tracking user activities. */
  public static buildSchema(): Schema<ILoggedUserActivities> {
    const ActivitySchema = this.buildSubSchema();

    const LoggedUserActivitiesSchema = new Schema<ILoggedUserActivities>(
      {
        username: { type: String, required: true, trim: true, index: true },
        ip_address: { type: String, required: true, trim: true },
        activities: { type: [ ActivitySchema ], default: [] },
      },
      { timestamps: true }
    );

    // Index for faster queries by username and IP
    LoggedUserActivitiesSchema.index( { username: 1, ip_address: 1 } );

    return LoggedUserActivitiesSchema;
  }

  /** Create and return the Mongoose model instance. */
  public static getModel(): Model<ILoggedUserActivities> {
    const schema = this.buildSchema();
    // Explicit collection name: 'logged_user_activities'
    return model<ILoggedUserActivities>( 'LoggedUserActivities', schema, 'logged_user_activities' );
  }
}

/** Ready-to-use model export for LoggedUserActivities */
export const LoggedUserActivitiesModel = LoggedUserActivitiesModelBuilder.getModel();

/* ============================================================================
 * SUMMARY
 * ============================================================================
 * LoggedUserTracking:
 *   - Tracks where and when users log in (IP + timestamp).
 *
 * LoggedUserActivities:
 *   - Tracks what actions users perform during a session, with optional
 *     metadata used by the /recent feed (kind, title, severity, refId, etc.).
 *
 * Together, these provide a full audit trail for PropEase.
 * ============================================================================
 */
