// Path: src/controller/mfa.controller.ts

import {
    Router,
    type Request,
    type Response
} from 'express';

import QRCode from 'qrcode';

import { ApiResponseBuilder } from '../utils/api-combiner.builder';
import { UserModel, type IUser } from '../models/user.model';
import { MfaService } from '../services/mfa.service';

/**
 * MfaController
 * -------------
 * Endpoints:
 *
 *   POST /api/mfa/initiate
 *     - Called from web app when user clicks "Activate Multi-Auth".
 *     - Returns QR image (data URL) + expiry.
 *
 *   POST /api/mfa/confirm
 *     - Called from foreign app after scanning QR and confirming.
 *     - Activates multi-auth on the user.
 */
export class MfaController {
    private readonly router: Router;
    private readonly mfaService: MfaService;

    public constructor () {
        this.router = Router();
        this.mfaService = new MfaService();
        this.registerRoutes();
    }

    public getRouter(): Router {
        return this.router;
    }

    private registerRoutes(): void {
        // Initial QR generation (web → backend)
        this.router.post(
            '/initiate',
            this.initiateMultiAuth.bind( this )
        );

        // Confirmation after scan (foreign app → backend)
        this.router.post(
            '/confirm',
            this.confirmMultiAuth.bind( this )
        );

        // Optional: alias for backward compatibility
        this.router.post(
            '/activate',
            this.confirmMultiAuth.bind( this )
        );
    }

    /**
     * initiateMultiAuth
     * -----------------
     * Body:
     *   { username: string }
     *
     * In a fully locked-down system this would usually derive the user
     * from the session (auth middleware) and not accept username directly.
     * For now we keep it explicit and simple for integration.
     */
    private async initiateMultiAuth( req: Request, res: Response ): Promise<void> {
        try {
            const rawUsername: unknown = req.body?.username;
            const username: string = typeof rawUsername === 'string'
                ? rawUsername.trim()
                : '';

            if ( !username ) {
                ApiResponseBuilder.error(
                    res,
                    400,
                    'Username is required to initiate multi-auth.'
                );
                return;
            }

            const user: IUser | null = await UserModel.findOne( { username } ).exec();

            if ( !user ) {
                ApiResponseBuilder.error(
                    res,
                    404,
                    'User not found.'
                );
                return;
            }

            if ( ( user as any ).multiAuthEnabled ) {
                ApiResponseBuilder.error(
                    res,
                    400,
                    'Multi-authentication is already enabled for this user.'
                );
                return;
            }

            // Create pairing record + URI string
            const pairing = await this.mfaService.createPairingForUser( user );

            // Generate QR as a PNG data URL
            const qrDataUrl: string = await QRCode.toDataURL( pairing.uri, {
                errorCorrectionLevel: 'M'
            } );

            ApiResponseBuilder.ok(
                res,
                'other',
                {
                    username: user.username,
                    qr: qrDataUrl,                         // <img [src]="qr"> in Angular
                    pairingToken: pairing.pairingToken,   // mostly for debugging, FE usually doesn't need it
                    expiresAt: pairing.expiresAt.toISOString(),
                    uri: pairing.uri                      // if FE wants to generate QR itself
                },
                'Multi-auth pairing QR generated.'
            );
            return;
        } catch ( error ) {
            console.error( '[mfa/initiate] error:', error );
            ApiResponseBuilder.error(
                res,
                500,
                'Failed to initiate multi-authentication.'
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
    private async confirmMultiAuth( req: Request, res: Response ): Promise<void> {
        try {
            const pairingToken: string = String( req.body?.pairingToken || '' ).trim();
            const deviceName: string | undefined =
                typeof req.body?.deviceName === 'string'
                    ? req.body.deviceName.trim()
                    : undefined;

            const devicePlatform: string | undefined =
                typeof req.body?.devicePlatform === 'string'
                    ? req.body.devicePlatform.trim()
                    : undefined;

            if ( !pairingToken ) {
                ApiResponseBuilder.error(
                    res,
                    400,
                    'Pairing token is required.'
                );
                return;
            }

            const user: IUser | null = await this.mfaService.confirmPairing(
                pairingToken,
                deviceName,
                devicePlatform
            );

            if ( !user ) {
                ApiResponseBuilder.error(
                    res,
                    400,
                    'Invalid or expired pairing token.'
                );
                return;
            }

            const plain = user.toObject ? user.toObject() : ( user as any );
            const { password: _omit, ...userWithoutPassword } = plain;

            ApiResponseBuilder.ok(
                res,
                'user',
                userWithoutPassword,
                'Multi-authentication activated successfully.',
                {
                    other: {
                        multiAuthEnabled: true,
                        deviceName: deviceName ?? null,
                        devicePlatform: devicePlatform ?? null
                    }
                }
            );
            return;
        } catch ( error ) {
            console.error( '[mfa/confirm] error:', error );
            ApiResponseBuilder.error(
                res,
                500,
                'Failed to confirm multi-authentication.'
            );
            return;
        }
    }
}
