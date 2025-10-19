// src/models/token-map.model.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE: Store temporary tokens (view, email, session) with expiry control.
// PATTERN: Class-based model builder (no direct functions, no business logic).
// TTL INDEX: Automatically deletes documents after `expiresAt` is reached.
// ─────────────────────────────────────────────────────────────────────────────

import {Schema, model, type Document, type Model} from 'mongoose';

/* ============================================================================
 * 1) Interface (TypeScript)
 * ==========================================================================*/
export interface ITokenMap extends Document {
  token: string;                   // Unique token string
  username: string;                // Linked username
  type: 'view' | 'email' | 'session' | string; // Token purpose
  expiresAt: Date;                 // Expiration timestamp
}

/* ============================================================================
 * 2) Class-based Builder
 * ==========================================================================*/
export class TokenMapModelBuilder {
  /** Build and return the schema for token mapping. */
  public static buildSchema(): Schema<ITokenMap> {
    const TokenMapSchema = new Schema<ITokenMap>(
      {
        token: {type: String, required: true, unique: true, trim: true},
        username: {type: String, required: true, trim: true},
        type: {
          type: String,
          enum: ['view', 'email', 'session'],
          required: true,
          default: 'view',
          trim: true,
        },
        expiresAt: {
          type: Date,
          required: true,
          index: {expires: 0}, // TTL index → document auto-deletion
        },
      },
      {
        versionKey: false,
        minimize: true,
      }
    );

    // Optional: Index to quickly find by username and type
    TokenMapSchema.index({username: 1, type: 1});

    return TokenMapSchema;
  }

  /** Create and return the Mongoose model instance. */
  public static getModel(): Model<ITokenMap> {
    const schema = this.buildSchema();
    // Explicit collection name: 'token_map'
    return model<ITokenMap>('TokenMap', schema, 'token_map');
  }
}

/* ============================================================================
 * 3) Export ready-to-use model instance
 * ==========================================================================*/
export const TokenMap = TokenMapModelBuilder.getModel();

/* ============================================================================
 * NOTES:
 *  - Documents in this collection expire automatically via MongoDB TTL index.
 *  - Use this model to store tokens for:
 *      • View-only access links
 *      • Email verification links
 *      • Session tracking / device pairing
 *  - Controllers/services should handle token creation and cleanup logic.
 * ==========================================================================*/
