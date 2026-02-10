// ============================================================================
// Path: src/api/validator.router.ts
// Description: Validation routes (email format + MX DNS check).
// Notes:
//  - Class-based router, aligned with ApiResponseBuilder.
//  - Mounted (likely) under /api-validator → GET /api-validator/email-validator/:email
// ============================================================================

import { promises as dns } from "dns";
import express, { Request, Response, Router } from "express";

import { ApiResponseBuilder } from "../utils/api-combiner.builder";



export default class Validator {
  private readonly router: Router;

  constructor () {
    this.router = express.Router();
    this.emailValidator();
  }

  public get route(): Router {
    return this.router;
  }

  // ==========================================================================
  // GET /email-validator/:email
  // (Mounted as /api-validator/email-validator/:email)
  //
  // Validates:
  //  1) Basic email format (RFC-ish, pragmatic)
  //  2) Domain has MX records (deliverability hint)
  //
  // Response shape via ApiResponseBuilder:
  //  - success: system.other = { email, validation: { format, mx }, domain }
  //  - validation errors: 400 with message
  // ==========================================================================
  private emailValidator(): void {
    this.router.get(
      "/email-validator/:email",
      async ( req: Request<{ email: string; }>, res: Response ): Promise<void> => {
        try {
          // 1) Basic normalization
          const raw = req.params?.email ?? "";
          const safeEmail = decodeURIComponent( raw ).toLowerCase().trim();

          // 2) Email required
          if ( !safeEmail ) {
            ApiResponseBuilder.validationError(
              res,
              "Email is required in the path parameter."
            );
            return;
          }

          // 3) Format check
          if ( !this.isEmailFormatValid( safeEmail ) ) {
            ApiResponseBuilder.validationError( res, "Invalid email format." );
            return;
          }

          // 4) Extract domain
          const domain = this.extractDomain( safeEmail );
          if ( !domain ) {
            ApiResponseBuilder.validationError(
              res,
              "Email domain is missing or malformed."
            );
            return;
          }

          // 5) MX lookup (deliverability hint)
          const hasMXRecord = await this.hasValidMXRecord( domain );
          if ( !hasMXRecord ) {
            ApiResponseBuilder.validationError(
              res,
              "Email domain has no MX records."
            );
            return;
          }

          // 6) All good → success
          ApiResponseBuilder.ok(
            res,
            "other",
            {
              email: safeEmail,
              validation: {
                format: true,
                mx: true,
              },
              domain,
            },
            "Email appears valid."
          );
          return;
        } catch ( error ) {
          console.error( "[email-validator] error:", error );
          ApiResponseBuilder.internalError( res, error );
          return;
        }
      }
    );
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** Lightweight RFC-ish email format check. */
  private isEmailFormatValid( email: string ): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return typeof email === "string" && emailRegex.test( email );
  }

  /**
   * Safely extract domain part of email.
   * e.g. "a@b.c" -> "b.c"
   * Returns undefined if malformed.
   */
  private extractDomain( email: string ): string | undefined {
    const at = email.lastIndexOf( "@" );
    if ( at <= 0 || at === email.length - 1 ) return undefined;
    const domain = email.slice( at + 1 ).trim();
    return domain || undefined;
  }

  /**
   * MX lookup via dns.promises.
   * Returns false on any error (NXDOMAIN, ENOTFOUND, timeout, etc.).
   */
  private async hasValidMXRecord( domain: string ): Promise<boolean> {
    try {
      const records = await dns.resolveMx( domain );
      return Array.isArray( records ) && records.length > 0;
    } catch {
      return false;
    }
  }
}
