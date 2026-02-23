// Path: src/controllers/payment/payment.controller.ts
// =============================================================================
// PaymentController (Class-based Express controller)
// =============================================================================

import type { Request, Response } from "express";
import { PaymentService } from "../../services/payment/payment.service";

export class PaymentController {
  private readonly service: PaymentService;

  public constructor() {
    this.service = new PaymentService();
  }

  /**
   * POST /create
   * Body: PaymentCreateRequestDto
   */
  public async createPayment(req: Request, res: Response): Promise<void> {
    try {
      const input = req.body;
      const created = await this.service.createPayment({ req, input });

      res.status(201).json({
        status: true,
        message: "[Success:] Payment created and invoice generated.\n",
        data: created,
      });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Payment create failed";
      res.status(400).json({
        status: false,
        message: `[Error:] ${msg}\n`,
        data: null,
      });
      return;
    }
  }

  /**
   * GET /invoice/:paymentId
   */
  public async getInvoicePdf(req: Request, res: Response): Promise<void> {
    try {
      const paymentId = String(req.params.paymentId || "");
      const pdf = await this.service.getInvoicePdf({ req, paymentId });

      res.status(200).json({
        status: true,
        message: "[Success:] Invoice PDF resolved.\n",
        data: pdf,
      });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invoice not found";
      res.status(404).json({
        status: false,
        message: `[Error:] ${msg}\n`,
        data: null,
      });
      return;
    }
  }
}