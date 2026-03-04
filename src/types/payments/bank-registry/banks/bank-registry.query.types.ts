// Path: src/types/payments/bank-registry/banks/bank-registry.query.types.ts
/* =============================================================================
 * Bank Registry Query Types (List/Search/Filter/Pagination)
 * -----------------------------------------------------------------------------
 * 01. Introduction
 * - Shared request/response types for list + search endpoints.
 *
 * 02. Important matters
 * - Optional props must be OMITTED (never assign undefined).
 * - Keep contracts DTO-first (no Mongoose Types here).
 *
 * 03. Why we make this file
 * - Avoid “ad-hoc query params” explosion and keep stable API contract.
 *
 * 06. Need to keep in mind
 * - companyId is enforced server-side (never trust client to provide it).
 * ============================================================================= */

export interface PageQueryDto {
  page: number;  // 1-based
  limit: number; // 1..100 or 1..500 depending on endpoint
}

export interface PageMetaDto {
  total: number;
  page: number;
  limit: number;
}

export interface ListResponseDto<T> {
  items: T[];
  other: { pagination: PageMetaDto };
}