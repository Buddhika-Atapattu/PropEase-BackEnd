// Path: src/services/payment/payment-invoice.service.ts
// =============================================================================
// PaymentInvoiceService (Class-based PDF generator)
// =============================================================================

import path from "path";
import fs from "fs/promises";
import puppeteer from "puppeteer";

import type { Address, PhoneNumber,ISODateString } from "../../types/common";
import type {
  InvoiceLineDto,
  InvoicePartyDto,
  InvoiceSnapshotDto,
  MoneyDto,
} from "../../types/payment/payment.types";

export class PaymentInvoiceService {
  private static readonly INVOICE_DIR_REL = "public/uploads/payments/invoices";

  /**
   * Build invoice snapshot (audit-stable).
   *
   * @param options.invoiceNo - Expected: "INV-2026-000012"
   * @param options.issuedBy  - Company party details
   * @param options.billedTo  - Customer party details
   * @param options.money     - MoneyDto (amount + currency)
   * @param options.lines     - Invoice line items
   * @param options.notes     - Optional notes
   */
  public buildSnapshot(options: {
    invoiceNo: string;
    issuedBy: InvoicePartyDto;
    billedTo: InvoicePartyDto;
    money: MoneyDto;
    lines: InvoiceLineDto[];
    notes?: string;
  }): InvoiceSnapshotDto {
    const issuedAt: ISODateString = new Date().toISOString();

    const subTotal = this.sumLines(options.lines);
    const discountTotal = 0;
    const taxTotal = 0;
    const grandTotal = this.round2(subTotal - discountTotal + taxTotal);

    const base: InvoiceSnapshotDto = {
      invoiceNo: options.invoiceNo,
      issuedAt,
      billedTo: options.billedTo,
      issuedBy: options.issuedBy,
      lines: options.lines,
      subTotal,
      discountTotal,
      taxTotal,
      grandTotal,
    };

    return options.notes ? { ...base, notes: options.notes } : base;
  }

  /**
   * Render invoice PDF to disk under public/uploads.
   *
   * @param options.snapshot - Snapshot created by buildSnapshot()
   * @returns publicRelPath  - "public/uploads/payments/invoices/<invoiceNo>.pdf"
   */
  public async renderPdf(options: {
    snapshot: InvoiceSnapshotDto;
  }): Promise<{ publicRelPath: string }> {
    const dirAbs = path.resolve(process.cwd(), PaymentInvoiceService.INVOICE_DIR_REL);
    await fs.mkdir(dirAbs, { recursive: true });

    const fileName = `${options.snapshot.invoiceNo}.pdf`;
    const outAbs = path.join(dirAbs, fileName);

    const html = this.buildInvoiceHtml(options.snapshot);

    const browser = await puppeteer.launch({
      headless: "shell",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });

      await page.pdf({
        path: outAbs,
        format: "A4",
        printBackground: true,
        margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
      });
    } finally {
      await browser.close();
    }

    const publicRelPath = path
      .join(PaymentInvoiceService.INVOICE_DIR_REL, fileName)
      .replace(/\\/g, "/");

    return { publicRelPath };
  }

  // ------------------------- private helpers -------------------------

  private sumLines(lines: InvoiceLineDto[]): number {
    const total = lines.reduce((acc, l) => acc + l.lineTotal, 0);
    return this.round2(total);
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  private esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
      if (c === "&") return "&amp;";
      if (c === "<") return "&lt;";
      if (c === ">") return "&gt;";
      if (c === '"') return "&quot;";
      return "&#039;";
    });
  }

  private phoneToText(phone: PhoneNumber | undefined): string | null {
    if (!phone) return null;

    const cc = phone.code.code.trim();
    const num = phone.number.trim();

    if (!num) return null;
    return cc ? `${cc} ${num}` : num;
  }

  private addressToLines(address: Address): string[] {
    const lines: string[] = [];

    const line1 = `${address.houseNumber.trim()} ${address.street.trim()}`.trim();
    if (line1) lines.push(line1);

    const line2 = `${address.city.trim()}, ${address.stateOrProvince.trim()}`.trim();
    if (line2) lines.push(line2);

    const post = address.postcode.trim();
    if (post) lines.push(post);

    const c = address.country.trim();
    if (c) lines.push(c);

    return lines.length > 0 ? lines : ["-"];
  }

  private buildPartyBlock(party: InvoicePartyDto): string {
    const addrLines = this.addressToLines(party.address)
      .map((l) => `<div>${this.esc(l)}</div>`)
      .join("");

    const phoneText = this.phoneToText(party.phone);
    const phoneHtml = phoneText ? `<div class="muted">Tel: ${this.esc(phoneText)}</div>` : "";

    const emailHtml = party.email ? `<div class="muted">Email: ${this.esc(party.email)}</div>` : "";
    const taxHtml = party.taxId ? `<div class="muted">Tax ID: ${this.esc(party.taxId)}</div>` : "";

    return `
      <div><b>${this.esc(party.name)}</b></div>
      ${addrLines}
      ${phoneHtml}
      ${emailHtml}
      ${taxHtml}
    `;
  }

  private buildInvoiceHtml(snapshot: InvoiceSnapshotDto): string {
    const issuedByHtml = this.buildPartyBlock(snapshot.issuedBy);
    const billedToHtml = this.buildPartyBlock(snapshot.billedTo);

    const linesHtml = snapshot.lines
      .map(
        (l) => `
        <tr>
          <td>${this.esc(l.label)}</td>
          <td class="num">${l.qty}</td>
          <td class="num">${l.unitPrice.toFixed(2)}</td>
          <td class="num">${l.lineTotal.toFixed(2)}</td>
        </tr>
      `
      )
      .join("");

    const notesHtml = snapshot.notes
      ? `<div class="notes"><b>Notes:</b> ${this.esc(snapshot.notes)}</div>`
      : "";

    return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${this.esc(snapshot.invoiceNo)}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111; }
    .top { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
    .box { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
    h1 { margin: 0; font-size: 22px; }
    .muted { color:#555; font-size: 12px; }
    table { width:100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border-bottom: 1px solid #eee; padding: 10px 8px; font-size: 12px; }
    th { text-align:left; background:#f7f7f7; }
    .num { text-align:right; }
    .totals { width: 260px; margin-left:auto; margin-top: 12px; }
    .totals .row { display:flex; justify-content:space-between; padding:6px 0; font-size:12px; }
    .totals .grand { font-weight:700; font-size: 14px; border-top: 1px solid #ddd; padding-top: 10px; }
    .notes { margin-top: 14px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="top">
    <div>
      <h1>Invoice</h1>
      <div class="muted">Invoice No: <b>${this.esc(snapshot.invoiceNo)}</b></div>
      <div class="muted">Issued At: ${this.esc(snapshot.issuedAt)}</div>
    </div>
    <div class="box" style="min-width: 280px;">
      ${issuedByHtml}
    </div>
  </div>

  <div class="box" style="margin-top: 12px;">
    <div class="muted">Billed To</div>
    ${billedToHtml}
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml}
    </tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Sub-total</span><span>${snapshot.subTotal.toFixed(2)}</span></div>
    <div class="row"><span>Discount</span><span>${snapshot.discountTotal.toFixed(2)}</span></div>
    <div class="row"><span>Tax</span><span>${snapshot.taxTotal.toFixed(2)}</span></div>
    <div class="row grand"><span>Grand Total</span><span>${snapshot.grandTotal.toFixed(2)}</span></div>
  </div>

  ${notesHtml}
</body>
</html>
    `;
  }
}