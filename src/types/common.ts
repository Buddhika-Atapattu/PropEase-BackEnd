// Path: src/types/common.ts
// =============================================================================
// Common Types (Shared System Contracts)
// -----------------------------------------------------------------------------
// PURPOSE
// - A single place for shared foundational types used across ALL modules.
// - Keep these types stable; changing them affects many domains.
// - No business logic here.
//
// NOTES (PropEase rules)
// - File paths: relativePath must be under "public/" (no leading "/").
// - publicUrl is a client URL and MAY start with "/" or be absolute.
// - AuthUser.userId uses Types.ObjectId in runtime; normalize to string when needed.
// =============================================================================

import { Types } from "mongoose";
import { Role } from "./roles";

// -----------------------------------------------------------------------------
// 01) Primitive aliases (readability + consistent DTO naming)
// -----------------------------------------------------------------------------

/** Standard ISO timestamp used across the system */
export type ISODateString = string;

/** Generic entity ID string */
export type EntityId = string;

/** Mongo ID string reference (when serialized) */
export type MongoIdString = string;

/** User-friendly display string */
export type DisplayText = string;

// -----------------------------------------------------------------------------
// 02) Location & Address types (shared between Property / Lease / etc.)
// -----------------------------------------------------------------------------

/**
 * Minimal address used across modules.
 * Keep it lightweight. Anything country-specific should live in module types.
 */
export interface Address {
    houseNumber: string;
    street: string;
    city: string;
    stateOrProvince: string;
    postcode: string;
    country: string;
}

/**
 * Geo-location for map embedding.
 * embeddedUrl is typically used for static maps/iframes.
 */
export interface GeoLocation {
    lat: number;
    lng: number;
    embeddedUrl: string;
}

// -----------------------------------------------------------------------------
// 03) Country + Phone types (used by Tenant/Lease/Users/etc.)
// -----------------------------------------------------------------------------

/**
 * Country dialing code metadata.
 * Used by PhoneNumber and sometimes for UI country pickers.
 */
export interface CountryCodes {
    name: string;
    code: string;
    flags: {
        png: string;
        svg: string;
        alt?: string;
    };
}

/**
 * Minimal country identity (used in some modules)
 */
export interface Country {
    name: string;
    code: string;
    emoji: string;
    unicode: string;
    image: string;
}

/**
 * Phone number with country dialing metadata.
 * NOTE: number is a number in your current design (keep as-is).
 * If you ever need leading zeros, switch to string system-wide.
 */
export interface PhoneNumber {
    code: CountryCodes;
    number: string;
}

/**
 * Large country details type (for autocomplete / API country datasets).
 * Used mostly on FE, but can appear in shared DTOs.
 */
export interface CountryDetailsAdvance {
    name: {
        common: string;
        official: string;
        nativeName?: {
            [ langCode: string ]: {
                official: string;
                common: string;
            };
        };
    };
    tld?: string[];
    cca2: string;
    cca3?: string;
    ccn3?: string;
    cioc?: string;
    independent?: boolean;
    status?: string;
    unMember?: boolean;
    currencies?: {
        [ code: string ]: { name: string; symbol: string; };
    };
    idd?: { root: string; suffixes: string[]; };
    capital?: string[];
    altSpellings?: string[];
    region: string;
    subregion?: string;
    languages?: { [ langCode: string ]: string; };
    latlng: [ number, number ];
    landlocked?: boolean;
    borders?: string[];
    area: number;
    demonyms?: { [ langCode: string ]: { m: string; f: string; }; };
    translations?: { [ langCode: string ]: { official: string; common: string; }; };
    flag?: string;
    flags: { png: string; svg: string; alt?: string; };
    coatOfArms?: { png?: string; svg?: string; };
    maps?: { googleMaps: string; openStreetMaps: string; };
    population: number;
    fifa?: string;
    car?: { signs: string[]; side: "left" | "right"; };
    timezones: string[];
    continents: string[];
    startOfWeek?: string;
    capitalInfo?: { latlng: [ number, number ]; };
    postalCode?: { format?: string; regex?: string; };
}

// -----------------------------------------------------------------------------
// 04) AuthUser (security scope identity for guards, WS, auditing)
// -----------------------------------------------------------------------------

/**
 * Auth identity attached by ApiGuardExport.GetAuthUser(req).
 * IMPORTANT:
 * - userId is Types.ObjectId at runtime.
 * - use AuthUserNormalized in contracts/DTOs (string userId).
 */
export type AuthUser = {
    // Human identity
    userId: Types.ObjectId;
    username: string;
    role: Role;
    name: string;

    // JWT standard subject (user id)
    sub?: string;

    // KPI / scoping hints (OPTIONAL)
    // one user can be in multiple teams
    teamCodes?: string[]; // e.g. ["TEAM-A", "TEAM-B"]
    branchId?: string; // optional org structure
    companyId?: string;
};

/**
 * Normalized AuthUser used for DTOs/contracts
 * (never leak Mongoose Types.ObjectId into FE contracts)
 */
export type AuthUserNormalized = Omit<AuthUser, "userId"> & { userId: string; };

export interface ActorMini {
    userId: string;
    username: string;
    role?: string;
}

// -----------------------------------------------------------------------------
// 05) File metadata packet (standard upload result across the platform)
// -----------------------------------------------------------------------------

/**
 * FileMetaPacket is the canonical upload result structure.
 * Used by Comments/WorkItems/TeamTasks/Lease evidence/signatures/etc.
 */
export interface FileMetaPacket {
    // Identity
    originalName: string;
    storedName: string;

    // Type + size
    extension: string;
    mimeType: string;
    sizeBytes: number;

    // Where it lives (filesystem + public mapping)
    relativePath: string; // under "public/" no leading "/" (PropEase rule)
    publicUrl: string; // absolute URL that clients can use
    absDiskPath: string; // full path on disk (useful for internal ops)

    // Upload context
    fieldName: string; // multer fieldname ("attachments", "files", "images"...)
    uploadedAtIso: ISODateString;

    // Optional but valuable diagnostics/integrity
    encoding?: string;
    checksumSha256?: string;
}

// -----------------------------------------------------------------------------
// 06) Pagination + filtering helpers
// -----------------------------------------------------------------------------

export interface DateRange {
    start: string | Date;
    end: string | Date;
}

export interface PaginationMeta {
    index?: number;
    page?: number;
    limit?: number;
    total?: number;
    offset?: number;

    start?: number;
    end?: number;

    search?: string;
    dateRange?: DateRange;

    hasNext?: boolean;
    hasPrevious?: boolean;
    hasResults?: boolean;
    hasMore?: boolean;

    nextCursor?: string;
}

// -----------------------------------------------------------------------------
// 07) Generic validation unit (token-based validation patterns)
// -----------------------------------------------------------------------------

export interface ValidationUnit {
    token?: string;
    isValid?: boolean;
    expiresAt?: string;
}


export interface PageQueryDto {
    page: number;  // 1-based
    limit: number; // 1..100 or 1..500 depending on endpoint
}

export interface PageMetaDto {
    total: number;
    page?: number;
    limit?: number;
}

export interface ListResponseDto<T> {
    items: T[];
    other: { pagination: PageMetaDto; };
}