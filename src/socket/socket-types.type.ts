// Path: src/socket/socket-types.type.ts
// Shared socket types for PropEase Socket.IO layer

import {
    Namespace,
    Server as IOServer,
    Socket as IOSocket,
    type DefaultEventsMap
} from 'socket.io';
import type { Role } from '../types/roles';
import { Types } from 'mongoose';
import { AuthUser } from '../types/common';

export type JwtPayload = {
    sub?: string;

    name?: string;        // optional "name" claim (for better FE display), fallback to "username"
    userId: Types.ObjectId;        // userId (string) if your JWT uses it
    username: string;
    role: Role;

    // optional scoping hints (multi-team supported)
    branchId?: string;
    teamCodes?: string[];    // ✅ one user can belong to many teams

    iat?: number;
    exp?: number;
};


/**
 * Socket.IO "data" bag for each connection.
 * We extend this as needed (authUser, sessionToken, etc.)
 */
export type SocketAuthData = {
    authUser?: AuthUser;
    sessionToken?: string;

    // -----------------------------
    // KPI realtime room join helpers
    // -----------------------------
    kpiTeams?: string[];      // teamCodes (user can have many)
    kpiBranchId?: string;     // optional (only if you have branches)
};


// Strongly-typed aliases for Socket.IO server / namespace / socket
export type TypedServer = IOServer<
    DefaultEventsMap,
    DefaultEventsMap,
    DefaultEventsMap,
    SocketAuthData
>;

export type TypedNamespace = Namespace<
    DefaultEventsMap,
    DefaultEventsMap,
    DefaultEventsMap,
    SocketAuthData
>;

export type TypedSocket = IOSocket<
    DefaultEventsMap,
    DefaultEventsMap,
    DefaultEventsMap,
    SocketAuthData
>;

// ──────────────────────────────────────────────────────────────────────────────
// Domain payloads – keep in sync with FE DTOs
// ──────────────────────────────────────────────────────────────────────────────

export type AudienceMode = 'user' | 'role' | 'broadcast';

export interface NotificationAudience {
    mode: AudienceMode;
    usernames?: string[];
    roles?: Role[];
}

export interface NotificationPayload {
    _id: string;
    title: string;
    body: string;
    category: string;
    type: string;
    severity?: 'info' | 'success' | 'warning' | 'error';
    audience: NotificationAudience;
    createdAt: string;
}

export interface ChatMessagePayload {
    id: string;
    roomId?: string;   // e.g. "chat:tenant-123-owner-7"
    from: string;      // enforced by backend (socket auth)
    to?: string;       // direct message target username
    text?: string;
    createdAt: string;
}

export interface CallSignalBase {
    callId: string;    // unique call/session id
    from: string;      // caller username (enforced server-side)
    to: string;        // callee username
}

export interface CallOfferPayload extends CallSignalBase {
    sdp: unknown;
    kind: 'audio' | 'video' | 'screen' | 'audio_video';
}

export interface CallAnswerPayload extends CallSignalBase {
    sdp: unknown;
}

export interface CallCandidatePayload extends CallSignalBase {
    candidate: unknown;
}

export interface CallEndPayload extends CallSignalBase {
    reason?: string;
}

/**
 * Guard token payload (BE → FE)
 * NOTE: token here is the hex guardToken from GuardTokenService,
 *       not a separate JWT anymore.
 */
export interface GuardTokenPayload {
    token: string;   // DB-backed hex guard token
    issuedAt: number;
    expiresAt: number;
}
