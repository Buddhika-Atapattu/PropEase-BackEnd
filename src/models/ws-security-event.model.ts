// Path: src/models/ws-security-event.model.ts

import {
  Schema,
  model,
  type Document,
  type Model,
} from 'mongoose';
import type { Role } from '../types/roles';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

// High-level categories of WS security events
export type WsSecurityEventType =
  | 'wsTokenAccepted'          // wsToken valid and consumed
  | 'wsTokenInvalidButSafe'    // wsToken invalid, but session+guard still OK
  | 'weTokenInvalidAndSessionAndGuardTokensInvalid' // wsToken invalid and other major tokens also invalid
  | 'wsTokenDenied';           // wsToken invalid AND session/guard invalid → hard disconnect

export interface IWsSecurityEvent extends Document {
  eventType: WsSecurityEventType;

  username?: string;
  role?: Role;

  // Tokens involved (for debugging – do NOT expose to FE)
  sessionToken?: string;
  guardTokenId?: string;   // e.g. ID/UUID for guard-token row
  wsToken?: string;

  socketId?: string;
  ip?: string;
  userAgent?: string | undefined;

  // Optional narrative for admins
  reason?: string;

  // Server timestamps (from { timestamps: true })
  createdAt: Date;
  updatedAt: Date;
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema builder (class-based)
// ──────────────────────────────────────────────────────────────────────────────

class WsSecurityEventModelBuilder {

  private buildSchema(): Schema<IWsSecurityEvent> {
    const schema = new Schema<IWsSecurityEvent>(
      {
        eventType: {
          type: String,
          enum: [ 'wsTokenAccepted', 'wsTokenInvalidButSafe', 'wsTokenDenied', 'weTokenInvalidAndSessionAndGuardTokensInvalid' ],
          required: true,
        },

        username: {
          type: String,
          index: true,
        },

        role: {
          type: String,
        },

        // Sensitive tokens:
        //  - stored for deep forensics
        //  - NOT selected by default (select: false) so normal queries
        //    / admin UIs don't accidentally leak raw tokens.
        sessionToken: {
          type: String,
          select: false,
        },

        guardTokenId: {
          type: String,
          select: false,
        },

        wsToken: {
          type: String,
          select: false,
        },

        socketId: {
          type: String,
        },

        ip: {
          type: String,
        },

        userAgent: {
          type: String,
        },

        reason: {
          type: String,
        },
      },
      {
        timestamps: true,              // createdAt, updatedAt
        collection: 'ws_security_events',
      },
    );

    // Index for “recent events by time”
    schema.index( { createdAt: -1 } );

    // Index for "per user timeline"
    schema.index( { username: 1, createdAt: -1 } );

    return schema;
  }

  public buildModel(): Model<IWsSecurityEvent> {
    const schema = this.buildSchema();
    return model<IWsSecurityEvent>( 'WsSecurityEvent', schema );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Exported model (used by WsSecurityEventLogger service)
// ──────────────────────────────────────────────────────────────────────────────

export const WsSecurityEventModel: Model<IWsSecurityEvent> =
  new WsSecurityEventModelBuilder().buildModel();
