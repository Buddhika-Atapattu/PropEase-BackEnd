// Path: src/services/session-expiry.service.ts
// ============================================================================
// SessionExpiryService
// ----------------------------------------------------------------------------
// Responsibilities:
//   - Given a sessionToken, compute remaining lifetime of the session.
//   - Attach "warning" headers when a session is close to expiring.
//   - Designed to be used from ApiGuard (per-request check).
//
// NOTE:
//   - We deliberately do NOT send any body payload from here – only headers.
//   - FE should read these headers in HttpInterceptor and show UI warnings.
// ============================================================================

import type { Response } from "express";
import { GuardTokenService } from "./guard-token.service";

// How close to expiry we start warning the user (e.g. 10 minutes)
const DEFAULT_WARN_THRESHOLD_MS = 10 * 60 * 1000; // 10 * 60 * 1000 = 600_000 ms

export interface SessionTTLResult {
    expiresAt: Date;
    msRemaining: number;
}

export class SessionExpiryService {
    private readonly guardTokenService: GuardTokenService;

    // threshold can be made configurable later if needed
    private readonly warnThresholdMs: number;

    public constructor (warnThresholdMs: number = DEFAULT_WARN_THRESHOLD_MS) {
        this.guardTokenService = new GuardTokenService();
        this.warnThresholdMs = warnThresholdMs;
    }

    /**
     * computeTTL
     * ----------
     * Uses GuardTokenService to look up the session by token and compute
     * how many milliseconds remain until expiry.
     *
     * Returns:
     *   - { expiresAt, msRemaining }  → active session
     *   - null                        → no session or already expired
     */
    public async computeTTL (sessionToken: string): Promise<SessionTTLResult | null> {
        if (!sessionToken || !sessionToken.trim()) {
            return null;
        }

        try {
            const record = await this.guardTokenService.findBySessionToken(sessionToken.trim());

            if (!record || !record.expiresAt) {
                return null;
            }

            const now = Date.now();
            const expiresAt = record.expiresAt instanceof Date
                ? record.expiresAt
                : new Date(record.expiresAt);

            const msRemaining = expiresAt.getTime() - now;

            if (msRemaining <= 0) {
                return null;
            }

            return { expiresAt, msRemaining };
        } catch (error) {
            console.warn("[SessionExpiryService.computeTTL] Failed to compute TTL:", error);
            return null;
        }
    }

    /**
     * attachWarningHeadersIfNeeded
     * ----------------------------
     * If the session is close to expiry (within warnThresholdMs), we attach:
     *
     *   X-Session-Expires-In: <secondsRemaining>
     *   X-Session-Expiry-ISO: <ISO timestamp of expiry>
     *
     * so that frontend can show a banner / dialog.
     *
     * If the session is NOT close to expiry, no headers are set.
     */
    public async attachWarningHeadersIfNeeded (
        res: Response,
        sessionToken: string,
    ): Promise<void> {
        const ttl = await this.computeTTL(sessionToken);
        if (!ttl) {
            return;
        }

        if (ttl.msRemaining <= this.warnThresholdMs) {
            try {
                const secondsRemaining: number = Math.floor(ttl.msRemaining / 1000);

                res.setHeader("X-Session-Expires-In", String(secondsRemaining));
                res.setHeader("X-Session-Expiry-ISO", ttl.expiresAt.toISOString());
            } catch (error) {
                console.warn(
                    "[SessionExpiryService.attachWarningHeadersIfNeeded] Failed to set headers:",
                    error,
                );
            }
        }
    }
}
