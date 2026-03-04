// Path: src/api/payment/payment.router.ts
// =============================================================================
// PaymentRouter (Class-based router wiring) — UPDATED (PB-20260302-01)
// -----------------------------------------------------------------------------
// 01) Introduction
// - Express router wiring for the Payments module.
// - Covers:
//    A) Bank Registry (Banks master)
//    B) Bank Accounts (company receiving accounts)
//    C) Payment Transactions (external payment records + verify workflow)
//
// 02) Important matters
// - Route ordering is critical:
//    - Static routes first
//    - Then nested groups (/banks/*, /bank-accounts/*, /transactions/*)
//    - Then single-parameter routes last to avoid shadowing.
// - This router is mounted under: /api-payments
//
// 03) Why we make this router
// - Keeps endpoints discoverable and prevents param route collisions.
// - Makes FE integration stable (no accidental route shadowing).
// =============================================================================

import { Router, type Router as ExpressRouter } from "express";
import { PaymentController } from "../../controllers/payment/payment.controller";

export class PaymentRouter {
  public readonly router: ExpressRouter;
  private readonly ctrl: PaymentController;

  public constructor() {
    this.router = Router();
    this.ctrl = new PaymentController();
    this.mount();
  }

  private mount(): void {
    // =========================================================================
    // BANK REGISTRY (Master Data)
    // =========================================================================
    // GET  /banks?page=&limit=&status=&countryCca2=&q=
    this.router.get( "/banks", this.ctrl.listBanks.bind( this.ctrl ) );

    // POST /banks/create 
    this.router.post( "/banks/create", this.ctrl.createBank.bind( this.ctrl ) );

    // GET  /banks/:bankId
    this.router.get( "/banks/bankId/:bankId", this.ctrl.getBankByBankId.bind( this.ctrl ) );

    // GET /banks/bankCode/:bankCode
    this.router.get( "/banks/bankCode/:bankCode", this.ctrl.getByBankCode.bind( this.ctrl ) );

    // PUT  /banks/update/:bankId
    this.router.put( "/banks/update/:bankId", this.ctrl.updateBank.bind( this.ctrl ) );

    // PUT  /banks/:bankId/status
    this.router.put( "/banks/:bankId/status", this.ctrl.setBankStatus.bind( this.ctrl ) );

    // DELETE /banks/:bankId
    this.router.delete( "/banks/:bankId", this.ctrl.deleteBank.bind( this.ctrl ) );

    // =========================================================================
    // BANK ACCOUNTS (Company Receiving Accounts)
    // =========================================================================
    // GET  /bank-accounts/public?currencyCode=&includeInactive=
    this.router.get( "/bank-accounts/public", this.ctrl.listBankAccountsPublic.bind( this.ctrl ) );

    // POST /bank-accounts/create
    this.router.post( "/bank-accounts/create", this.ctrl.createBankAccount.bind( this.ctrl ) );

    // GET  /bank-accounts/:accountId
    this.router.get( "/bank-accounts/accountId/:accountId", this.ctrl.getBankAccountByAccountId.bind( this.ctrl ) );

    // GET /bank-accounts/alias/:alias
    this.router.get( "/bank-accounts/alias/:alias", this.ctrl.getBankAccountByAccountAlias.bind( this.ctrl ) );

    // PUT  /bank-accounts/update/:accountId
    this.router.put( "/bank-accounts/update/:accountId", this.ctrl.updateBankAccount.bind( this.ctrl ) );

    // PUT  /bank-accounts/default/:accountId
    this.router.put( "/bank-accounts/default/:accountId", this.ctrl.setDefaultBankAccount.bind( this.ctrl ) );

    // DELETE /bank-accounts/delete/:accountId
    this.router.delete( "/bank-accounts/delete/:accountId", this.ctrl.deleteBankAccount.bind( this.ctrl ) );

    // =========================================================================
    // PAYMENT TRANSACTIONS (External Transactions + Verification)
    // =========================================================================
    // POST /transactions/create
    this.router.post( "/transactions/create", this.ctrl.createTransaction.bind( this.ctrl ) );

    // GET  /transactions?page=&limit=&search=&currencyCode=&method=&paymentStatus=&verificationStatus=&bankAccountId=&from=&to=
    this.router.get( "/transactions", this.ctrl.listTransactions.bind( this.ctrl ) );

    // GET  /transactions/count?withByStatus=1&search=...
    this.router.get( "/transactions/count", this.ctrl.countTransactions.bind( this.ctrl ) );

    // POST /transactions/evidence/upload/:transactionId
    this.router.post( '/transactions/evidence/upload/:transactionId', this.ctrl.uploadEvidence.bind( this.ctrl ) );

    // GET  /transactions/:transactionId
    this.router.get( "/transactions/:transactionId", this.ctrl.getTransactionById.bind( this.ctrl ) );

    // PUT  /transactions/:transactionId
    this.router.put( "/transactions/:transactionId", this.ctrl.updateTransaction.bind( this.ctrl ) );

    // DELETE /transactions/:transactionId
    this.router.delete( "/transactions/:transactionId", this.ctrl.deleteTransaction.bind( this.ctrl ) );

    // POST /transactions/:transactionId/approve
    this.router.post( "/transactions/:transactionId/approve", this.ctrl.approveTransaction.bind( this.ctrl ) );

    // POST /transactions/:transactionId/reject
    this.router.post( "/transactions/:transactionId/reject", this.ctrl.rejectTransaction.bind( this.ctrl ) );

    // POST /transactions/:transactionId/status
    this.router.post( "/transactions/:transactionId/status", this.ctrl.changePaymentStatus.bind( this.ctrl ) );


  }
}