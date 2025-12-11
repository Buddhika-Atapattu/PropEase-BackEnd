// Path: src/models/mfa/mfa-login-challenge.model.ts
import {
    Schema,
    model,
    type Document,
    type Model,
    Types,
} from 'mongoose';

import type { IUser } from '../user.model';

/**
 * MfaLoginChallengeDocument
 * -------------------------
 * Short-lived login challenge created AFTER password verification.
 *
 * Flow:
 *  - /auth/login (password correct, multiAuthEnabled=true) =>
 *       creates MfaLoginChallenge with random `token`.
 *  - FE receives `mfaToken` and uses it in /mfa/user-verify with TOTP code.
 *
 * Cleanup:
 *  - TTL index on `expiresAt`: MongoDB auto-removes expired challenges.
 *  - We also have `used` + `usedAt` to distinguish consumed vs just expired.
 */
export interface MfaLoginChallengeDocument extends Document {
    userId: Types.ObjectId;
    username: IUser[ 'username' ];

    token: string;          // random challenge token given to FE
    createdAt: Date;
    expiresAt: Date;
    used: boolean;
    usedAt?: Date | null;   // null/undefined = never used, Date = consumed time

    ipAddress?: string;
    userAgent?: string;
}

class MfaLoginChallengeModelBuilder {

    private buildSchema(): Schema<MfaLoginChallengeDocument> {
        const schema = new Schema<MfaLoginChallengeDocument>(
            {
                userId: {
                    type: Schema.Types.ObjectId,
                    ref: 'User',
                    required: true,
                    index: true,
                },
                username: {
                    type: String,
                    required: true,
                    index: true,
                    trim: true,
                },
                token: {
                    type: String,
                    required: true,
                    trim: true,
                },
                createdAt: {
                    type: Date,
                    required: true,
                    default: () => new Date(),
                },
                expiresAt: {
                    type: Date,
                    required: true,
                },
                used: {
                    type: Boolean,
                    required: true,
                    default: false,
                },
                usedAt: {
                    type: Date,
                    default: null,
                },
                ipAddress: {
                    type: String,
                    trim: true,
                },
                userAgent: {
                    type: String,
                    trim: true,
                },
            },
            {
                collection: 'mfa_login_challenges',
            },
        );

        // -----------------------------------------------------------------------
        // Index strategy
        // -----------------------------------------------------------------------

        // 1) Unique token so a given challenge token identifies exactly one doc.
        schema.index( { token: 1 }, { unique: true } );

        // 2) Compound index for the "active, not-expired" query:
        //    we usually query by token + used=false + expiresAt>$now.
        schema.index( { token: 1, used: 1, expiresAt: 1 } );

        // 3) TTL: auto-remove expired challenges.
        //    - Once expiresAt < now, document is removed.
        //    - Works for both used and unused challenges.
        //    - If you ever want to keep used challenges for audit, remove this TTL
        //      and run a scheduled cleanup based on usedAt instead.
        schema.index( { expiresAt: 1 }, { expireAfterSeconds: 0 } );

        // 4) Optional helper index: all challenges per user ordered by time.
        //    Useful if you ever need to inspect history.
        schema.index( { userId: 1, createdAt: -1 } );

        return schema;
    }

    public buildModel(): Model<MfaLoginChallengeDocument> {
        return model<MfaLoginChallengeDocument>(
            'MfaLoginChallenge',
            this.buildSchema(),
        );
    }
}

export const MfaLoginChallengeModel: Model<MfaLoginChallengeDocument> =
    new MfaLoginChallengeModelBuilder().buildModel();
