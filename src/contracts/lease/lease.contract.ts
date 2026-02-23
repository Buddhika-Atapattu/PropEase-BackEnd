// Path: src/contracts/lease/lease.contract.ts
// ============================================================================
// Lease Contract (DTOs) — FE/BE stable API shapes
// - Keep this file free of Mongoose types
// - exactOptionalPropertyTypes-safe: optional fields must be omitted, not undefined
// ============================================================================

import type { LeasePayload } from "../../types/lease/lease.types";

export type LeaseIdParam = { leaseID: string };
export type UsernameParam = { username: string };

export interface LeaseRegisterRequestBody extends LeasePayload {}

export interface LeaseUpdateRequestBody extends LeasePayload {}

export interface LeaseStatusUpdateRequestBody {
  status: string; // validated in controller/service against allowed statuses
  note?: string;
}

export interface LeaseListResponse {
  items: LeasePayload[];
  pagination: {
    total: number;
  };
}

export interface LeaseGetResponse {
  lease: LeasePayload;
}

export interface LeaseCountResponse {
  pagination: {
    total: number;
  };
}
