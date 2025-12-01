// Path: src/utils/api-response.builder.ts
import { Response } from 'express';
import { ApiResponse, ApiData, ApiStatus } from '../types/api-message';



export class BaseResponseBuilder {

    /* ────────────────────────────────────────────────────────────────────────────────
       Base builder (used internally)
    ───────────────────────────────────────────────────────────────────────────────── */
    private static build<TData>(
        res: Response,
        statusCode: number,
        status: ApiStatus,
        message: string,
        data: TData | null
    ): void {

        const response: ApiResponse<TData> = {
            success: status === 'success',
            status,
            message,
            data,
            timestamp: new Date().toISOString(),
        };

        // Only set path if it exists (never assign undefined)
        if ( res.req && typeof res.req.originalUrl === 'string' ) {
            response.path = res.req.originalUrl;
        }

        // Only set requestId if the header is really a string
        const headerRequestId = res.req?.headers[ 'x-request-id' ];
        if ( typeof headerRequestId === 'string' ) {
            response.requestId = headerRequestId;
        }

        res.status( statusCode ).json( response );
        return;
    }


    /* ────────────────────────────────────────────────────────────────────────────────
       200: Success
    ───────────────────────────────────────────────────────────────────────────────── */
    public static success<TData = ApiData>(
        res: Response,
        message: string,
        data: TData
    ): void {
        this.build( res, 200, 'success', message, data );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       201: Resource Created
    ───────────────────────────────────────────────────────────────────────────────── */
    public static created<TData = ApiData>(
        res: Response,
        message: string,
        data: TData
    ): void {
        this.build( res, 201, 'success', message, data );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       204: No Content (DELETE success etc.)
    ───────────────────────────────────────────────────────────────────────────────── */
    public static noContent(
        res: Response,
        message = 'No content'
    ): void {
        this.build( res, 204, 'success', message, null );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       400: Bad Request
    ───────────────────────────────────────────────────────────────────────────────── */
    public static badRequest(
        res: Response,
        message: string,
        data: ApiData | null = null
    ): void {
        this.build( res, 400, 'fail', message, data );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       401: Unauthorized
    ───────────────────────────────────────────────────────────────────────────────── */
    public static unauthorized(
        res: Response,
        message = 'Unauthorized'
    ): void {
        this.build( res, 401, 'fail', message, null );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       403: Forbidden
    ───────────────────────────────────────────────────────────────────────────────── */
    public static forbidden(
        res: Response,
        message = 'Forbidden'
    ): void {
        this.build( res, 403, 'fail', message, null );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       404: Not Found
    ───────────────────────────────────────────────────────────────────────────────── */
    public static notFound(
        res: Response,
        message = 'Resource not found'
    ): void {
        this.build( res, 404, 'fail', message, null );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       409: Conflict (duplicate entry, etc.)
    ───────────────────────────────────────────────────────────────────────────────── */
    public static conflict(
        res: Response,
        message = 'Conflict'
    ): void {
        this.build( res, 409, 'fail', message, null );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       422: Validation Error
    ───────────────────────────────────────────────────────────────────────────────── */
    public static validationError(
        res: Response,
        message: string,
        data: ApiData | null = null
    ): void {
        this.build( res, 422, 'fail', message, data );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       500: Internal Server Error
    ───────────────────────────────────────────────────────────────────────────────── */
    public static internalError(
        res: Response,
        error: unknown
    ): void {
        const msg = error instanceof Error ? error.message : 'Internal Server Error';

        this.build( res, 500, 'error', msg, null );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       502: Failed
    ───────────────────────────────────────────────────────────────────────────────── */
    public static fail(
        res: Response,
        message: string,
        data: ApiData | null = null
    ): void {
        this.build( res, 502, 'fail', message, data );
    }

    /* ────────────────────────────────────────────────────────────────────────────────
       Custom builder for ANY status from 200 → 500
    ───────────────────────────────────────────────────────────────────────────────── */
    public static custom<TData = ApiData>(
        res: Response,
        statusCode: number,
        status: ApiStatus,
        message: string,
        data: TData | null
    ): void {
        this.build( res, statusCode, status, message, data );
    }

}

