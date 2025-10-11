// src/types/roles.ts

/**
 * All possible user roles in the system.
 * Must match exactly with the 'role' field in your User model.
 */
export type Role =
    | 'admin'
    | 'agent'
    | 'tenant'
    | 'owner'
    | 'operator'
    | 'manager'
    | 'developer'
    | 'user'; // ✅ changed from 'general' → 'user'

/**
 * Defines how a notification chooses its audience.
 */
export type AudienceMode = 'user' | 'role' | 'broadcast';

/**
 * Notification audience targeting rules.
 * - mode 'user'  → specific usernames list
 * - mode 'role'  → specific roles list
 * - mode 'broadcast' → everyone
 */
export interface NotificationAudience {
    mode: AudienceMode;
    usernames?: string[]; // when mode === 'user'
    roles?: Role[];       // when mode === 'role'
}
