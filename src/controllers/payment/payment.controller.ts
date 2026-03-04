// Path: src/controllers/payment/payment.controller.ts
// =============================================================================
// PaymentController — CONTRACT-CORRECT (SystemData keys + strict + company scope)
// -----------------------------------------------------------------------------
// Core rule enforced here:
// - ApiResponseBuilder.ok(res, "<SystemDataKey>", payload)
//   MUST use the keys declared in SystemData:
//     bank | banks | bankAccount | bankAccounts | transaction | transactions
//
// Any cross-cutting metadata (pagination, totals, breakdowns) goes into `other`.
//
// Notes
// - bankSvc expects: { companyId, actor, ... }
// - bankAccountSvc expects: { companyId, actor: ActorMini, ... }
// - txSvc expects: { actor: AuthUserNormalized, ... } and filters include companyId.
// =============================================================================

import type { Request, Response } from "express";

import { ApiResponseBuilder } from "../../utils/api-combiner.builder";
import { ApiGuardExport } from "../../guard/api-router.guard";

import type { ActorMini, AuthUser, AuthUserNormalized } from "../../types/common";

import { BankRegistryService } from "../../services/payments/bank-registry/banks/bank-registry.service";
import { BankAccountService } from "../../services/payments/bank-registry/bank-accounts/bank-accounts.service";
import { PaymentTransactionService } from "../../services/payments/transactions/payment-transaction.service";

import {
  BankStatus,
  type BankCreateInput,
  type BankUpdateInput,
} from "../../types/payments/bank-registry/banks/bank.types";

import type {
  BankAccountCreateInputDto,
  BankAccountUpdateInputDto,
} from "../../types/payments/bank-registry/bank-accounts/bank-account.types";

import {
  PaymentMethodKind,
  PaymentStatus,
  PaymentVerificationStatus,
  type PaymentTransactionApproveInputDto,
  type PaymentTransactionCreateInputDto,
  type PaymentTransactionListFilters,
  type PaymentTransactionListItemDto,
  type PaymentTransactionPaymentStatusInputDto,
  type PaymentTransactionRejectInputDto,
  type PaymentTransactionUpdateInputDto,
} from "../../types/payments/transactions/payment-transaction.types";

import { MongoIdUtil } from "../../utils/mongo-id.util";
import FileUploader from "../../utils/files/file-uploader.helper";

export class PaymentController {
  private readonly bankSvc: BankRegistryService;
  private readonly bankAccountSvc: BankAccountService;
  private readonly txSvc: PaymentTransactionService;

  public constructor () {
    this.bankSvc = new BankRegistryService();
    this.bankAccountSvc = new BankAccountService();
    this.txSvc = new PaymentTransactionService();
  }

  // ===========================================================================
  // BANK REGISTRY (Master Data)
  // ===========================================================================

