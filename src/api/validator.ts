import express, { Request, Response, Router } from "express";
import { promises as dns } from "dns";
import dotenv from "dotenv";
// If you actually use CryptoService elsewhere in this file, keep it;
// otherwise you can safely remove the import + instance to avoid dead code.
import { CryptoService } from "../services/crypto.service";
import { ApiResponseBuilder } from '../utils/api-combiner.builder';

dotenv.config();

type ApiStatus = "success" | "error" | "warning";
type ValidationResponse<T = unknown> = {
  status: ApiStatus;
  message: string;
  data?: T;
};

export default class Validator {
  private router: Router;
  private cryptoService: CryptoService = new CryptoService(); // currently unused here

  constructor () {
    this.router = express.Router();
    this.emailValidator();
  }

  get route(): Router {
    return this.router;
  }

  /**
   * GET /api-validator/email-validator/:email
   * Validates:
   *  1) Basic email format
   *  2) Domain has MX records (deliverable-ish check)
   *
   * Notes:
   *  - We normalize params safely (no .trim() on undefined)
   *  - We guard against missing domain (e.g. "foo@", "foo")
   *  - DNS checks are done via promises API (try/catch)
   */
  private emailValidator() {
    this.router.get(
      "/email-validator/:email",
      async ( req: Request<{ email: string; }>, res: Response<ValidationResponse> ): Promise<any> => {
        try {
          // Params can be URL-encoded; decode and normalize carefully
          const raw = req.params?.email ?? "";
          const safeEmail = decodeURIComponent( raw ).toLowerCase().trim();

          // Early validations
          if ( !safeEmail ) {

            ApiResponseBuilder.validationError( res, "Email is required in the path parameter." );
          }

          if ( !this.isEmailFormatValid( safeEmail ) ) {
            ApiResponseBuilder.validationError( res, "Invalid email format." );
            return;
          } 

          // Extract domain safely
          const domain = this.extractDomain( safeEmail );
          if ( !domain ) {
            ApiResponseBuilder.validationError( res, "Email domain is missing or malformed." );
            return;
          }

          // MX lookup (deliverability hint)
          const hasMXRecord = await this.hasValidMXRecord( domain );

          if ( !hasMXRecord ) {
            ApiResponseBuilder.validationError( res, "Email domain has no MX records." );
            return;
          }
          ApiResponseBuilder.ok( res, 'other', { email: safeEmail, validation: { format: true, mx: true }, domain }, "Email appears valid." );
        } catch ( error ) {
          console.error( error );
          const msg = error instanceof Error ? error.message : String( error );
          ApiResponseBuilder.internalError( res, msg );
          return;
        }
      }
    );
  }

  /** Lightweight RFC-ish format check; avoids `.trim()` on undefined. */
  private isEmailFormatValid( email: string ): boolean {
    // Keep it pragmatic; you already normalize to lowercase & trim earlier.
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return typeof email === "string" && emailRegex.test( email );
  }

  /** Safely extract the domain part ("a@b.c" -> "b.c"). Returns undefined if malformed. */
  private extractDomain( email: string ): string | undefined {
    const at = email.lastIndexOf( "@" );
    if ( at <= 0 || at === email.length - 1 ) return undefined;
    const domain = email.slice( at + 1 ).trim();
    return domain || undefined;
  }

  /**
   * MX lookup via dns.promises. Guarded so TypeScript never sees string|undefined.
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
