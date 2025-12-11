// Path: src/controller/mfa.controller.ts
// ============================================================================
// Multi-Factor Authentication (MFA) Controller (class-based)
// ----------------------------------------------------------------------------
// Responsibilities:
//   - Initiate MFA pairing → generate QR (TOTP URI → QR PNG data URL)
//   - Confirm pairing from foreign app (mobile MFA app)
//   - Poll pairing status by token
//   - Deactivate multi-auth for a given username
//   - Verify initial pairing code (pairingToken + code)
//   - Verify user code for login flow
//
// STYLE NOTES:
//   - All handlers return Promise<void> with explicit ApiResponseBuilder usage.
//   - No passwords are ever returned to the client.
//   - All input is trimmed via small helper methods.
// ============================================================================

import {
    Router,
    type Request,
    type Response,
} from 'express';

import QRCode from 'qrcode';

import { ApiResponseBuilder } from '../utils/api-combiner.builder';
import { UserModel, type IUser, type User } from '../models/user.model';
import { MfaService } from '../services/mfa.service';
import { MfaPairingDocument } from '../models/mfa/mfa-pairing.model';
import { GuardTokenService } from '../services/guard-token.service';
import { WsTokenRegistryProvider } from '../services/ws-service//ws-token-registry.provider.service';
import type { MfaStrength, WsTokenRecord } from '../types/ws-token.types';

// ──────────────────────────────────────────────────────────────────────────────
// Request body types (for better clarity/typing)
// ──────────────────────────────────────────────────────────────────────────────

interface InitiateMultiAuthBody {
    username?: string;
}

interface ConfirmMultiAuthBody {
    pairingToken?: string;
    deviceName?: string;
    devicePlatform?: string;
}

interface InitialVerifyBody {
    pairingToken?: string;
    code?: string;
}

interface UserVerifyBody {
    token?: string;
    code?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Controller
// ──────────────────────────────────────────────────────────────────────────────

/**
 * MfaController
 * -------------
 * Base route (mount point): /api/mfa
 *
 * Endpoints:
 *   POST   /initiate        → generate QR + pairingToken
 *   POST   /confirm         → confirm pairing, enable multifactor
 *   POST   /activate        → alias of /confirm (backwards compatibility)
 *   GET    /status/:token   → polling endpoint for pairing status
 *   POST   /deactive/:user  → deactivate multi-auth for a username
 *   POST   /initial-verify  → verify initial code with pairing token
 *   POST   /user-verify     → verify user TOTP code by username
 */
export class MfaController {
    private readonly router: Router;
    private readonly mfaService: MfaService;
    private readonly guardTokenService: GuardTokenService;

    // Optional central TTL for Redis-backed wsTokens (seconds)
    private readonly wsTokenTtlSeconds: number = 300;

    public constructor () {
        this.router = Router();
        this.mfaService = new MfaService();
        this.guardTokenService = new GuardTokenService();
        this.registerRoutes();
    }

    public getRouter(): Router {
        return this.router;
    }

    // ────────────────────────────────────────────────────────────────────────────
    // Route registration
    // ────────────────────────────────────────────────────────────────────────────

    private registerRoutes(): void {
        // Initial QR generation (web → backend)
        this.router.post(
            '/initiate',
            this.initiateMultiAuth.bind( this ),
        );

        // Confirmation after scan (foreign app → backend)
        this.router.post(
            '/confirm',
          this.confirmMultiAuth.bind( this ),
      );

        // Optional: alias for backward compatibility
        this.router.post(
            '/activate',
          this.confirmMultiAuth.bind( this ),
      );

        // Status check (for polling from FE)
        this.router.get(
            '/status/:pairingToken',
            this.getPairingStatus.bind( this ),
        );

        // Disable multi-auth for a user
        this.router.post(
            '/deactive/:username',
            this.deactivateMultiAuth.bind( this ),
        );

        // Initial verify (pairing token + code)
        this.router.post(
            '/initial-verify',
            this.initialVerify.bind( this ),
        );

        // User verify (username + TOTP code)
        this.router.post(
            '/user-verify',
            this.userVerify.bind( this ),
        );
    }

    // ────────────────────────────────────────────────────────────────────────────
    // Small helpers
    // ────────────────────────────────────────────────────────────────────────────

