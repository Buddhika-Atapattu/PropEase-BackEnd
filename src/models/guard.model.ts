// Path: src/models/guard.model.ts

import {
    Schema,
    model,
    type Document,
    type Model,
    Types
} from 'mongoose';

import type { User } from './user.model';

/**
 * GuardTokenDocument
 * ------------------
 * Binds:
 *   - userId   : primary ref to User._id (ObjectId)
 *   - username : convenience / debug, kept in sync with User.username
 *   - sessionToken      : 30-day token (main, stable-ish)
 *   - guardToken        : current short-lived token
 *   - previousGuardToken: last guard token (for overlap window)
 *   - deviceID          : stable per-device identifier from FE
 *   - expiresAt         : absolute expiry for sessionToken (TTL index)
 *
 * NEW BEHAVIOUR:
 *   - One active guard row per (userId + deviceID)
 *   - Same user may have multiple devices
 *   - Same device may be used by multiple users
 */
export interface GuardTokenDocument extends Document {
    userId: Types.ObjectId;
    username: User[ 'username' ];
    sessionToken: string;
    guardToken: string;
    deviceID: string;
    previousGuardToken?: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

class GuardTokenModelBuilder {
    private buildSchema(): Schema<GuardTokenDocument> {
        const schema = new Schema<GuardTokenDocument>(
            {
                userId: {
                    type: Schema.Types.ObjectId,
                    ref: 'User',
                    required: true
                },
                username: {
                    type: String,
                    required: true,
                    trim: true
                },
                sessionToken: {
                    type: String,
                    required: true,
                    trim: true
                },
                guardToken: {
                    type: String,
                    required: true,
                    trim: true
                },
            deviceID: {
                type: String,
                required: true,
                trim: true
            },
            previousGuardToken: {
                type: String,
                required: false,
                trim: true
            },
            expiresAt: {
                type: Date,
                required: true
            }
        },
        {
            timestamps: true,
            versionKey: false,
            collection: 'guard-tokens'
        }
    );

      // ──────────────────────────────────────────────────────────────
      // Indexes
      // ──────────────────────────────────────────────────────────────

      /**
       * One active guard-token row per (userId + deviceID)
       *
       * This allows:
       *  - Same user on multiple devices → separate rows
       *  - Same device for multiple users → separate rows
       */
      schema.index(
          { userId: 1, deviceID: 1 },
          { unique: true, name: 'uniq_user_device' }
      );

      // Username indexed for convenience (non-unique)
      schema.index( { username: 1 }, { name: 'idx_username' } );

      // Tokens must stay globally unique
      schema.index( { sessionToken: 1 }, { unique: true, name: 'uniq_sessionToken' } );
      schema.index( { guardToken: 1 }, { unique: true, name: 'uniq_guardToken' } );

      // previousGuardToken is unique only when present
      schema.index(
          { previousGuardToken: 1 },
          { unique: true, sparse: true, name: 'uniq_prevGuardToken' }
      );

      // TTL: when expiresAt < now, Mongo removes the document automatically
      schema.index( { expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expiresAt' } );

      return schema;
  }

    public build(): Model<GuardTokenDocument> {
        const schema = this.buildSchema();
        const GuardTokenModel: Model<GuardTokenDocument> =
          model<GuardTokenDocument>( 'GuardToken', schema, 'guard-tokens' );
      return GuardTokenModel;
  }
}

const builder = new GuardTokenModelBuilder();

export const GuardTokenModel: Model<GuardTokenDocument> = builder.build();
