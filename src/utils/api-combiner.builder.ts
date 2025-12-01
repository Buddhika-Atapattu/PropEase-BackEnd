// src/utils/api-combiner.builder.ts
import { Response } from 'express';
import {
    ApiData,
    SystemData,
    PaginationMeta,
    ValidationUnit,
} from '../types/api-message';
import { ApiDataBuilder } from './api-data.builder';
import { BaseResponseBuilder } from './api-response.builder';

/* ──────────────────────────────────────────────────────────────
   Helpers for SystemData
   ────────────────────────────────────────────────────────────── */

type SystemKey = keyof SystemData;
type SystemValue<K extends SystemKey> = NonNullable<SystemData[ K ]>;

/**
 * Optional extras that can be attached to ApiData.
 */
interface ApiExtras {
    pagination?: PaginationMeta;
    validation?: ValidationUnit;
    other?: Record<string, unknown>;
}

/* ──────────────────────────────────────────────────────────────
   MAIN CLASS FOR CONTROLLERS
   ────────────────────────────────────────────────────────────── */
/**
 * Use ONLY this in controllers:
 *
 *   import { ApiResponseBuilder } from '../utils/api-combiner.builder';
 *
 * Domain success (auto system wiring):
 *   ApiResponseBuilder.ok(res, 'leases', leases);
 *   ApiResponseBuilder.ok(res, 'property', property, 'Property fetched');
 *
 * "Other" payload (chart, extra info, etc.):
 *   ApiResponseBuilder.ok(res, 'other', { chartData: ... });
 *
 * Errors (call BaseResponseBuilder methods directly via this class):
 *   ApiResponseBuilder.validationError(res, 'Token is required!');
 *   ApiResponseBuilder.badRequest(res, 'Invalid lease ID');
 *   ApiResponseBuilder.internalError(res, error);
 */
export class ApiResponseBuilder extends BaseResponseBuilder {

    // ─────────────────────────────────────────────────────────────
    // Overloads
    // ─────────────────────────────────────────────────────────────

    // 1) Domain system data – auto message, no extras
    public static ok<K extends SystemKey>(
        res: Response,
        key: K,
        payload: SystemValue<K>
    ): void;

    // 2) Domain system data – custom message + extras
    public static ok<K extends SystemKey>(
        res: Response,
        key: K,
        payload: SystemValue<K>,
        message: string,
        extras?: ApiExtras
    ): void;

    // 3) "other" payload – auto message, no extras
    public static ok(
        res: Response,
        key: 'other',
        payload: Record<string, unknown>
    ): void;

    // 4) "other" payload – custom message + extras (pagination/validation allowed)
    public static ok(
        res: Response,
        key: 'other',
        payload: Record<string, unknown>,
        message: string,
        extras?: Omit<ApiExtras, 'other'>
    ): void;

    // ─────────────────────────────────────────────────────────────
    // Implementation (covers all overloads)
    // ─────────────────────────────────────────────────────────────
    public static ok(
        res: Response,
        key: SystemKey | 'other',
        payload: unknown,
        message?: string,
        extras?: ApiExtras
    ): void {
        const builder: ApiDataBuilder<SystemData> = new ApiDataBuilder<SystemData>();

        // Attach pagination / validation regardless of which key we use
        if ( extras && extras.pagination ) {
            builder.withPagination( extras.pagination );
        }

        if ( extras && extras.validation ) {
            builder.withValidation( extras.validation );
        }

        if ( key === 'other' ) {
            // ─────────────────────────────────────────────────────────
            // Case: data.other = payload
            // ─────────────────────────────────────────────────────────
            builder.withOther( payload as Record<string, unknown> );
            const data: ApiData<SystemData> = builder.build();

            const safeMessage: string = message ?? 'Request processed successfully';
            BaseResponseBuilder.success<ApiData<SystemData>>( res, safeMessage, data );
            return;
        }

        // ─────────────────────────────────────────────────────────
        // Case: data.system[key] = payload (domain data)
        // ─────────────────────────────────────────────────────────
        const systemKey: SystemKey = key as SystemKey;

        const systemPartial: Partial<SystemData> = {
            [ systemKey ]: payload as SystemData[ typeof systemKey ],
        } as Partial<SystemData>;

        builder.withSystem( systemPartial as SystemData );

        if ( extras && extras.other ) {
            builder.withOther( extras.other );
        }

        const data: ApiData<SystemData> = builder.build();
        const safeMessage: string = message ?? this.getDefaultSuccessMessage( systemKey );

        BaseResponseBuilder.success<ApiData<SystemData>>( res, safeMessage, data );
    }

    // ─────────────────────────────────────────────────────────────
    // Default messages per SystemData key
    // ─────────────────────────────────────────────────────────────
    private static getDefaultSuccessMessage( key: SystemKey ): string {
        switch ( key ) {
            case 'user':
            case 'users':
                return 'User data fetched successfully';

            case 'lease':
            case 'leases':
            case 'leaseWithProperty':
            case 'leaseWithProperties':
                return 'Lease data fetched successfully';

            case 'property':
            case 'properties':
                return 'Property data fetched successfully';

            case 'tenant':
            case 'tenants':
                return 'Tenant data fetched successfully';

            case 'complaint':
            case 'complaints':
                return 'Complaint data fetched successfully';

            case 'fileUpload':
            case 'fileUploads':
                return 'File upload data fetched successfully';

            case 'totalUsers':
            case 'totalProperties':
            case 'totalTenants':
            case 'totalComplaints':
                return 'Dashboard summary fetched successfully';

            default:
                return 'Request processed successfully';
        }
    }

}
