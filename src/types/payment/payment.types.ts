// Path: src/types/payment/payment.types.ts
// =============================================================================
// Payment Types — Canonical Contracts (DTO-safe)
// -----------------------------------------------------------------------------
// PURPOSE
// - Independent Payment domain that links to any module via target reference.
// - Produces invoice-ready snapshots to keep audits stable over time.
//
// IMPORTANT MATTERS
// - IDs in DTOs are string (NOT mongoose Types).
// - Optional properties must be OMITTED (exactOptionalPropertyTypes-safe).
// - target.refId must be the unique ID of the target section (ex: leaseID).
// =============================================================================

import { ISODateString, Address, Country, PhoneNumber } from "../common";


export const PAYMENT_STATUS = ["pending", "paid", "failed", "refunded", "void"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const PAYMENT_METHOD = ["cash", "bank_transfer", "card", "online_gateway", "cheque", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

export const PAYMENT_TARGET_MODULE = [
  "lease",
  "tenant",
  "property",
  "complaint",
  "teamTask",
  "workItem",
  "other",
] as const;
export type PaymentTargetModule = (typeof PAYMENT_TARGET_MODULE)[number];

export interface PaymentTargetRef {
  module: PaymentTargetModule;  // ex: "lease"
  sectionKey: string;           // ex: "rent" | "deposit" | "penalty" | "utility"
  refId: string;                // ex: LEASE-0001 (or Mongo id if you use that)
}

export interface MoneyDto {
  amount: number;               // Expected: decimal-safe number (store cents if you prefer)
  currency: string;             // Expected: "LKR", "USD", "AED", ...
}

export interface InvoicePartyDto {
  name: string;                 // ex: "PropEase (Pvt) Ltd"
  address: Address;       // ex: ["No. 12, ...", "Colombo 03", "Sri Lanka"]
  phone?: PhoneNumber;
  email?: string;
  taxId?: string;
}

export interface InvoiceLineDto {
  label: string;                // ex: "Monthly Rent — Feb 2026"
  qty: number;                  // ex: 1
  unitPrice: number;            // ex: 150000
  lineTotal: number;            // qty * unitPrice
}

export interface InvoiceSnapshotDto {
  invoiceNo: string;            // ex: "INV-2026-000012"
  issuedAt: ISODateString;      // invoice generation time
  billedTo: InvoicePartyDto;    // tenant/customer
  issuedBy: InvoicePartyDto;    // company
  lines: InvoiceLineDto[];
  subTotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  notes?: string;
}

export interface PaymentRecordDto {
  paymentId: string;
  invoiceNo: string;
  status: PaymentStatus;

  target: PaymentTargetRef;

  money: MoneyDto;
  method: PaymentMethod;

  paidAt?: ISODateString;
  createdAt: ISODateString;
  updatedAt: ISODateString;

  // Snapshot is what makes the invoice "real" and audit-safe.
  invoiceSnapshot: InvoiceSnapshotDto;

  tags?: string[];
}

export interface PaymentCreateRequestDto {
  target: PaymentTargetRef;

  money: MoneyDto;
  method: PaymentMethod;

  // For showcase: you can pass billedTo from UI.
  // In real: you can resolve this from Lease/Tenant modules.
  billedTo: InvoicePartyDto;

  // Optional invoice customizations
  notes?: string;

  // Optional: for refunds/adjustments later
  tags?: string[];
}

export interface PaymentCreateResponseDto {
  created: PaymentRecordDto;
}

export interface PaymentPdfResponseDto {
  paymentId: string;
  invoiceNo: string;
  pdfRelPath: string;   // "public/uploads/payments/invoices/<...>.pdf"
  pdfUrl: string;       // FE-consumable url
}