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
 *   - expiresAt         : absolute expiry for sessionToken (TTL index)
 */
export interface GuardTokenDocument extends Document {
    userId: Types.ObjectId;
    username: User[ 'username' ];
    sessionToken: string;
    guardToken: string;
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

        // One active session per user (adjust if you want multi-device later)
        schema.index( { userId: 1 }, { unique: true } );

        // Username is unique in user collection, but we may allow multiple sessions
        // For now, just index for fast lookups (non-unique).
        schema.index( { username: 1 } );

        // Tokens must be unique across docs
        schema.index( { sessionToken: 1 }, { unique: true } );
        schema.index( { guardToken: 1 }, { unique: true } );
        schema.index( { previousGuardToken: 1 }, { unique: true, sparse: true } );

        // TTL: when expiresAt < now, Mongo will remove the document automatically
        schema.index( { expiresAt: 1 }, { expireAfterSeconds: 0 } );

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
