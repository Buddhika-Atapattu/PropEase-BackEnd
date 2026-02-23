// Path: src/services/payment/payment.service.ts
// =============================================================================
// PaymentService (Class-based business logic)
// -----------------------------------------------------------------------------
// 01. Introduction
// - Creates Payment records and generates invoice PDF artifacts.
// - Maps Mongo documents -> DTOs safely (no JSON.parse hacks).
//
// 02. Important matters
// - Embedded objects (target/money/invoiceSnapshot) are stored as subdocuments,
//   therefore they are returned as objects, not strings.
// - Optional props are omitted (exactOptionalPropertyTypes-safe).
//
// 03. Why this class
// - Keeps payment logic centralized and reusable by controllers/WS emitters later.
//
// 04. Parameter description: see each method.
// 05. Usage hint: controller calls createPayment() and getInvoicePdf().
// 06. Keep in mind: invoiceNo generator is showcase-safe but not concurrency-hardened.
// =============================================================================

import type { Request } from "express";
import type { HydratedDocument } from "mongoose";

import { PaymentDbModel, type PaymentDoc } from "../../models/payment/payment.model";
import { PaymentInvoiceService } from "./payment-invoice.service";

import type { Address, PhoneNumber } from "../../types/common";
import {
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  type PaymentCreateRequestDto,
  type PaymentCreateResponseDto,
  type PaymentMethod,
  type PaymentPdfResponseDto,
  type PaymentRecordDto,
  type PaymentStatus,
  type InvoiceLineDto,
  type InvoicePartyDto,
} from "../../types/payment/payment.types";

type PaymentHydrated = HydratedDocument<PaymentDoc>;

export class PaymentService {
  private readonly invoice: PaymentInvoiceService;

  public constructor() {
    this.invoice = new PaymentInvoiceService();
  }

  /**
   * Create a payment + generate invoice PDF (showcase).
   *
   * @param options.req
   * - Optional Express request used for absolute URL building.
   *
   * @param options.input
   * - PaymentCreateRequestDto.
   */
  public async createPayment(options: {
    req?: Request;
    input: PaymentCreateRequestDto;
  }): Promise<{ response: PaymentCreateResponseDto; pdf: PaymentPdfResponseDto }> {
    this.validateCreateInput(options.input);

    const invoiceNo = await this.nextInvoiceNo();

    const lines: InvoiceLineDto[] = [
      {
        label: this.buildLineLabel(
          options.input.target.module,
          options.input.target.sectionKey,
          options.input.target.refId
        ),
        qty: 1,
        unitPrice: options.input.money.amount,
        lineTotal: options.input.money.amount,
      },
    ];

    const issuedBy = this.getIssuedByParty();

    const snapshot = this.invoice.buildSnapshot({
      invoiceNo,
      issuedBy,
      billedTo: options.input.billedTo,
      money: options.input.money,
      lines,
      ...(options.input.notes ? { notes: options.input.notes } : {}),
    });

    const status: PaymentStatus = "paid";
    const paidAt = new Date().toISOString();

    const createdDoc: PaymentHydrated = await PaymentDbModel.Model.create({
      invoiceNo,
      status,
      target: options.input.target,
      money: options.input.money,
      method: options.input.method,
      paidAt,
      invoiceSnapshot: snapshot,
      ...(options.input.tags ? { tags: options.input.tags } : {}),
    });

    const pdfOut = await this.invoice.renderPdf({ snapshot });

    const dto = this.toDto(createdDoc);
    const pdfUrl = this.buildPublicUrl(options.req, pdfOut.publicRelPath);

    return {
      response: { created: dto },
      pdf: {
        paymentId: createdDoc._id.toString(),
        invoiceNo,
        pdfRelPath: pdfOut.publicRelPath,
        pdfUrl,
      },
    };
  }

  /**
   * Resolve invoice PDF path/url for a payment.
   *
   * @param options.paymentId
   * - Mongo _id as string.
   */
  public async getInvoicePdf(options: {
    req?: Request;
    paymentId: string;
  }): Promise<PaymentPdfResponseDto> {
    const doc = await PaymentDbModel.Model.findById(options.paymentId).exec();
    if (!doc) {
      throw new Error("Payment not found");
    }

    const pdfRelPath = `public/uploads/payments/invoices/${doc.invoiceNo}.pdf`;
    const pdfUrl = this.buildPublicUrl(options.req, pdfRelPath);

    return {
      paymentId: doc._id.toString(),
      invoiceNo: doc.invoiceNo,
      pdfRelPath,
      pdfUrl,
    };
  }

  // ------------------------------ validation helpers ------------------------------

