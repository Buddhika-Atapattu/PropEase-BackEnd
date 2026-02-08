// Path: src/utils/api-combiner.builder.ts
// ============================================================================
// ApiResponseBuilder (Controller-facing)
// ----------------------------------------------------------------------------
// Purpose:
//  - Controllers call ONE builder for success/error with strong typing
//  - Auto wires payload into data.system[key] OR data.other
//  - Supports pagination + validation + other extras safely
//
// Rules enforced:
//  - Domain payload goes into SystemData keys (typed)
//  - Team module uses TeamManagementDto (DTO), not Document
// ============================================================================

import type { Response } from 'express';

import type {
    ApiData,
    SystemData,
    PaginationMeta,
    ValidationUnit,
    ApiStatus,
} from '../types/api-message';

import { ApiDataBuilder } from './api-data.builder';
import { BaseResponseBuilder } from './api-response.builder';

// ──────────────────────────────────────────────────────────────
// Helpers for SystemData
// ──────────────────────────────────────────────────────────────

type SystemKey = keyof SystemData;
type SystemValue<K extends SystemKey> = NonNullable<SystemData[ K ]>;

/**
 * Optional extras attached to ApiData.
 */
interface ApiExtras {
    pagination?: PaginationMeta;
    validation?: ValidationUnit;
    other?: Record<string, unknown>;
}

export class ApiResponseBuilder extends BaseResponseBuilder {

    // ─────────────────────────────────────────────────────────────
    // SUCCESS overloads
    // ─────────────────────────────────────────────────────────────

    public static ok<K extends SystemKey>(
        res: Response,
        key: K,
        payload: SystemValue<K>,
    ): void;

    public static ok<K extends SystemKey>(
        res: Response,
        key: K,
        payload: SystemValue<K>,
        message: string,
        extras?: ApiExtras,
    ): void;

    public static ok(
        res: Response,
        key: 'other',
        payload: Record<string, unknown>,
    ): void;

    public static ok(
        res: Response,
        key: 'other',
        payload: Record<string, unknown>,
        message: string,
        extras?: Omit<ApiExtras, 'other'>,
    ): void;

    public static ok(
        res: Response,
        key: SystemKey | 'other',
        payload: unknown,
        message?: string,
        extras?: ApiExtras,
    ): void {

        const builder: ApiDataBuilder<SystemData> = new ApiDataBuilder<SystemData>();

        if ( extras?.pagination ) builder.withPagination( extras.pagination );
        if ( extras?.validation ) builder.withValidation( extras.validation );

        if ( key === 'other' ) {
            builder.withOther( payload as Record<string, unknown> );
            const data: ApiData<SystemData> = builder.build();

            const safeMessage: string = message ?? 'Request processed successfully';
            BaseResponseBuilder.success<ApiData<SystemData>>( res, safeMessage, data );
            return;
        }

        const systemKey: SystemKey = key;

        // key-safe partial set: data.system[key] = payload
        builder.withSystemPartial( {
            [ systemKey ]: payload as SystemData[ typeof systemKey ],
        } );

        if ( extras?.other ) builder.withOther( extras.other );

        const data: ApiData<SystemData> = builder.build();
        const safeMessage: string = message ?? this.getDefaultSuccessMessage( systemKey );

        BaseResponseBuilder.success<ApiData<SystemData>>( res, safeMessage, data );
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // ERROR overloads
    // ─────────────────────────────────────────────────────────────

    public static error(
        res: Response,
        statusCode: number,
        message: string,
    ): void;

    public static error<K extends SystemKey>(
        res: Response,
        statusCode: number,
        message: string,
        key: K,
        payload: SystemValue<K>,
        extras?: ApiExtras,
    ): void;

    public static error(
        res: Response,
        statusCode: number,
        message: string,
        key: 'other',
        payload: Record<string, unknown>,
        extras?: Omit<ApiExtras, 'other'>,
    ): void;

    public static error(
        res: Response,
        statusCode: number,
        message: string,
        key?: SystemKey | 'other',
        payload?: unknown,
        extras?: ApiExtras,
    ): void {

        const apiStatus: ApiStatus = statusCode >= 500 ? 'error' : 'fail';

        // No key/payload => null data
        if ( key === undefined ) {
            BaseResponseBuilder.custom( res, statusCode, apiStatus, message, null );
            return;
        }

        const builder: ApiDataBuilder<SystemData> = new ApiDataBuilder<SystemData>();

        if ( extras?.pagination ) builder.withPagination( extras.pagination );
        if ( extras?.validation ) builder.withValidation( extras.validation );

        if ( key === 'other' ) {
            builder.withOther( payload as Record<string, unknown> );
            const data: ApiData<SystemData> = builder.build();

            BaseResponseBuilder.custom<ApiData<SystemData>>( res, statusCode, apiStatus, message, data );
            return;
        }

        const systemKey: SystemKey = key;

        builder.withSystemPartial( {
            [ systemKey ]: payload as SystemData[ typeof systemKey ],
        } );

        if ( extras?.other ) builder.withOther( extras.other );

        const data: ApiData<SystemData> = builder.build();

        BaseResponseBuilder.custom<ApiData<SystemData>>( res, statusCode, apiStatus, message, data );
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // Default success messages (expand as you add SystemData keys)
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

            // ✅ Team module keys (ADD THESE because your SystemData contains them)
            case 'team':
            case 'teams':
                return 'Team data fetched successfully';

            case 'workItem':
            case 'workItems':
                return 'Work item data fetched successfully';

            case 'event':
            case 'events':
                return 'Work event data fetched successfully';

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
