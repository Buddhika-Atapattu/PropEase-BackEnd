// Path: src/utils/api-response.builder.ts
// ============================================================================
// BaseResponseBuilder
// ----------------------------------------------------------------------------
// Purpose:
//  - Single consistent response format for every endpoint
//  - Keeps optional fields (path/requestId) truly optional (never assign undefined)
// ============================================================================

import type { Response } from 'express';
import type { ApiResponse, ApiData, ApiStatus } from '../types/api-message';

export class BaseResponseBuilder {

    private static build<TData>(
        res: Response,
        statusCode: number,
        status: ApiStatus,
        message: string,
      data: TData | null,
  ): void {

      const response: ApiResponse<TData> = {
          success: status === 'success',
          status,
          message,
          data,
          timestamp: new Date().toISOString(),
      };

      const originalUrl = res.req?.originalUrl;
      if ( typeof originalUrl === 'string' && originalUrl ) {
          response.path = originalUrl;
      }

      const headerRequestId = res.req?.headers[ 'x-request-id' ];
      if ( typeof headerRequestId === 'string' && headerRequestId ) {
          response.requestId = headerRequestId;
      }

      res.status( statusCode ).json( response );
      return;
  }

    public static success<TData = ApiData>(
        res: Response,
        message: string,
      data: TData,
  ): void {
      this.build( res, 200, 'success', message, data );
  }

    public static created<TData = ApiData>(
        res: Response,
        message: string,
      data: TData,
  ): void {
      this.build( res, 201, 'success', message, data );
  }

    public static noContent(
        res: Response,
      message = 'No content',
  ): void {
      this.build( res, 204, 'success', message, null );
  }

    public static badRequest(
        res: Response,
        message: string,
      data: ApiData | null = null,
  ): void {
      this.build( res, 400, 'fail', message, data );
  }

    public static unauthorized(
        res: Response,
      message = 'Unauthorized',
  ): void {
      this.build( res, 401, 'fail', message, null );
  }

    public static forbidden(
        res: Response,
      message = 'Forbidden',
  ): void {
      this.build( res, 403, 'fail', message, null );
  }

    public static notFound(
        res: Response,
      message = 'Resource not found',
  ): void {
      this.build( res, 404, 'fail', message, null );
  }

    public static conflict(
        res: Response,
      message = 'Conflict',
  ): void {
      this.build( res, 409, 'fail', message, null );
  }

    public static validationError(
        res: Response,
        message: string,
      data: ApiData | null = null,
  ): void {
      this.build( res, 422, 'fail', message, data );
  }

    public static internalError(
        res: Response,
      error: unknown,
  ): void {
      const msg = error instanceof Error ? error.message : 'Internal Server Error';
      this.build( res, 500, 'error', msg, null );
  }

    /**
     * NOTE: 502 is gateway failure, but you used it as general fail.
     * Keeping as-is to avoid breaking existing behavior.
     */
    public static fail(
        res: Response,
        message: string,
      data: ApiData | null = null,
  ): void {
      this.build( res, 502, 'fail', message, data );
  }

    public static custom<TData = ApiData>(
        res: Response,
        statusCode: number,
        status: ApiStatus,
        message: string,
      data: TData | null,
  ): void {
      this.build( res, statusCode, status, message, data );
  }
}
