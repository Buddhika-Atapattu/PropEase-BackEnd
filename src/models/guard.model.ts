// Path: src/models/guard.model.ts

import {
    Schema,
    model,
    type Document,
    type Model,
    Types,
} from 'mongoose';

import type { User } from './user.model';

/**
 * GuardTokenDocument
 * ------------------
 * One active guard row per (userId + deviceID).
 * TTL on expiresAt removes whole row when session expires.
 */
export interface GuardTokenDocument extends Document {
    userId: Types.ObjectId;
    username: User[ 'username' ];

    sessionToken: string;
    guardToken: string;

    deviceID: string;

    previousGuardToken?: string;
    previousGuardTokenExpiresAt?: Date; // ✅ Date

    expiresAt: Date; // ✅ TTL index lives here

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
                required: true,
            },
            username: {
                type: String,
                required: true,
                trim: true,
            },

            sessionToken: {
                type: String,
                required: true,
                trim: true,
            },
            guardToken: {
                type: String,
                required: true,
                trim: true,
            },

            deviceID: {
                type: String,
                required: true,
                trim: true,
            },

            previousGuardToken: {
                type: String,
                required: false,
                trim: true,
                default: undefined, // ✅ ensure not stored when missing
            },

            // ✅ MUST be Date (not String)
            previousGuardTokenExpiresAt: {
                type: Date,
                required: false,
                default: undefined, // ✅ ensure not stored when missing
            },

            expiresAt: {
                type: Date,
                required: true,
            },
        },
        {
            timestamps: true,
            versionKey: false,
            collection: 'guard-tokens',
        },
    );

      // ──────────────────────────────────────────────────────────────
      // Indexes
      // ──────────────────────────────────────────────────────────────

      // One active session row per (userId + deviceID)
      schema.index(
          { userId: 1, deviceID: 1 },
        { unique: true, name: 'uniq_user_device' },
    );

      schema.index( { username: 1 }, { name: 'idx_username' } );

      // Tokens globally unique
      schema.index(
          { sessionToken: 1 },
          { unique: true, name: 'uniq_sessionToken' },
      );
      schema.index( { guardToken: 1 }, { unique: true, name: 'uniq_guardToken' } );

      // previousGuardToken unique only when present
      schema.index(
          { previousGuardToken: 1 },
        { unique: true, sparse: true, name: 'uniq_prevGuardToken' },
    );

      // TTL: remove row when session expires
      schema.index(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: 'ttl_expiresAt' },
      );

      // Optional (not required): helpful for diagnostics / potential cleanup queries
      schema.index(
          { previousGuardTokenExpiresAt: 1 },
          { name: 'idx_prevGuardTokenExpiresAt' },
      );

      return schema;
  }

    public build(): Model<GuardTokenDocument> {
        const schema = this.buildSchema();
      return model<GuardTokenDocument>( 'GuardToken', schema, 'guard-tokens' );
  }
}

const builder = new GuardTokenModelBuilder();
export const GuardTokenModel: Model<GuardTokenDocument> = builder.build();