    /**
     * Normalises unknown input into a trimmed string. Returns empty string if
     * value is not a string.
     */
    private sanitizeString( value: unknown ): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    /**
     * Builds a safe user payload (never exposing sensitive fields like password).
     */
    private buildSafeUserPayload( user: User | null ): User | null {
        if ( !user ) {
            return null;
        }

        const plain: any = ( typeof ( user as any ).toObject === 'function' )
            ? ( user as any ).toObject()
            : user;

        // Explicitly omit password and other sensitive fields if present
        const {
            password,
            resetToken,
            resetTokenExpiresAt,
            // add more sensitive fields here if needed
            ...safeUser
        } = plain;

        return safeUser;
    }

    /**
     * Builds a safe pairing payload, in case the document contains confidential
     * fields like multiAuthSecret.
     */
    private buildSafePairingPayload( pairing: MfaPairingDocument ): Record<string, unknown> {
        const plain: any = ( typeof ( pairing as any ).toObject === 'function' )
            ? ( pairing as any ).toObject()
            : pairing;

        const {
            multiAuthSecret, // not exposed to client
            __v,
            ...safePairing
        } = plain;

        return safePairing;
    }

    /**
     * Issue a Redis-backed wsToken for MFA login success (TOTP).
     * Uses sessionToken as the logical "sessionId" in Redis.
     */
    private async issueWsTokenForResponse(
        user: IUser,
        sessionId: string,
        mfaStrength: MfaStrength,
        req: Request,
    ): Promise<WsTokenRecord> {
        const registry = await WsTokenRegistryProvider.getInstance();

        const ip: string | undefined = req.ip ?? undefined;
        const userAgent: string | undefined = req.get( "user-agent" ) ?? undefined;

        const record: WsTokenRecord = await registry.issueTokenForUser(
            user,
            sessionId,
            mfaStrength,
            ip,
            userAgent,
            this.wsTokenTtlSeconds,
        );

        return record;
    }

    // ────────────────────────────────────────────────────────────────────────────
    // Handlers
    // ────────────────────────────────────────────────────────────────────────────

  /**
   * initiateMultiAuth
   * -----------------
   * Body:
   *   { username: string }
   *
   * In a fully locked-down system this would usually derive the user
   * from the session (auth middleware) and not accept username directly.
   */
    private async initiateMultiAuth(
        req: Request<unknown, unknown, InitiateMultiAuthBody>,
        res: Response,
    ): Promise<void> {
        try {
            const username: string = this.sanitizeString( req.body?.username );

            if ( !username ) {
                ApiResponseBuilder.error(
                    res,
                    400,
                'Username is required to initiate multi-auth.',
            );
            return;
        }

            const user: IUser | null = await UserModel.findOne( { username } ).exec();

            if ( !user ) {
                ApiResponseBuilder.error(
                    res,
                    404,
                'User not found.',
            );
            return;
        }

            if ( ( user as any ).multiAuthEnabled ) {
                ApiResponseBuilder.error(
                    res,
                    400,
                'Multi-authentication is already enabled for this user.',
            );
            return;
        }

            // Create pairing record + URI string
            const pairing = await this.mfaService.createPairingForUser( user );

            // Generate QR as a PNG data URL
            const qrDataUrl: string = await QRCode.toDataURL( pairing.uri, {
            errorCorrectionLevel: 'M',
        } );

            ApiResponseBuilder.ok(
                res,
                'other',
                {
                    username: user.username,
                qr: qrDataUrl,                       // <img [src]="qr"> in Angular
                pairingToken: pairing.pairingToken,  // mostly for debugging; FE usually does not need it
                expiresAt: pairing.expiresAt.toISOString(),
                uri: pairing.uri,                    // if FE wants to generate QR itself
            },
            'Multi-auth pairing QR generated.',
        );
            return;
        } catch ( error ) {
            console.error( '[mfa/initiate] error:', error );
            ApiResponseBuilder.error(
                res,
                500,
            'Failed to initiate multi-authentication.',
        );
            return;
        }
    }

