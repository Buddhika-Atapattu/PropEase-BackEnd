// Path: src/config/env.config.ts
// -----------------------------------------------------------------------------
// CENTRAL ENVIRONMENT LOADER FOR ENTIRE BACKEND
// -----------------------------------------------------------------------------
//  - Loads `.env` ONCE for the entire process.
//  - Exposes all variables as typed constants.
//  - Groups configuration identical to .env sections.
//  - Provides safe defaults for development.
// -----------------------------------------------------------------------------
// IMPORTANT:
//   * DO NOT call dotenv.config() anywhere else in the project.
//   * ALWAYS import variables from here instead of process.env.
// -----------------------------------------------------------------------------

import dotenv from "dotenv";
dotenv.config(); // Load environment variables ONCE

/* ============================================================================
 * 🌐 SERVER CONFIGURATION
 * ==========================================================================*/

/** Application metadata */
export const APP_NAME: string = process.env.APP_NAME ?? "PropEase";
export const APP_ENV: string = process.env.APP_ENV ?? "development";
export const APP_VERSION: string = process.env.APP_VERSION ?? "1.0.0";

/** Node runtime environment */
export const NODE_ENV: string = process.env.NODE_ENV ?? "development";
export const IS_PROD: boolean = NODE_ENV === "production";
export const IS_DEV: boolean = !IS_PROD;

/** Host + Port */
export const APP_HOST: string = process.env.HOST ?? "localhost";
export const APP_PORT: number = Number( process.env.PORT ?? "3000" );

/** LAN IP for mobile devices (optional) */
export const PUBLIC_IP: string =
    process.env.PUBLIC_IP ?? `http://${ APP_HOST }:${ APP_PORT }`;

/** Allowed FE origins (CORS + SocketIO) */
export const FRONTEND_ORIGIN: string =
    process.env.FRONTEND_ORIGIN ?? "http://localhost:4200";

/** Allowed hosts for your HostGuard middleware */
export const ALLOWED_HOSTS: string =
    process.env.ALLOWED_HOSTS ?? "localhost:3000";

/** Public-denied folders (security middleware) */
export const PUBLIC_DENY_DIRS: string =
    process.env.PUBLIC_DENY_DIRS ?? "recyclebin,backups,adminsOnly,private";

export const REDIS_URL: string = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/* ============================================================================
 * 🔐 AUTHENTICATION & SECURITY
 * ==========================================================================*/

/** IMPORTANT: Must be a strong secret in production */
export const JWT_SECRET: string =
    process.env.JWT_SECRET ?? "PLEASE_SET_A_REAL_SECRET";

/** Cookie behaviour (HTTPS in production) */
export const COOKIE_SECURE: boolean =
    ( process.env.COOKIE_SECURE ?? "false" ).toLowerCase() === "true";

export const COOKIE_SAME_SITE: "lax" | "strict" | "none" =
    ( process.env.COOKIE_SAME_SITE as any ) ?? "lax";

/* ============================================================================
 * 🗄️ DATABASE (MongoDB)
 * ==========================================================================*/

export const MONGO_URI: string =
    process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/propease";

export const MONGO_DB: string = process.env.MONGO_DB ?? "propease";

/** Optional TLS configs */
export const MONGO_TLS: boolean =
    ( process.env.MONGO_TLS ?? "false" ).toLowerCase() === "true";

export const MONGO_TLS_CA_FILE: string | undefined =
    process.env.MONGO_TLS_CA_FILE ?? undefined;

export const MONGO_TLS_CERT_KEY_FILE: string | undefined =
    process.env.MONGO_TLS_CERT_KEY_FILE ?? undefined;

/* ============================================================================
 * 📧 SMTP EMAIL CONFIG
 * ==========================================================================*/

export const SMTP_HOST: string = process.env.SMTP_HOST ?? "smtp.gmail.com";
export const SMTP_PORT: number = Number( process.env.SMTP_PORT ?? "465" );

export const SMTP_SECURE: boolean =
    ( process.env.SMTP_SECURE ?? "true" ).toLowerCase() === "true";