  /**
   * List banks under company scope.
   *
   * @param req
   * - Query:
   *   - page?: number (default 1)
   *   - limit?: number (default 50, max 200)
   *   - status?: "active" | "inactive"
   *   - countryCca2?: string (e.g., "LK")
   *   - q?: string (search by name/code; service does safe-regex)
   *
   * @param res
   * - SystemData key: `banks`
   * - Meta: other.pagination.total
   */
  public async listBanks( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      // ✅ page/limit match FE + service contract
      const page = this.readInt( req.query.page, 1, 1, 1_000_000 );
      const limit = this.readInt( req.query.limit, 50, 1, 200 );

      // ✅ CHANGED: service expects `search`, NOT `q`
      const search = this.readString( req.query.search );

      // ✅ countryCca2 is optional, but normalize when present
      const countryCca2Raw = this.readString( req.query.countryCca2 );
      const countryCca2 = countryCca2Raw ? countryCca2Raw.toUpperCase() : "";

      // ✅ CHANGED: service expects `onlyActive?: boolean`
      // Parse it safely from query string (because query params are strings)
      const onlyActive = this.readOptionalBool( req.query.onlyActive ); // ✅ NEW helper used

      const result = await this.bankSvc.list( {
        companyId: auth.companyId,
        page,
        limit,
        ...( onlyActive !== undefined ? { onlyActive } : {} ), // ✅ OMIT when undefined
        ...( countryCca2 ? { countryCca2 } : {} ),
        ...( search ? { search } : {} ),
      } );

      ApiResponseBuilder.ok( res, "banks", result.items, "[Success:] Banks loaded.\n", {
        pagination: { total: result.other.total },
      } );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] listBanks:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Read one bank by bankId.
   *
   * @param req.params.bankId
   * - Expected: Bank.bankId
   *
   * @param res
   * - SystemData key: `bank`
   */
  public async getBankByBankId( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const bankId = String( req.params.bankId || "" ).trim();
      if ( !bankId ) {
        ApiResponseBuilder.validationError( res, "bankId is required!" );
        return;
      }

      const item = await this.bankSvc.getByBankId( { companyId: auth.companyId, bankId } );
      if ( !item ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "bank", item, "[Success:] Bank resolved.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] getBankByBankId:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Read one bank by bankCode.
   *
   * @param req.params.bankCode
   * - Expected: Bank.bankCode
   *
   * @param res
   * - SystemData key: `bank`
   */
  public async getByBankCode( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const bankCode = String( req.params.bankCode || "" ).trim();
      if ( !bankCode ) {
        ApiResponseBuilder.validationError( res, "bankId is required!" );
        return;
      }

      const item = await this.bankSvc.getByBankCode( { companyId: auth.companyId, bankCode } );

      if ( !item ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "bank", item, "[Success:] Bank resolved.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] getByBankCode:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Create bank (admin/master data).
   *
   * @param req.body
   * - Expected: BankCreateInput
   *
   * @param res
   * - SystemData key: `bank`
   */
  public async createBank( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const input = req.body as BankCreateInput;

      const created = await this.bankSvc.create( {
        companyId: auth.companyId,
        actor: auth,
        input,
      } );

      if ( !created ) {
        ApiResponseBuilder.fail( res, "Failed to create the bank!" );
        return;
      }

      ApiResponseBuilder.ok( res, "bank", created, "[Success:] Bank created.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] createBank:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Update bank (PATCH semantics).
   *
   * @param req.params.bankId
   * - Expected: Bank.bankId
   *
   * @param req.body
   * - Expected: BankUpdateInput
   *
   * @param res
   * - SystemData key: `bank`
   */
  public async updateBank( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const bankId = String( req.params.bankId || "" ).trim();
      if ( !bankId ) {
        ApiResponseBuilder.validationError( res, "bankId is required!" );
        return;
      }

      const patch = req.body as BankUpdateInput;

      const updated = await this.bankSvc.update( {
        companyId: auth.companyId,
        actor: auth,
        bankId,
        patch,
      } );

      if ( !updated ) {
        ApiResponseBuilder.fail( res, "Failed to update the bank!" );
        return;
      }

      ApiResponseBuilder.ok( res, "bank", updated, "[Success:] Bank updated.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] updateBank:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Set bank status (active/inactive).
   *
   * @param req.params.bankId
   * - Expected: Bank.bankId
   *
   * @param req.body.status
   * - Expected: "active" | "inactive"
   *
   * @param res
   * - SystemData key: `other` with updated flag
   */
  public async setBankStatus( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const bankId = String( req.params.bankId || "" ).trim();
      if ( !bankId ) {
        ApiResponseBuilder.validationError( res, "bankId is required!" );
        return;
      }

      const rawStatus = ( req.body as { status?: unknown; } | null )?.status;
      const status = typeof rawStatus === "string" ? rawStatus.trim() : "";
      if ( !status || !this.isBankStatus( status ) ) {
        ApiResponseBuilder.validationError( res, "Valid status is required (active|inactive)!" );
        return;
      }

      const updated = await this.bankSvc.setStatus( {
        companyId: auth.companyId,
        actor: auth,
        bankId,
        status: status as BankStatus,
      } );

      ApiResponseBuilder.ok( res, "other", { updated }, "[Success:] Bank status updated.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] setBankStatus:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Delete bank via Recycle Bin workflow.
   *
   * @param req.params.bankId
   * - Expected: Bank.bankId
   *
   * @param res
   * - SystemData key: `other` with result
   */
  public async deleteBank( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const bankId = String( req.params.bankId || "" ).trim();
      if ( !bankId ) {
        ApiResponseBuilder.validationError( res, "bankId is required!" );
        return;
      }

      const result = await this.bankSvc.delete( {
        companyId: auth.companyId,
        actor: auth,
        bankId,
        req,
      } );

      ApiResponseBuilder.ok( res, "other", { result }, "[Success:] Bank deleted to recycle bin.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] deleteBank:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  // ===========================================================================
  // BANK ACCOUNTS
  // ===========================================================================

  /**
   * Public-safe list for FE selection dropdowns.
   *
   * @param req.query.currencyCode
   * - Optional: filter (e.g., "LKR")
   *
   * @param req.query.includeInactive
   * - Optional: "1"|"true" to include inactive as well
   *
   * @param res
   * - SystemData key: `bankAccounts`
   */
  public async listBankAccountsPublic( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const includeInactive = this.readBool( req.query.includeInactive );

      const result = await this.bankAccountSvc.listAll( {
        companyId: auth.companyId,
        actor: auth,
        onlyActive: includeInactive ? false : true,
      } );

      ApiResponseBuilder.ok(
        res,
        "bankAccounts",
        result.items,
        "[Success:] Bank accounts loaded.\n",
        {
          pagination: {
            total: result.other.pagination.total
          }
        },
      );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] listBankAccountsPublic:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Admin read one by accountId.
   *
   * @param req.params.accountId
   * - Expected: BankAccount.accountId
   *
   * @param res
   * - SystemData key: `bankAccount`
   */
  public async getBankAccountByAccountId( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const accountId = String( req.params.accountId || "" ).trim();
      if ( !accountId ) {
        ApiResponseBuilder.validationError( res, "accountId is required!" );
        return;
      }

      const item = await this.bankAccountSvc.getByAccountId( {
        companyId: auth.companyId,
        accountId,
        actor: auth,
      } );

      if ( !item ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "bankAccount", item, "[Success:] Bank account resolved.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] getBankAccountByAccountId:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Admin read one by accountId.
   *
   * @param req.params.alias
   * - Expected: BankAccount.accountId
   *
   * @param res
   * - SystemData key: `bankAccount`
   */
  public async getBankAccountByAccountAlias( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const alias = String( req.params.alias || "" ).trim();
      if ( !alias ) {
        ApiResponseBuilder.validationError( res, "accountId is required!" );
        return;
      }

      const item = await this.bankAccountSvc.getByAlias( {
        companyId: auth.companyId,
        alias,
        actor: auth,
      } );

      if ( !item ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "bankAccount", item, "[Success:] Bank account resolved.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] getBankAccountByAccountAlias:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Admin create bank account.
   *
   * @param req.body
   * - Expected: BankAccountCreateInputDto
   *
   * @param res
   * - SystemData key: `bankAccount`
   */
  public async createBankAccount( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const input = req.body as BankAccountCreateInputDto;

      const created = await this.bankAccountSvc.create( {
        companyId: auth.companyId,
        actor: auth,
        input,
      } );

      if ( !created ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "bankAccount", created, "[Success:] Bank account created.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] createBankAccount:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Admin update bank account (PATCH).
   *
   * @param req.params.accountId
   * - Expected: BankAccount.accountId
   *
   * @param req.body
   * - Expected: BankAccountUpdateInputDto
   *
   * @param res
   * - SystemData key: `bankAccount`
   */
  public async updateBankAccount( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const accountId = String( req.params.accountId || "" ).trim();
      if ( !accountId ) {
        ApiResponseBuilder.validationError( res, "accountId is required!" );
        return;
      }

      const patch = req.body as BankAccountUpdateInputDto;

      const updated = await this.bankAccountSvc.update( {
        companyId: auth.companyId,
        actor: auth,
        accountId,
        patch,
      } );

      if ( !updated ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "bankAccount", updated, "[Success:] Bank account updated.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] updateBankAccount:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Delete bank account via Recycle Bin workflow.
   *
   * @param req.params.accountId
   * - Expected: BankAccount.accountId
   *
   * @param res
   * - SystemData key: `other`
   */
  public async deleteBankAccount( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const accountId = String( req.params.accountId || "" ).trim();
      if ( !accountId ) {
        ApiResponseBuilder.validationError( res, "accountId is required!" );
        return;
      }

      const result = await this.bankAccountSvc.delete( {
        companyId: auth.companyId,
        actor: auth,
        accountId,
        req,
      } );

      if ( !result ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "other", { result }, "[Success:] Bank account deleted to recycle bin.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] deleteBankAccount:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Set default bank account for the company.
   *
   * @param req.params.accountId
   * - Expected: BankAccount.accountId
   *
   * @param res
   * - SystemData key: `other`
   */
  public async setDefaultBankAccount( req: Request, res: Response ): Promise<void> {
    try {
      const auth: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !auth?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const accountId = String( req.params.accountId || "" ).trim();
      if ( !accountId ) {
        ApiResponseBuilder.validationError( res, "accountId is required!" );
        return;
      }

      const updated = await this.bankAccountSvc.setDefault( {
        companyId: auth.companyId,
        actor: auth,
        accountId,
      } );

      if ( !updated ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "other", { updated }, "[Success:] Default bank account updated.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] setDefaultBankAccount:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  // ===========================================================================
  // PAYMENT TRANSACTIONS
  // ===========================================================================

  /**
   * Create transaction (with temp upload flow).
   *
   * @param req.body
   * - Expected: PaymentTransactionCreateInputDto
   *
   * @param res
   * - SystemData key: `transaction`
   */
  public async createTransaction( req: Request, res: Response ): Promise<void> {
    try {
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      // ✅ FormData-only: service reads req.body.payload AFTER upload middleware runs
      const created = await this.txSvc.create( { actor, req } );

      ApiResponseBuilder.ok( res, "transaction", created.item, "[Success:] Transaction created.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] createTransaction:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Upload additional evidence.
   *
   * @param req.params.transactionId
   * - Expected: PaymentTransaction.transactionId
   *
   * @param res
   * - SystemData key: `transaction`
   */
  public async uploadEvidence( req: Request, res: Response ): Promise<void> {
    try {
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const transactionId = String( req.params.transactionId || "" ).trim();
      if ( !transactionId ) {
        ApiResponseBuilder.validationError( res, "transactionId is required!" );
        return;
      }

      const item = await this.txSvc.uploadEvidence( { actor, transactionId, req } );

      if ( !item ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "transaction", item.item, "[Success:] Transaction evidence uploaded.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] uploadEvidence:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Read one transaction.
   *
   * @param req.params.transactionId
   * - Expected: PaymentTransaction.transactionId
   *
   * @param res
   * - SystemData key: `transaction`
   */
  public async getTransactionById( req: Request, res: Response ): Promise<void> {
    try {
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const transactionId = String( req.params.transactionId || "" ).trim();
      if ( !transactionId ) {
        ApiResponseBuilder.validationError( res, "transactionId is required!" );
        return;
      }

      const item = await this.txSvc.getByTransactionId( { actor, transactionId } );

      if ( !item ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "transaction", item?.item, "[Success:] Transaction resolved.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] getTransactionById:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Update transaction (PATCH).
   *
   * @param req.params.transactionId
   * - Expected: PaymentTransaction.transactionId
   *
   * @param req.body
   * - Expected: PaymentTransactionUpdateInputDto
   *
   * @param res
   * - SystemData key: `transaction`
   */
  public async updateTransaction( req: Request, res: Response ): Promise<void> {
    try {
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const transactionId = String( req.params.transactionId || "" ).trim();
      if ( !transactionId ) {
        ApiResponseBuilder.validationError( res, "transactionId is required!" );
        return;
      }

      // ✅ FormData-only: service parses req.body.payload and handles evidence append
      const updated = await this.txSvc.update( { actor, transactionId, req } );

      ApiResponseBuilder.ok( res, "transaction", updated.item, "[Success:] Transaction updated.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] updateTransaction:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Delete transaction (Recycle Bin workflow).
   *
   * @param req.params.transactionId
   * - Expected: PaymentTransaction.transactionId
   *
   * @param res
   * - SystemData key: `other`
   */
  public async deleteTransaction( req: Request, res: Response ): Promise<void> {
    try {
      // Must be normalized for txSvc contract
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const transactionId = String( req.params.transactionId || "" ).trim();
      if ( !transactionId ) {
        ApiResponseBuilder.validationError( res, "transactionId is required!" );
        return;
      }

      const result = await this.txSvc.delete( { actor, transactionId, req } );

      if ( !result.entry ) {
        ApiResponseBuilder.notFound( res, "Item does not found!" );
        return;
      }

      ApiResponseBuilder.ok( res, "other", { result }, "[Success:] Transaction deleted to recycle bin.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] deleteTransaction:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * List transactions.
   *
   * @param req.query
   * - page?, limit?
   * - bankAccountId?, currencyCode?, method?, paymentStatus?, verificationStatus?
   * - from?, to?
   * - search? (IMPORTANT: uses `search`, not `q`)
   *
   * @param res
   * - SystemData key: `transactions`
   * - Meta: other.pagination.total
   */
  public async listTransactions( req: Request, res: Response ): Promise<void> {
    try {
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const page = this.readInt( req.query.page, 1, 1, 1_000_000 );
      const limit = this.readInt( req.query.limit, 20, 1, 500 );

      const filters = this.readTxListFilters( req );

      const result = await this.txSvc.list( {
        actor,
        page,
        limit,
        ...( filters ? { filters } : {} ),
      });

      ApiResponseBuilder.ok(
        res,
        "transactions",
        result.items as PaymentTransactionListItemDto[],
        "[Success:] Transactions loaded.\n",
        { pagination: { total: result.other.total } },
      );
      return;
    } catch (err) {
      console.error( "[Error:] [PaymentController:] listTransactions:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Count transactions.
   *
   * @param req.query.withByStatus
   * - Optional: "1"|"true" to include grouped breakdown
   *
   * @param res
   * - SystemData key: `other`
   */
  public async countTransactions( req: Request, res: Response ): Promise<void> {
    try {
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      // ✅ count() already returns breakdown; do NOT pass withByStatus
      const filters = this.readTxListFilters( req );

      const result = await this.txSvc.count( {
        actor,
        ...( filters ? { filters } : {} ),
      });

      ApiResponseBuilder.ok( res, "other", { result }, "[Success:] Transaction count loaded.\n" );
      return;
    } catch (err) {
      console.error( "[Error:] [PaymentController:] countTransactions:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Approve transaction.
   *
   * @param req.params.transactionId
   * - Expected: PaymentTransaction.transactionId
   *
   * @param req.body
   * - Expected: PaymentTransactionApproveInputDto
   *
   * @param res
   * - SystemData key: `transaction`
   */
  public async approveTransaction( req: Request, res: Response ): Promise<void> {
    try {
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const transactionId = String( req.params.transactionId || "" ).trim();

      if ( !transactionId ) {
        ApiResponseBuilder.validationError( res, "transactionId is required!" );
        return;
      }

      const input = req.body as PaymentTransactionApproveInputDto;

      const updated = await this.txSvc.approve( { actor, transactionId, input } );

      ApiResponseBuilder.ok( res, "transaction", updated.item, "[Success:] Transaction approved.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] approveTransaction:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Reject transaction.
   *
   * @param req.params.transactionId
   * - Expected: PaymentTransaction.transactionId
   *
   * @param req.body
   * - Expected: PaymentTransactionRejectInputDto
   *
   * @param res
   * - SystemData key: `transaction`
   */
  public async rejectTransaction( req: Request, res: Response ): Promise<void> {
    try {
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const transactionId = String( req.params.transactionId || "" ).trim();
      if ( !transactionId ) {
        ApiResponseBuilder.validationError( res, "transactionId is required!" );
        return;
      }

      const input = req.body as PaymentTransactionRejectInputDto;

      const updated = await this.txSvc.reject( { actor, transactionId, input } );

      ApiResponseBuilder.ok( res, "transaction", updated.item, "[Success:] Transaction rejected.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] rejectTransaction:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  /**
   * Reject transaction.
   *
   * @param req.params.transactionId
   * - Expected: PaymentTransaction.transactionId
   *
   * @param req.body
   * - Expected: PaymentTransactionRejectInputDto
   *
   * @param res
   * - SystemData key: `transaction`
   */
  public async changePaymentStatus( req: Request, res: Response ): Promise<void> {
    try {
      const actor: AuthUser | null = await ApiGuardExport.GetAuthUser( req );
      if ( !actor?.companyId ) {
        ApiResponseBuilder.conflict( res, "Auth user is invalid!" );
        return;
      }

      const transactionId = String( req.params.transactionId || "" ).trim();
      if ( !transactionId ) {
        ApiResponseBuilder.validationError( res, "transactionId is required!" );
        return;
      }

      const input = req.body as PaymentTransactionPaymentStatusInputDto;

      const updated = await this.txSvc.status( { actor, transactionId, input } );

      ApiResponseBuilder.ok( res, "transaction", updated.item, "[Success:] Transaction payment status changed.\n" );
      return;
    } catch ( err ) {
      console.error( "[Error:] [PaymentController:] changePaymentStatus:\n", err, "\n" );
      ApiResponseBuilder.internalError( res, err );
      return;
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private readInt( v: unknown, fallback: number, min: number, max: number ): number {
    const n = typeof v === "string" ? Number( v ) : typeof v === "number" ? v : NaN;
    if ( !Number.isFinite( n ) ) return fallback;
    const x = Math.floor( n );
    if ( x < min ) return min;
    if ( x > max ) return max;
    return x;
  }

  private readBool( v: unknown ): boolean {
    if ( typeof v !== "string" ) return false;
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }

  private readString( v: unknown ): string {
    if ( typeof v !== "string" ) return "";
    return v.trim();
  }

  private isBankStatus( v: string ): boolean {
    return v === BankStatus.Active || v === BankStatus.Inactive;
  }

  private isIsoDate( v: string ): boolean {
    if ( !v ) return false;
    const d = new Date( v );
    return Number.isFinite( d.getTime() );
  }

  /**
   * Convert AuthUser to ActorMini for audit stamping.
   *
   * @param auth
   * - Expected: AuthUser with userId/username/role available
   * - Purpose: Services store ActorMini in audit fields (createdBy/updatedBy/verifiedBy)
   */
  private toActorMini( auth: AuthUser ): ActorMini {
    return {
      userId: MongoIdUtil.toIdString( auth.userId ),
      username: String( auth.username || "" ).trim() || "unknown",
      role: String( auth.role || "" ).trim() || "unknown",
    };
  }

  /**
   * Build transaction list filters (company boundary + query filters).
   *
   * IMPORTANT:
   * - Contract uses `search` (NOT `q`)
   * - companyId is REQUIRED in PaymentTransactionListFilters
   *
   * @param req
   * - Express request (query inputs)
   *
   * @param companyId
   * - Tenant boundary id from auth context (required by contract)
   */
  private readTxListFilters( req: Request ): PaymentTransactionListFilters | null {
    // ✅ NEW: alias-only (match model + service)
    const bankAccountAlias = this.readString( req.query.bankAccountAlias );

    const currencyCodeRaw = this.readString( req.query.currencyCode );
    const currencyCode = currencyCodeRaw ? currencyCodeRaw.toUpperCase() : "";

    const methodRaw = this.readString( req.query.method );
    const paymentStatusRaw = this.readString( req.query.paymentStatus );
    const verificationStatusRaw = this.readString( req.query.verificationStatus );

    const fromRaw = this.readString( req.query.from );
    const toRaw = this.readString( req.query.to );

    const search = this.readString( req.query.search );

    const out: PaymentTransactionListFilters = {};

    if ( bankAccountAlias ) out.bankAccountAlias = bankAccountAlias;
    if ( currencyCode ) out.currencyCode = currencyCode;

    if ( methodRaw && this.isPaymentMethodKind( methodRaw ) ) out.method = methodRaw as PaymentMethodKind;
    if ( paymentStatusRaw && this.isPaymentStatus( paymentStatusRaw ) ) out.paymentStatus = paymentStatusRaw as PaymentStatus;

    if ( verificationStatusRaw && this.isVerificationStatus( verificationStatusRaw ) ) {
      out.verificationStatus = verificationStatusRaw as PaymentVerificationStatus;
    }

    if ( this.isIsoDate( fromRaw ) ) out.from = fromRaw as any;
    if ( this.isIsoDate( toRaw ) ) out.to = toRaw as any;

    if ( search ) out.search = search;

    return Object.keys( out ).length > 0 ? out : null;
  }

  private isPaymentMethodKind( v: string ): boolean {
    return (
      v === PaymentMethodKind.BankTransfer ||
      v === PaymentMethodKind.Cash ||
      v === PaymentMethodKind.Cheque ||
      v === PaymentMethodKind.Card ||
      v === PaymentMethodKind.Gateway
    );
  }

  private isPaymentStatus( v: string ): boolean {
    return (
      v === PaymentStatus.Pending ||
      v === PaymentStatus.Paid ||
      v === PaymentStatus.Failed ||
      v === PaymentStatus.Refunded ||
      v === PaymentStatus.Voided
    );
  }

  private isVerificationStatus( v: string ): boolean {
    return (
      v === PaymentVerificationStatus.Unverified ||
      v === PaymentVerificationStatus.Submitted ||
      v === PaymentVerificationStatus.Approved ||
      v === PaymentVerificationStatus.Rejected
    );
  }

  /**
 * ✅ NEW: optional boolean reader for query params
 * - returns: true | false | undefined
 * - undefined means "not provided" (so you can omit it)
 */
  private readOptionalBool( v: unknown ): boolean | undefined {
    if ( typeof v !== "string" ) return undefined;
    const s = v.trim().toLowerCase();
    if ( !s ) return undefined;

    if ( s === "1" || s === "true" || s === "yes" || s === "on" ) return true;
    if ( s === "0" || s === "false" || s === "no" || s === "off" ) return false;

    return undefined;
  }
}