    /**
     * confirmMultiAuth
     * ----------------
     * Body (from foreign app):
     *   {
     *     pairingToken: string;
     *     deviceName?: string;
     *     devicePlatform?: string;
     *   }
     *
     * Validates pairing token, activates multi-auth on user.
     */
    private async confirmMultiAuth(
        req: Request<unknown, unknown, ConfirmMultiAuthBody>,
        res: Response,
    ): Promise<void> {
        try {
            const pairingToken: string = this.sanitizeString( req.body?.pairingToken );
            const deviceName: string | undefined = this.sanitizeString( req.body?.deviceName ) || undefined;
            const devicePlatform: string | undefined = this.sanitizeString( req.body?.devicePlatform ) || undefined;

            if ( !pairingToken ) {
                ApiResponseBuilder.error(
                    res,
                    400,
                'Pairing token is required.',
            );
            return;
        }

            const user: User | null = await this.mfaService.confirmPairing(
                pairingToken,
                deviceName,
            devicePlatform,
        );

            if ( !user ) {
                ApiResponseBuilder.error(
                    res,
                    400,
                'Invalid or expired pairing token.',
            );
            return;
        }

            const safeUser = this.buildSafeUserPayload( user );

            if ( !safeUser ) {
                ApiResponseBuilder.error( res, 404, 'User does not found!' );
                return;
            }

            ApiResponseBuilder.ok(
                res,
                'user',
            safeUser,
            'Multi-authentication activated successfully.',
            {
                other: {
                    multiAuthEnabled: true,
                    deviceName: deviceName ?? null,
                    devicePlatform: devicePlatform ?? null,
                },
            },
        );
            return;
        } catch ( error ) {
            console.error( '[mfa/confirm] error:', error );
            ApiResponseBuilder.error(
                res,
                500,
                'Failed to confirm multi-authentication.',
            );
            return;
        }
    }

    /**
     * getPairingStatus
     * ----------------
     * GET /status/:pairingToken
     * Used by the FE to poll for status updates.
     */
    private async getPairingStatus(
        req: Request<{ pairingToken: string; }>,
        res: Response,
    ): Promise<void> {
        try {
            const pairingToken: string = this.sanitizeString( req.params?.pairingToken );

            if ( !pairingToken ) {
                ApiResponseBuilder.error(
                    res,
                    400,
                    'Pairing token is required.',
                );
                return;
            }

            const status = await this.mfaService.getPairingStatus( pairingToken );

            ApiResponseBuilder.ok(
                res,
                'other',
                { status },
                'Multi-auth pairing status resolved.',
            );
            return;
        } catch ( error ) {
            console.error( '[mfa/status] error:', error );
            ApiResponseBuilder.error(
                res,
                500,
            'Failed to resolve multi-auth pairing status.',
        );
            return;
        }
    }

