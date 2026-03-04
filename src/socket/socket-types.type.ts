// Path: src/socket/socket-types.type.ts
// Shared socket types for PropEase Socket.IO layer

import {
    Namespace,
    Server as IOServer,
    Socket as IOSocket,
    type DefaultEventsMap,
} from "socket.io";

import type { Role } from "../types/roles";
import { Types } from "mongoose";
import type { AuthUser, ISODateString } from "../types/common";
import type { NotificationCoreDto } from "../types/notification/notification.types";

export type JwtPayload = {
    sub?: string;

    name?: string;
    userId: Types.ObjectId;
    username: string;
    role: Role;

    branchId?: string;
    teamCodes?: string[];

    iat?: number;
    exp?: number;
};

export interface GuardTokenPayload {
    token: string,
    issuedAt: number;
    expiresAt: number;
}

/**
 * Socket.IO "data" bag for each connection.
 */
export type SocketAuthData = {
    authUser?: AuthUser;
    sessionToken?: string;

    /**
     * High-level WS security (flattened permission keys).
     * Example entries:
     * - "PaymentBilling:view"
     * - "PaymentBilling:create"
     * - "PaymentBilling:refund"
     * - "PaymentBilling:delete"
     * - "PaymentBilling:invoice"
     */
    guardActions?: string[];

    // KPI helpers
    kpiTeams?: string[];
    kpiBranchId?: string;
};

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

// Domain payloads (kept as-is)
export type AudienceMode = "user" | "role" | "broadcast";

export interface NotificationAudience {
    mode: AudienceMode;
    usernames?: string[];
    roles?: Role[];
}

export interface NotificationPayload extends NotificationCoreDto {}

export interface ChatMessagePayload {
    id: string;
    roomId?: string;
    from: string;
    to?: string;
    text?: string;
    createdAt: string;
}

export interface CallSignalBase {
    callId: string;
    from: string;
    to: string;
}

export interface CallOfferPayload extends CallSignalBase {
    sdp: unknown;
    kind: "audio" | "video" | "screen" | "audio_video";
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