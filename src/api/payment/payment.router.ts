// Path: src/api/payment/payment.router.ts
// =============================================================================
// PaymentRouter (Class-based router wiring)
// =============================================================================

import { Router } from "express";
import { PaymentController } from "../../controllers/payment/payment.controller";

export class PaymentRouter {
  public readonly router: Router;
  private readonly ctrl: PaymentController;

  public constructor() {
    this.router = Router();
    this.ctrl = new PaymentController();
    this.mount();
  }

  private mount(): void {
    // Bind methods to preserve `this` (since controller uses class methods, not arrow fields)
    this.router.post("/create", this.ctrl.createPayment.bind(this.ctrl));
    this.router.get("/invoice/:paymentId", this.ctrl.getInvoicePdf.bind(this.ctrl));
  }
}