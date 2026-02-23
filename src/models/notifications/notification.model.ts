// Path: src/models/notifications/notification.model.ts
// =============================================================================
// Notification Hub — Notification Model (Mongoose)
// -----------------------------------------------------------------------------
// PURPOSE:
// - DB schema ONLY for the base Notification document (no per-user state here)
// - Built strictly according to:
//   src/types/notification/notification.types.ts
//
// IMPORTANT:
// - This model is NOT the "user notification room" model.
// - You already have a user notification model → keep that separate.
// - This model stores:
//   eventKey, category, severity, title, body, icon/tags, target, actor, audiences[],
//   createdAt, expiresAt
//
// RULES:
// - 100% class-based (no loose functions)
// - No business logic or room creation here
// =============================================================================

import { Schema, model, type Document, type Model } from "mongoose";

import type {
  NotificationActorDto,
  NotificationAudience,
  NotificationCategory,
  NotificationEventKey,
  NotificationSeverity,
  NotificationTarget,
} from "../../types/notification/notification.types";
import { NOTIFICATION_ACTION_KEYS } from "../../types/notification/notification-action-keys.catalog";

/* =============================================================================
 * A) Catalog (enums + safe setters only)
 * ========================================================================== */
class NotificationCatalog {
  private constructor () {}

  public static readonly CATEGORY_VALUES: ReadonlyArray<NotificationCategory> = [
    "User",
    "Tenant",
    "Property",
    "Lease",
    "Complaint",
    "Payment",
    "Team",
    "Comment",
    "System",
  ] as const;

  public static readonly SEVERITY_VALUES: ReadonlyArray<NotificationSeverity> = [
    "info",
    "success",
    "warning",
    "error",
  ] as const;

  public static readonly AUDIENCE_MODE_VALUES: ReadonlyArray<
    NotificationAudience[ "mode" ]
  > = [ "Company", "Role", "Team", "User" ] as const;

  /**
   * DB-level sanitation for tags.
   * - Keeps indexes sane
   * - Avoids empty strings / duplicates
   */
  public static sanitizeTags( input: unknown ): string[] {
    if ( !Array.isArray( input ) ) return [];

    const raw = input
      .map( ( x ) => ( typeof x === "string" ? x.trim() : "" ) )
      .filter( ( x ) => x.length > 0 );

    const uniq = Array.from( new Set( raw ) );
    return uniq.map( ( t ) => t.slice( 0, 40 ) ).slice( 0, 20 );
  }

  /**
   * DB default timestamp helper (keeps default function class-based).
   */
  public static now(): Date {
    return new Date();
  }

  /**
   * DB validation helper:
   * - audiences must be an array with at least 1 item
   */
  public static hasAtLeastOneAudience( v: unknown ): boolean {
    return Array.isArray( v ) && v.length >= 1;
  }
}

/* =============================================================================
 * B) Document shape (DB)
 * NOTE:
 * - In DB, store createdAt/expiresAt as Date for correct indexing + range queries.
 * - When building DTOs (NotificationCoreDto), convert Date -> ISO string.
 * ========================================================================== */
export interface NotificationDoc extends Document {
  eventKey: NotificationEventKey;
  category: NotificationCategory;
  severity: NotificationSeverity;

  title: string;
  body: string;

  icon?: string;
  tags?: string[];

  target?: NotificationTarget;

  actor: NotificationActorDto;

  /**
   * ✅ FIX:
   * - Store audiences as an array (even for single target).
   * - This matches your engine rule and WS/query expectations.
   */
  audiences: NotificationAudience[];

  createdAt: Date;
  expiresAt?: Date;
}

/* =============================================================================
 * C) Embedded schema factories (class-based)
 * ========================================================================== */

class NotificationActorSchemaFactory {
  private constructor () {}

  public static build(): Schema<NotificationActorDto> {
    return new Schema<NotificationActorDto>(
      {
        userId: { type: String, required: true, trim: true, index: true },
        username: { type: String, required: true, trim: true, index: true },
        role: { type: String, required: true, trim: true, index: true },

        // Optional scoping hints (store [] rather than null; avoid null pollution)
        teamCodes: { type: [ String ], required: false, default: [], index: true },
        branchId: { type: String, required: false, trim: true, index: true },
      },
      { _id: false }
    );
  }
}

class NotificationAudienceSchemaFactory {
  private constructor () {}

