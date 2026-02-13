// Path: src/types/common.ts

import { Types } from 'mongoose';
import { Role } from './roles';

/** Standard ISO timestamp used across the system */
export type ISODateString = string;

/** Generic entity ID string */
export type EntityId = string;

/** Mongo ID string reference */
export type MongoIdString = string;

/** User-friendly display string */
export type DisplayText = string;

export interface Address {
    houseNumber: string;
    street?: string;
    city: string;
    stateOrProvince?: string;
    postcode: string;
    country: string;
}

export interface GeoLocation {
    lat: number;
    lng: number;
    embeddedUrl: string;
}


export type AuthUser = {
    // JWT standard subject (user id)
    sub?: string;

    // Human identity
    userId: Types.ObjectId | string;
    username: string;
    role: Role;

    // KPI / scoping hints (OPTIONAL)
    // one user can be in multiple teams
    teamCodes?: string[];   // e.g. ["TEAM-A", "TEAM-B"]
    branchId?: string;      // optional org structure
};



export type AuthUserNormalized = Omit<AuthUser, "userId"> & { userId: string; };