export const SMTP_USER: string = process.env.SMTP_USER ?? "";
export const SMTP_PASS: string = process.env.SMTP_PASS ?? "";

/* ============================================================================
 * 📞 TWILIO SMS / PHONE VERIFICATION
 * ==========================================================================*/

export const TWILIO_ACCOUNT_SID: string =
    process.env.TWILIO_ACCOUNT_SID ?? "";

export const TWILIO_ACCOUNT_AUTH_TOKEN: string =
    process.env.TWILIO_ACCOUNT_AUTH_TOKEN ?? "";

export const TWILIO_ACCOUNT_PHONE_NUMBER: string =
    process.env.TWILIO_ACCOUNT_PHONE_NUMBER ?? "";

export const TWILIO_ACCOUNT_RECOVERY_CODE: string =
    process.env.TWILIO_ACCOUNT_RECOVERY_CODE ?? "";

/* ============================================================================
 * 🌍 GOOGLE API KEYS
 * ==========================================================================*/

export const GOOGLE_API_KEY: string =
    process.env.GOOGLE_API_KEY ?? "";

/* ============================================================================
 * 🧹 AUTO DELETION CONFIG
 * ==========================================================================*/

export const AUTO_DELETE_ENABLED: boolean =
    ( process.env.AUTO_DELETE_ENABLED ?? "false" ).toLowerCase() === "true";

export const AUTO_DELETE_AGE_DAYS: number = Number(
    process.env.AUTO_DELETE_AGE_DAYS ?? "30"
);

export const AUTO_DELETE_NOTIFY_ROLES: string =
    process.env.AUTO_DELETE_NOTIFY_ROLES ?? "admin,operator,manager";

/* ============================================================================
 * 💾 STORAGE & BACKUPS
 * ==========================================================================*/

export const RESTORE_ROOT: string =
    process.env.RESTORE_ROOT ?? "recyclebin/";

export const STORAGE_ROOT: string =
    process.env.STORAGE_ROOT ?? "uploads/";

/* ============================================================================
 * 📝 LOGGING / MONITORING
 * ==========================================================================*/

export const LOG_LEVEL: string = process.env.LOG_LEVEL ?? "info";

export const ENABLE_INTERNAL_MONITOR: boolean =
    ( process.env.ENABLE_INTERNAL_MONITOR ?? "false" ).toLowerCase() === "true";

/* ============================================================================
 * EXPORT GROUPED OBJECT (Optional Helper)
 * ==========================================================================*/

export const ENV = {
    app: {
        APP_NAME,
        APP_ENV,
        REDIS_URL,
        APP_VERSION,
        NODE_ENV,
        IS_DEV,
        IS_PROD,
        APP_HOST,
        APP_PORT,
        PUBLIC_IP,
    },
    cors: {
        FRONTEND_ORIGIN,
        ALLOWED_HOSTS,
        PUBLIC_DENY_DIRS,
    },
    auth: {
        JWT_SECRET,
        COOKIE_SECURE,
        COOKIE_SAME_SITE,
    },
    db: {
        MONGO_URI,
        MONGO_DB,
        MONGO_TLS,
        MONGO_TLS_CA_FILE,
        MONGO_TLS_CERT_KEY_FILE,
    },
    smtp: {
        SMTP_HOST,
        SMTP_PORT,
        SMTP_SECURE,
        SMTP_USER,
        SMTP_PASS,
    },
    twilio: {
        TWILIO_ACCOUNT_SID,
        TWILIO_ACCOUNT_PHONE_NUMBER,
        TWILIO_ACCOUNT_AUTH_TOKEN,
        TWILIO_ACCOUNT_RECOVERY_CODE,
    },
    google: {
        GOOGLE_API_KEY,
    },
    autoDelete: {
        AUTO_DELETE_ENABLED,
        AUTO_DELETE_AGE_DAYS,
        AUTO_DELETE_NOTIFY_ROLES,
    },
    storage: {
        RESTORE_ROOT,
        STORAGE_ROOT,
    },
    logging: {
        LOG_LEVEL,
        ENABLE_INTERNAL_MONITOR,
    }
};

console.log( `[ENV] Loaded environment: ${ NODE_ENV }` , '\n');