  public static build(): Schema<NotificationAudience> {
    return new Schema<NotificationAudience>(
      {
        mode: {
          type: String,
          required: true,
          enum: NotificationCatalog.AUDIENCE_MODE_VALUES,
          index: true,
        },

        /**
         * Optional keys (only one should exist based on mode).
         * Enforcement belongs to engine validation (NOT DB hooks).
         */
        roleKey: { type: String, required: false, trim: true, index: true },
        teamCode: { type: String, required: false, trim: true, index: true },
        userId: { type: String, required: false, trim: true, index: true },
      },
      { _id: false }
    );
  }
}

class NotificationTargetSchemaFactory {
  private constructor () {}

  public static build(): Schema<NotificationTarget> {
    return new Schema<NotificationTarget>(
      {
        module: { type: String, required: false, trim: true, index: true },
        category: { type: String, required: false, trim: true, index: true },
        refId: { type: String, required: false, trim: true, index: true },
        route: { type: String, required: false, trim: true },
        actionKey: { type: String, enum: NOTIFICATION_ACTION_KEYS, required: false, trim: true },
        params: { type: Schema.Types.Mixed, required: false },
      },
      { _id: false }
    );
  }
}

/* =============================================================================
 * D) Main schema factory (class-based)
 * ========================================================================== */

class NotificationSchemaFactory {
  private constructor () {}

  public static build(): Schema<NotificationDoc> {
    const ActorSchema = NotificationActorSchemaFactory.build();
    const AudienceSchema = NotificationAudienceSchemaFactory.build();
    const TargetSchema = NotificationTargetSchemaFactory.build();

    const schema = new Schema<NotificationDoc>(
      {
        eventKey: { type: String, required: true, trim: true, index: true },

        category: {
          type: String,
          required: true,
          enum: NotificationCatalog.CATEGORY_VALUES,
          index: true,
        },

        severity: {
          type: String,
          required: true,
          enum: NotificationCatalog.SEVERITY_VALUES,
          index: true,
          default: "info",
        },

        title: { type: String, required: true, trim: true },
        body: { type: String, required: true, trim: true },

        icon: { type: String, required: false, trim: true },

        tags: {
          type: [ String ],
          required: false,
          default: [],
          index: true,

          // ✅ class-based setter reference (no inline loose function)
          set: NotificationCatalog.sanitizeTags,
        },

        target: { type: TargetSchema, required: false },

        actor: { type: ActorSchema, required: true },

        /**
         * ✅ FIX:
         * - audiences is an array of embedded audience objects
         * - required (must exist)
         * - default [] to prevent null pollution
         * - validate length >= 1 for safety
         */
        audiences: {
          type: [ AudienceSchema ],
          required: true,
          default: [],
          validate: {
            validator: NotificationCatalog.hasAtLeastOneAudience,
            message: "audiences must contain at least one audience entry",
          },
        },

        // ✅ class-based default reference (no inline loose function)
        createdAt: { type: Date, default: NotificationCatalog.now, index: true },
        expiresAt: { type: Date, required: false, index: true },
      },
      { versionKey: false, minimize: true }
    );

    // Common query accelerators
    schema.index( { createdAt: -1 } );
    schema.index( { category: 1, createdAt: -1 } );
    schema.index( { severity: 1, createdAt: -1 } );
    schema.index( { eventKey: 1, createdAt: -1 } );

    // ✅ Audience filters (array path)
    schema.index( { "audiences.mode": 1, createdAt: -1 } );
    schema.index( { "audiences.roleKey": 1, createdAt: -1 } );
    schema.index( { "audiences.teamCode": 1, createdAt: -1 } );
    schema.index( { "audiences.userId": 1, createdAt: -1 } );

    // Actor filters (audit)
    schema.index( { "actor.userId": 1, createdAt: -1 } );
    schema.index( { "actor.username": 1, createdAt: -1 } );
    schema.index( { "actor.role": 1, createdAt: -1 } );

    // Target filters (entity-centric)
    schema.index( { "target.refId": 1, createdAt: -1 } );

    return schema;
  }
}

/* =============================================================================
 * E) Model export (class-based)
 * ========================================================================== */

class NotificationModelExport {
  private constructor () {}

  public static readonly COLLECTION = "notifications";

  public static build(): Model<NotificationDoc> {
    const schema = NotificationSchemaFactory.build();
    return model<NotificationDoc>( "Notification", schema, this.COLLECTION );
  }
}

export const NotificationModel = NotificationModelExport.build();
