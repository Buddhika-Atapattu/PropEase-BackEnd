// Path: src/models/mfa-pairing.model.ts

import {
    Schema,
    model,
    type Document,
    type Model,
    Types
} from 'mongoose';

import type { IUser } from './user.model';

/**
 * MfaPairingDocument
 * ------------------
 * Represents a one-time pairing request for multi-auth:
 *  - userId        : reference to User
 *  - username      : snapshot for easier debugging
 *  - pairingToken  : random string encoded into QR
 *  - deviceName    : optional, filled at confirm stage
 *  - devicePlatform: optional, e.g. 'android' | 'ios'
 *  - confirmed     : true once foreign app confirms
 *  - expiresAt     : short TTL (e.g., 5 minutes)
 */
export interface MfaPairingDocument extends Document {
    userId: Types.ObjectId;
    username: IUser[ 'username' ];
    pairingToken: string;
    deviceName?: string;
    devicePlatform?: string;
    confirmed: boolean;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

class MfaPairingModelBuilder {
    private buildSchema(): Schema<MfaPairingDocument> {
        const schema = new Schema<MfaPairingDocument>(
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
                pairingToken: {
                    type: String,
                    required: true,
                    unique: true,
                    trim: true
                },
                deviceName: {
                    type: String,
                    required: false,
                    trim: true
                },
                devicePlatform: {
                    type: String,
                    required: false,
                    trim: true
                },
                confirmed: {
                    type: Boolean,
                    required: true,
                    default: false
                },
                expiresAt: {
                    type: Date,
                    required: true
                }
            },
            {
                timestamps: true,
                versionKey: false,
                collection: 'mfa-pairings'
            }
        );

        // User can have several pending pairings theoretically, but usually only one.
        schema.index( { userId: 1, confirmed: 1 } );

        // QR pairing token must be unique
        schema.index( { pairingToken: 1 }, { unique: true } );

        // TTL: auto-clean expired pairing requests
        schema.index( { expiresAt: 1 }, { expireAfterSeconds: 0 } );

        return schema;
    }

    public build(): Model<MfaPairingDocument> {
        const schema = this.buildSchema();
        const MfaPairingModel: Model<MfaPairingDocument> =
            model<MfaPairingDocument>( 'MfaPairing', schema );
        return MfaPairingModel;
    }
}

const builder = new MfaPairingModelBuilder();

export const MfaPairingModel: Model<MfaPairingDocument> = builder.build();