    /**
     * deactivateMultiAuth
     * -------------------
  
  
       * POST /deactive/:username
       * Disables multi-auth for the given user.
       */
    private async deactivateMultiAuth(
        req: Request<{ username: string; }>,
        res: Response,
    ): Promise<void> {
        try {
            const username: string = this.sanitizeString( req.params?.username );

            if ( !username ) {
                ApiResponseBuilder.validationError( res, 'Username is required.' );
                return;
            }

            const user: User | null = await this.mfaService.deactivateMultiAuth( username );

            if ( !user ) {
                ApiResponseBuilder.error( res, 404, 'Failed to update user.' );
                return;
            }

            const safeUser: User | null = this.buildSafeUserPayload( user );

            if ( !safeUser ) {
                ApiResponseBuilder.error( res, 404, 'User does not found!' );
                return;
            }

            ApiResponseBuilder.ok(
                res,
                'user',
                safeUser,
                'User multi-auth settings updated successfully.',
            );
            return;
        } catch ( error ) {
            console.error( '[mfa/deactivate] error:', error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
    }

    /**
     * initialVerify
     * -------------
  
  
       * POST /initial-verify
       * Body:
       *   { pairingToken: string; code: string; }
       *
       * Used as a first-step verification for the pairing (e.g. from FE UI).
       */
    private async initialVerify(
        req: Request<unknown, unknown, InitialVerifyBody>,
        res: Response,
    ): Promise<void> {
        try {
            const pairingToken: string = this.sanitizeString( req.body?.pairingToken );
            const code: string = this.sanitizeString( req.body?.code );

            if ( !pairingToken ) {
                ApiResponseBuilder.validationError( res, 'Pairing token is required.' );
                return;
            }

            if ( !code ) {
                ApiResponseBuilder.validationError( res, 'Code is required.' );
                return;
            }

            const data: MfaPairingDocument | null = await this.mfaService.verifyInitial(
                pairingToken,
                code,
            );

            if ( !data ) {
                ApiResponseBuilder.error( res, 406, 'Pairing data does not match or is invalid.' );
                return;
            }

            const safePairing = this.buildSafePairingPayload( data );

            ApiResponseBuilder.ok(
                res,
                'other',
                { pairing: safePairing },
                'Pairing verified successfully.',
            );
            return;
        } catch ( error ) {
            console.error( '[mfa/initial-verify] error:', error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
    }

    /**
     * userVerify
     * ----------
     * POST /user-verify
     * Body:
     *   { token: string; code: string; }
     *
     * Verifies a TOTP code for the given user. Used during login or
     * sensitive actions if MFA is enabled.
     *
     * On success:
     *   - Issues sessionToken + guardToken (JWT-based)
     *   - Sets cookies (sessionToken, guardToken)
     *   - Issues Redis-backed wsToken for Socket.IO
     */
    private async userVerify(
        req: Request,
        res: Response,
    ): Promise<void> {
        try {
            const token: string = this.sanitizeString( req.body?.token );
            const code: string = this.sanitizeString( req.body?.code );

            if ( !token ) {
                ApiResponseBuilder.validationError( res, 'Token is required.' );
                return;
            }

            if ( !code ) {
                ApiResponseBuilder.validationError( res, 'Code is required.' );
                return;
            }

            const user: User | null = await this.mfaService.verifyUser( token, code );

            if ( !user ) {
                ApiResponseBuilder.error( res, 406, 'User or code does not match.' );
                return;
            }

            const safeUser = this.buildSafeUserPayload( user );

            if ( !safeUser ) {
                ApiResponseBuilder.error( res, 404, 'User does not found!' );
                return;
            }

            // 5) Issue session + guard tokens (JWT-based)
            const tokens = await this.guardTokenService.issueForUser( user );

            if ( !tokens ) {
                ApiResponseBuilder.error( res, 406, 'Failed to generate user tokens!' );
                return;
            }

            const isProd = process.env.NODE_ENV === 'production';

            // 6) Set secure cookies for 30 days
            res.cookie( 'sessionToken', tokens.sessionToken, {
                httpOnly: true,
                secure: isProd,
                sameSite: 'strict',
                maxAge: 30 * 24 * 60 * 60 * 1000,
            } );

            res.cookie( 'guardToken', tokens.guardToken, {
                httpOnly: true,
                secure: isProd,
                sameSite: 'strict',
                maxAge: 30 * 24 * 60 * 60 * 1000,
            } );

            // 7) Issue WebSocket-only token (Redis-backed registry)
            //    FE uses this in socket.io `auth.wsToken` on initial connection.
            const mfaStrength: MfaStrength = 'password_plus_totp';

            let wsRecord: WsTokenRecord | null = null;
            try {
                // We know `user` is a full Mongoose document compatible with IUser
                const wsUser: IUser = user as unknown as IUser;
                wsRecord = await this.issueWsTokenForResponse(
                    wsUser,
                    tokens.sessionToken,
                    mfaStrength,
                    req,
                );
            } catch ( err ) {
                // If WS token creation fails, we STILL allow HTTP login
                // but log this clearly because realtime will not work.
                console.warn(
                    '[mfa/user-verify] Failed to issue Redis wsToken for user:',
                    user.username,
                    err,
                );
            }

            ApiResponseBuilder.ok(
                res,
                'user',
                safeUser,
                'Login successful',
                {
                    other: {
                        sessionToken: tokens.sessionToken, // FE still uses this for HTTP
                        guardToken: tokens.guardToken,
                        wsToken: wsRecord ? wsRecord.token : null,
                        wsTokenIssuedAt: wsRecord ? wsRecord.createdAt.getTime() : null,
                        wsTokenValidUntil: wsRecord ? wsRecord.expiresAt.getTime() : null,
                        mfaVerify: true,
                    },
                },
            );
            return;
        } catch ( error ) {
            console.error( '[mfa/user-verify] error:', error );
            ApiResponseBuilder.internalError( res, error );
            return;
        }
    }
}