  private validateCreateInput(input: PaymentCreateRequestDto): void {
    if (!input.target.module || !input.target.sectionKey || !input.target.refId) {
      throw new Error("Invalid target reference");
    }

    if (!input.money.currency || typeof input.money.amount !== "number" || input.money.amount <= 0) {
      throw new Error("Invalid money");
    }

    if (!this.isPaymentMethod(input.method)) {
      throw new Error("Invalid payment method");
    }

    if (!input.billedTo.name.trim()) {
      throw new Error("Invalid billedTo.name");
    }

    this.validateAddress(input.billedTo.address);

    if (input.billedTo.phone) {
      this.validatePhone(input.billedTo.phone);
    }
  }

  private validateAddress(address: Address): void {
    if (!address.houseNumber.trim()) throw new Error("Invalid address.houseNumber");
    if (!address.street.trim()) throw new Error("Invalid address.street");
    if (!address.city.trim()) throw new Error("Invalid address.city");
    if (!address.stateOrProvince.trim()) throw new Error("Invalid address.stateOrProvince");
    if (!address.postcode.trim()) throw new Error("Invalid address.postcode");
    if (!address.country.trim()) throw new Error("Invalid address.country");
  }

  private validatePhone(phone: PhoneNumber): void {
    if (!phone.number.trim()) throw new Error("Invalid phone.number");
    if (!phone.code.name.trim()) throw new Error("Invalid phone.code.name");
    if (!phone.code.code.trim()) throw new Error("Invalid phone.code.code");
    if (!phone.code.flags.png.trim()) throw new Error("Invalid phone.code.flags.png");
    if (!phone.code.flags.svg.trim()) throw new Error("Invalid phone.code.flags.svg");
  }

  private isPaymentMethod(v: string): v is PaymentMethod {
    return (PAYMENT_METHOD as readonly string[]).includes(v);
  }

  private isPaymentStatus(v: string): v is PaymentStatus {
    return (PAYMENT_STATUS as readonly string[]).includes(v);
  }

  // ------------------------------ invoice number ------------------------------

  private async nextInvoiceNo(): Promise<string> {
    const year = new Date().getFullYear();

    // Lean only what we need (keeps TS clean and avoids runtime shape hacks)
    const last = await PaymentDbModel.Model.findOne({ invoiceNo: new RegExp(`^INV-${year}-`) })
      .sort({ createdAt: -1 })
      .select({ invoiceNo: 1 })
      .lean<{ invoiceNo?: string }>()
      .exec();

    const nextSeq = this.parseNextSeq(last?.invoiceNo, year);
    const padded = String(nextSeq).padStart(6, "0");
    return `INV-${year}-${padded}`;
  }

  private parseNextSeq(lastInvoiceNo: string | undefined, year: number): number {
    if (!lastInvoiceNo) return 1;

    const prefix = `INV-${year}-`;
    if (!lastInvoiceNo.startsWith(prefix)) return 1;

    const seqStr = lastInvoiceNo.slice(prefix.length);
    const seq = Number(seqStr);

    if (!Number.isFinite(seq) || seq <= 0) return 1;
    return seq + 1;
  }

  // ------------------------------ DTO + URL helpers ------------------------------

  private buildLineLabel(module: string, sectionKey: string, refId: string): string {
    return `${module.toUpperCase()} — ${sectionKey} (${refId})`;
  }

  private buildPublicUrl(req: Request | undefined, publicRelPath: string): string {
    const rel = publicRelPath.replace(/^public\//, "");

    if (!req) return `/${rel}`;

    const host = req.get("host");
    if (!host) return `/${rel}`;

    return `${req.protocol}://${host}/${rel}`;
  }

  private getIssuedByParty(): InvoicePartyDto {
    const address: Address = {
      houseNumber: "No. 01",
      street: "Main Street",
      city: "Colombo",
      stateOrProvince: "Western",
      postcode: "00100",
      country: "Sri Lanka",
    };

    const base: InvoicePartyDto = {
      name: "PropEase (Pvt) Ltd",
      address,
    };

    return { ...base, email: "billing@propease.lk" };
  }

  private toDto(doc: PaymentHydrated): PaymentRecordDto {
    const createdAtIso = doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString();
    const updatedAtIso = doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : new Date(doc.updatedAt).toISOString();

    const statusStr = String(doc.status);
    const methodStr = String(doc.method);

    if (!this.isPaymentStatus(statusStr)) throw new Error("DB contains invalid payment status");
    if (!this.isPaymentMethod(methodStr)) throw new Error("DB contains invalid payment method");

    const base: PaymentRecordDto = {
      paymentId: doc._id.toString(),
      invoiceNo: doc.invoiceNo,
      status: statusStr,

      target: doc.target,
      money: doc.money,
      method: methodStr,

      createdAt: createdAtIso,
      updatedAt: updatedAtIso,

      invoiceSnapshot: doc.invoiceSnapshot,
    };

    // paidAt stored as ISO string already
    return doc.paidAt ? { ...base, paidAt: doc.paidAt } : base;
  }
}