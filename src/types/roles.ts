export type Role = 'admin' | 'agent' | 'tenant' | 'owner' | 'operator' | 'manager' | 'developer' | 'general';

export type AudienceMode = 'user' | 'role' | 'broadcast';

export interface NotificationAudience {
    mode: AudienceMode;
    usernames?: string[]; // when mode==='user'
    roles?: Role[];       // when mode==='role'
}