// Path: src/services/payments/bank-registry/bank-accounts/bank-accounts.service.ts
// =============================================================================
// BankAccountWriteService — Role-aware CRUD + DTO Projection (company-scoped)
// =============================================================================
//
// 01. Introduction
// - Implements BankAccount write operations (create/update/delete/set-default).
// - Implements role-aware READ/LIST projection:
//   - Privileged roles => Admin DTO (raw accountNumber/iban allowed)
//   - Others           => Public DTO (masked-only)
//
// 02. Important matters (ISO/IEC 27001/27002 mindset)
// - accountNumber/iban are sensitive: never log them.
// - Always scope queries by companyId (derived by controller from AuthUser).
// - Optional props MUST be OMITTED (never assign undefined).
// - No transactions assumed; "single default" is best-effort.
// - Backend decides data visibility; FE must not filter sensitive fields.
//
// 03. Why this class
// - Single enforcement point for RBAC + projection + audit + notifications.
// =============================================================================

import { randomUUID } from "crypto";
import type { ClientSession, Types } from "mongoose";
import { Request } from "express";

import { BankModel } from "../../../../models/payments/bank-registry/bank.model";
import {
  BankAccountModel,
  type IBankAccount,
} from "../../../../models/payments/bank-registry/bank-account.model";

import {
  BankAccountStatus,
  type BankAccountAdminDto,
  type BankAccountPublicDto,
  type BankAccountCreateInputDto,
  type BankAccountUpdateInputDto,
} from "../../../../types/payments/bank-registry/bank-accounts/bank-account.types";

import type {
  ActorMini,
  AuthUser,
  AuthUserNormalized,
  ISODateString,
  ListResponseDto,
} from "../../../../types/common";

import type { BankStatus } from "../../../../types/payments/bank-registry/banks/bank.types";

import {
  RecycleBinDomainDeleteService,
  type DomainDeletePlan,
} from "../../../recyclebin/recyclebin-domain-delete.service";
import type { RecycleRecordResult } from "../../../recyclebin/recyclebin-engine.service";

import { NotificationHubEngineService } from "../../../notifications/notification-hub-engine.service";
import { MongoIdUtil } from "../../../../utils/mongo-id.util";

import type { NotificationActionKey } from "../../../../types/notification/notification-action-keys.catalog";

// =============================================================================
// Lean Shapes (DB -> service mapping inputs)
// =============================================================================

/**
 * Minimal bank shape required to create snapshots on BankAccount.
 * - We intentionally do NOT populate in this service; we validate + snapshot.
 */
interface BankLeanForSnapshot {
  _id: Types.ObjectId | unknown;
  bankId: string;
  companyId: string;

  name: string;
  countryCca2: string;

  bankCode?: string;
  swiftBic?: string;

  status: BankStatus;
}

/**
 * Lean view of BankAccount stored doc.
 * - Includes sensitive fields because DB stores them.
 * - Projection logic decides whether those fields reach FE.
 */
interface BankAccountLean {
  _id: unknown;

  accountId: string;
  companyId: string;

  alias: string;

  bankRefId: unknown;
  bankId: string;
  bankCode: string;

  bankNameSnapshot?: string;
  bankCodeSnapshot?: string;
  swiftBicSnapshot?: string;
  bankCountrySnapshot?: string;

  accountHolderName: string;

  // sensitive (admin-only in DTO)
  accountNumber: string;
  iban?: string;

  // safe UI fields (stored, required)
  accountNumberMasked: string;
  accountNumberLast4: string;

  branchName?: string;
  branchCode?: string;

  currencyCode: string;

  isDefault: boolean;
  status: BankAccountStatus;

  notes?: string;

  createdBy: ActorMini;
  updatedBy?: ActorMini;

  createdAt: Date | string;
  updatedAt: Date | string;
}



/**
 * Role-aware return type.
 * - Admin => BankAccountAdminDto
 * - Non-admin => BankAccountPublicDto
 */
export type BankAccountProjectedDto = BankAccountAdminDto | BankAccountPublicDto;

export class BankAccountService {
  // ---------------------------------------------------------------------------
  // 01) Introduction to the class and its usage
  // - Use from controller (companyId derived from AuthUser, never accepted from FE)
  // - Controller passes AuthUser as actor
  // ---------------------------------------------------------------------------

  private readonly notificationHub: NotificationHubEngineService =
    new NotificationHubEngineService();

  private readonly deleteSvc: RecycleBinDomainDeleteService =
    new RecycleBinDomainDeleteService();

  public constructor () {}

  // ===========================================================================
  // CREATE (role does not block create)
  // ===========================================================================

  /**
   * Create a bank account.
   *
   * Why we make this method
   * - Any authenticated user can add an account, but the returned DTO must be
   *   projected by role (admin gets raw fields, others get masked-only).
   *
   * @param options.companyId
   * - Expected: company id derived by controller from AuthUser context
   *
   * @param options.actor
   * - Expected: AuthUser (RecycleBin expects AuthUser; keep it as-is)
   *
   * @param options.input
   * - Expected: BankAccountCreateInputDto (raw accountNumber required)
   */
  public async create( options: {
    companyId: string;
    actor: AuthUser;
    input: BankAccountCreateInputDto;
  } ): Promise<BankAccountProjectedDto> {
    const companyId = this.mustString( options.companyId, "companyId" );

    const minActor = this.toActorMini( options.actor );
    const normalizedActor = this.toAuthUserNormalized( options.actor );

    // Required inputs
    const alias = this.mustString( options.input.alias, "alias" );
    const bankId = this.mustString( options.input.bankId, "bankId" );
    const bankCode = this.mustString( options.input.bankCode, "bankCode" );

    const accountHolderName = this.mustString(
      options.input.accountHolderName,
      "accountHolderName"
    );
    const accountNumber = this.mustString(
      options.input.accountNumber,
      "accountNumber"
    );
    const currencyCode = this.mustString(
      options.input.currencyCode,
      "currencyCode"
    ).toUpperCase();

    // Optional inputs (omit when absent)
    const iban = this.optTrim( options.input.iban );
    const branchName = this.optTrim( options.input.branchName );
    const branchCode = this.optTrim( options.input.branchCode );
    const notes = this.optTrim( options.input.notes );

    const isDefault = options.input.isDefault === true;

    // status wins over isActive
    const status =
      this.normalizeStatus(
        this.buildStatusArgs( {
          status: options.input.status,
          isActive: options.input.isActive,
          fallback: BankAccountStatus.Active,
        } )
      ) ?? BankAccountStatus.Active;

    // Validate bank + build snapshots
    const bank = await this.loadBankForCompany( { companyId, bankId, bankCode } );

    // Derived safe fields (REQUIRED by model)
    const masked = this.buildMaskedAccountFields( accountNumber );

    // Best-effort single default
    if ( isDefault ) {
      await this.clearDefaultForCompany( {
        companyId,
        actorMini: minActor,
      } );
    }

    const now = new Date();

    // IMPORTANT: Omit optionals (never set undefined)
    const doc: Omit<IBankAccount, "_id"> = {
      accountId: this.newAccountId(),
      companyId,

      alias,

      bankRefId: bank.bankRefId,
      bankId: bank.bankId,
      bankCode: bank.bankCode,


      ...( bank.bankNameSnapshot ? { bankNameSnapshot: bank.bankNameSnapshot } : {} ),
      ...( bank.bankCodeSnapshot ? { bankCodeSnapshot: bank.bankCodeSnapshot } : {} ),
      ...( bank.swiftBicSnapshot ? { swiftBicSnapshot: bank.swiftBicSnapshot } : {} ),
      ...( bank.bankCountrySnapshot
        ? { bankCountrySnapshot: bank.bankCountrySnapshot }
        : {} ),

      accountHolderName,
      accountNumber,
      ...( iban ? { iban } : {} ),

      accountNumberMasked: masked.accountNumberMasked,
      accountNumberLast4: masked.accountNumberLast4,

      ...( branchName ? { branchName } : {} ),
      ...( branchCode ? { branchCode } : {} ),

      currencyCode,

      isDefault,
      status,

      ...( notes ? { notes } : {} ),

      createdBy: minActor,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const created = await BankAccountModel.create( doc );

      // Re-load as lean for consistent mapping
      const lean = await BankAccountModel.findById( created._id ).lean<
        BankAccountLean | null
      >();
      if ( !lean ) {
        throw new Error(
          "[Error:] BankAccount created but failed to re-load.\n"
        );
      }

      await this.emitNotificationSafe( {
        eventKey: "payment:bank.account.created",
        actionKey: "payment:bank.account.created",
        actor: normalizedActor,
        refMongoId: lean._id,
        module: "Bank Account Management",
        params: {
          bankAccountId: MongoIdUtil.toIdString( lean._id ),
          accountId: lean.accountId,
          alias: lean.alias,
        },
      } );

      return this.projectDtoByRole( options.actor, lean );
    } catch ( err: unknown ) {
      throw this.wrapMongoDuplicateKey( err, "create" );
    }
  }

  // ===========================================================================
  // READ ONE (role-aware projection)
  // ===========================================================================

  /**
   * Read one bank account (company-scoped).
   *
   * @param options.companyId
   * - Expected: company id derived from AuthUser context
   *
   * @param options.actor
   * - Expected: AuthUser; projection depends on role
   *
   * @param options.accountId
   * - Expected: bank account app id
   */
  public async getByAccountId( options: {
    companyId: string;
    actor: AuthUser;
    accountId: string;
  } ): Promise<BankAccountProjectedDto | null> {
    const companyId = this.mustString( options.companyId, "companyId" );
    const accountId = this.mustString( options.accountId, "accountId" );

    const found = await BankAccountModel.findOne( { companyId, accountId } ).lean<
      BankAccountLean | null
    >();
    if ( !found ) return null;

    return this.projectDtoByRole( options.actor, found );
  }

  // ===========================================================================
  // READ ONE BY ALIAS (role-aware projection)
  // ===========================================================================

  /**
   * Read one bank account by `alias` (company-scoped).
   *
   * Why we add this:
   * - Transactions will store only `bankAccountAlias` (human-readable + unique).
   * - So services/controllers can resolve the bank account without exposing IDs.
   *
   * Important matters:
   * - Always scope by `companyId` (tenant boundary).
   * - Alias is treated as case-sensitive unless you enforce normalization (recommended).
   *
   * @param options.companyId
   * - Expected: company id derived from AuthUser context
   *
   * @param options.actor
   * - Expected: AuthUser; projection depends on role (admin gets full, others masked)
   *
   * @param options.alias
   * - Expected: bank account alias (BankAccount.alias)
   * - Example: "Main LKR - BOC"
   */
  public async getByAlias( options: {
    companyId: string;
    actor: AuthUser;
    alias: string;
  } ): Promise<BankAccountProjectedDto | null> {
    const companyId = this.mustString( options.companyId, "companyId" );
    const alias = this.mustString( options.alias, "alias" );

    // Optional normalization rule (only if you already normalize alias on write)
    // const aliasKey = alias.trim();

    const found = await BankAccountModel.findOne( { companyId, alias } ).lean<
      BankAccountLean | null
    >();

    if ( !found ) return null;

    return this.projectDtoByRole( options.actor, found );
  }

  // ===========================================================================
  // LIST (role-aware projection)
  // ===========================================================================

  /**
   * List bank accounts (company-scoped).
   *
   * @param options.onlyActive
   * - If true, returns only status=active
   *
   * Keep in mind
   * - This is a simple list; your future read-service can implement paging/filters.
   */
  public async listAll( options: {
    companyId: string;
    actor: AuthUser;
    onlyActive?: boolean;
  } ): Promise<ListResponseDto<BankAccountProjectedDto>> {
    const companyId = this.mustString( options.companyId, "companyId" );
    const onlyActive = options.onlyActive === true;

    const q: Record<string, unknown> = { companyId };
    if ( onlyActive ) q.status = BankAccountStatus.Active;

    const [ items, total ] = await Promise.all(
      [
        BankAccountModel.find( q )
          .sort( { isDefault: -1, updatedAt: -1 } )
          .lean<BankAccountLean[]>(),
        BankAccountModel.countDocuments( q ),
      ]
    );

    const data: ListResponseDto<BankAccountProjectedDto> = {
      items: items.map( ( x ) => this.projectDtoByRole( options.actor, x ) ),
      other: {
        pagination: {
          total,
        }
      },
    };
    return data;
  }

  // ===========================================================================
  // UPDATE (admin-only; full-field access)
  // ===========================================================================

  /**
   * Update bank account (PATCH).
   *
   * Why we make this method
   * - Enforces “admin gets full access” policy (all fields accessible).
   * - Ensures masked fields are recomputed if accountNumber changes.
   *
   * @param options.patch
   * - Expected: BankAccountUpdateInputDto
   * - Omitted properties are ignored.
   * - Empty strings are treated as invalid for required-like fields, and as UNSET
   *   for optional fields (iban/branch/notes).
   */
  public async update( options: {
    companyId: string;
    actor: AuthUser;
    accountId: string;
    patch: BankAccountUpdateInputDto;
  } ): Promise<BankAccountProjectedDto> {
    this.assertAdminAccess( options.actor, "update" );

    const companyId = this.mustString( options.companyId, "companyId" );
    const accountId = this.mustString( options.accountId, "accountId" );

    const minActor = this.toActorMini( options.actor );
    const normalizedActor = this.toAuthUserNormalized( options.actor );

    // Best-effort: if set default, clear other defaults
    if ( options.patch.isDefault === true ) {
      await this.clearDefaultForCompany( {
        companyId,
        exceptAccountId: accountId,
        actorMini: minActor,
      } );
    }

    const setDoc: Record<string, unknown> = {};
    const unsetDoc: Record<string, 1> = {};

    // alias
    if ( this.hasText( options.patch.alias ) ) {
      setDoc.alias = this.mustString( options.patch.alias, "alias" );
    } else if ( options.patch.alias !== undefined ) {
      throw new Error( "[Error:] alias cannot be empty.\n" );
    }

    // bank change -> refresh snapshots + mongo ref
    if ( this.hasText( options.patch.bankId ) ) {
      const nextBankId = this.mustString( options.patch.bankId, "bankId" );
      const nextBankCode = this.mustString( options.patch.bankCode, "bankCode" );
      const bank = await this.loadBankForCompany( { companyId, bankId: nextBankId, bankCode: nextBankCode } );

      setDoc.bankId = bank.bankId;
      setDoc.bankRefId = bank.bankRefId;

      this.applyOptionalSnapshot( setDoc, unsetDoc, "bankNameSnapshot", bank.bankNameSnapshot );
      this.applyOptionalSnapshot( setDoc, unsetDoc, "bankCodeSnapshot", bank.bankCodeSnapshot );
      this.applyOptionalSnapshot( setDoc, unsetDoc, "swiftBicSnapshot", bank.swiftBicSnapshot );
      this.applyOptionalSnapshot( setDoc, unsetDoc, "bankCountrySnapshot", bank.bankCountrySnapshot );
    }

    // holder name
    if ( this.hasText( options.patch.accountHolderName ) ) {
      setDoc.accountHolderName = this.mustString(
        options.patch.accountHolderName,
        "accountHolderName"
      );
    }

    // accountNumber -> recompute masked/last4
    if ( this.hasText( options.patch.accountNumber ) ) {
      const nextAcc = this.mustString( options.patch.accountNumber, "accountNumber" );
      const masked = this.buildMaskedAccountFields( nextAcc );

      setDoc.accountNumber = nextAcc;
      setDoc.accountNumberMasked = masked.accountNumberMasked;
      setDoc.accountNumberLast4 = masked.accountNumberLast4;
    } else if ( options.patch.accountNumber !== undefined ) {
      throw new Error( "[Error:] accountNumber cannot be empty.\n" );
    }

    // optional set/unset
    this.applyOptSetOrUnset( setDoc, unsetDoc, "iban", options.patch.iban );
    this.applyOptSetOrUnset( setDoc, unsetDoc, "branchName", options.patch.branchName );
    this.applyOptSetOrUnset( setDoc, unsetDoc, "branchCode", options.patch.branchCode );
    this.applyOptSetOrUnset( setDoc, unsetDoc, "notes", options.patch.notes );

    // currency
    if ( this.hasText( options.patch.currencyCode ) ) {
      setDoc.currencyCode = this.mustString(
        options.patch.currencyCode,
        "currencyCode"
      ).toUpperCase();
    } else if ( options.patch.currencyCode !== undefined ) {
      throw new Error( "[Error:] currencyCode cannot be empty.\n" );
    }

    // isDefault
    if ( typeof options.patch.isDefault === "boolean" ) {
      setDoc.isDefault = options.patch.isDefault;
    }

    const nextStatus = this.normalizeStatus(
      this.buildStatusArgs( {
        status: options.patch.status,
        isActive: options.patch.isActive,
      } )
    );
    if ( nextStatus ) setDoc.status = nextStatus;



    // audit
    setDoc.updatedBy = minActor;
    setDoc.updatedAt = new Date();

    // Build mongo operator document
    const op: Record<string, unknown> = {};
    if ( Object.keys( setDoc ).length > 0 ) op.$set = setDoc;
    if ( Object.keys( unsetDoc ).length > 0 ) op.$unset = unsetDoc;

    if ( Object.keys( op ).length === 0 ) {
      throw new Error( "[Warning:] No update fields provided.\n" );
    }

    try {
      const updated = await BankAccountModel.findOneAndUpdate(
        { companyId, accountId },
        op,
        { new: true }
      ).lean<BankAccountLean | null>();

      if ( !updated ) throw new Error( "[Error:] BankAccount not found.\n" );

      await this.emitNotificationSafe( {
        eventKey: "payment:bank.account.updated",
        actionKey: "payment:bank.account.updated",
        actor: normalizedActor,
        refMongoId: updated._id,
        module: "Bank Account Management",
        params: {
          bankAccountId: MongoIdUtil.toIdString( updated._id ),
          accountId: updated.accountId,
          alias: updated.alias,
        },
      } );

      return this.projectDtoByRole( options.actor, updated );
    } catch ( err: unknown ) {
      throw this.wrapMongoDuplicateKey( err, "update" );
    }
  }

  // ===========================================================================
  // DELETE (admin-only) — RecycleBin + Notifications
  // ===========================================================================

  /**
   * Delete bank account (Recycle Bin soft-delete).
   *
   * Important matters
   * - AuthUser MUST be passed to recyclebin engine (do not normalize type).
   * - Snapshot includes sensitive fields; RecycleBin is privileged storage.
   */
  public async delete( options: {
    companyId: string;
    actor: AuthUser;
    accountId: string;
    req: Request
  } ): Promise<{ deleted: boolean; entry: RecycleRecordResult | null; }> {
    this.assertAdminAccess( options.actor, "delete" );

    const companyId = this.mustString( options.companyId, "companyId" );
    const accountId = this.mustString( options.accountId, "accountId" );

    const normalizedActor = this.toAuthUserNormalized( options.actor );

    const exist = await BankAccountModel.findOne( { companyId, accountId } )
      .lean<BankAccountLean | null>()
      .exec();

    if ( !exist ) {
      console.error(
        "[Error:] [BankAccountWriteService:] delete: Bank account does not exist!\n"
      );
      return { deleted: false, entry: null };
    }

    const refMongoIdStr = MongoIdUtil.toIdString( exist._id );

    const plan: DomainDeletePlan<BankAccountLean> = {
      collectionName: BankAccountModel.collection.name,
      files: [],
      label: `Bank account: ${ exist.accountId } (${ exist.alias })`,
      refId: refMongoIdStr,
      snapshotData: exist as unknown as Record<string, unknown>,
      sourceKey: "bankAccount",
      module: "Bank Account Management",
      tags: [ "account", "bank" ],
      deleteDbRecord: async ( session?: ClientSession ): Promise<void> => {
        const opts = session ? { session } : {};
        await BankAccountModel.deleteOne( { companyId, accountId }, opts );
        return;
      },
    };

    const result = await this.deleteSvc.deleteWithRecycleBin( options.actor, plan, options.req );

    await this.emitNotificationSafe( {
      eventKey: "payment:bank.account.deleted",
      actionKey: "payment:bank.account.deleted",
      actor: normalizedActor,
      refMongoId: exist._id,
      module: "Bank Account Management",
      params: {
        bankAccountId: refMongoIdStr,
        accountId: exist.accountId,
        alias: exist.alias,
      },
    } );

    return { deleted: Boolean( result.entry ), entry: result.entry };
  }

  // ===========================================================================
  // SET DEFAULT (admin-only)
  // ===========================================================================

  /**
   * Set default account for company (best-effort).
   *
   * Why we make this method
   * - Enforces UI requirement: one default account per company.
   *
   * Keep in mind
   * - Not transactional. If you need strict atomicity later, add session/tx.
   */
  public async setDefault( options: {
    companyId: string;
    actor: AuthUser;
    accountId: string;
  } ): Promise<BankAccountProjectedDto> {
    this.assertAdminAccess( options.actor, "setDefault" );

    const companyId = this.mustString( options.companyId, "companyId" );
    const accountId = this.mustString( options.accountId, "accountId" );

    const minActor = this.toActorMini( options.actor );

    await this.clearDefaultForCompany( {
      companyId,
      exceptAccountId: accountId,
      actorMini: minActor,
    } );

    const updated = await BankAccountModel.findOneAndUpdate(
      { companyId, accountId },
      {
        $set: {
          isDefault: true,
          updatedBy: minActor,
          updatedAt: new Date(),
        },
      },
      { new: true }
    ).lean<BankAccountLean | null>();

    if ( !updated ) throw new Error( "[Error:] BankAccount not found.\n" );

    return this.projectDtoByRole( options.actor, updated );
  }

  // ===========================================================================
  // RBAC + Projection (core requirement)
  // ===========================================================================

  /**
   * Decide if actor is privileged (admin-level).
   *
   * Keep in mind
   * - Centralize role policy here. If you add roles later, update this method only.
   */
  private isPrivilegedRole( actor: AuthUser ): boolean {
    const role = this.optTrim( actor.role );
    if ( !role ) return false;

    const key = role.toLowerCase();
    return (
      key === "admin" ||
      key === "ceo" ||
      key === "cfo" ||
      key === "cio" ||
      key === "coo" ||
      key === "cto"
    );
  }

  /**
   * Enforce admin-only operations (update/delete/setDefault).
   */
  private assertAdminAccess(
    actor: AuthUser,
    action: "update" | "delete" | "setDefault"
  ): void {
    if ( this.isPrivilegedRole( actor ) ) return;
    throw new Error( `[Error:] Access denied for action: ${ action }\n` );
  }

  /**
   * Project DB record into DTO based on actor role.
   * - Admin => AdminDto (raw fields allowed)
   * - Others => PublicDto (safe only)
   */
  private projectDtoByRole(
    actor: AuthUser,
    doc: BankAccountLean
  ): BankAccountProjectedDto {
    if ( this.isPrivilegedRole( actor ) ) {
      return this.toAdminDto( doc );
    }
    return this.toPublicDto( doc );
  }

  // ===========================================================================
  // Bank lookup + snapshot builder (validation)
  // ===========================================================================

  /**
   * Load bank for company and build snapshot packet used on BankAccount.
   *
   * @param options.companyId
   * - Expected: company scope
   *
   * @param options.bankId
   * - Expected: bank app id (not mongo id)
   */
  private async loadBankForCompany( options: {
    companyId: string;
    bankId: string;
    bankCode: string;
  } ): Promise<{
    bankRefId: Types.ObjectId;
    bankId: string;
    bankCode: string;
    bankNameSnapshot: string;
    bankCodeSnapshot?: string;
    swiftBicSnapshot?: string;
    bankCountrySnapshot: string;
  }> {
    const companyId = this.mustString( options.companyId, "companyId" );
    const bankId = this.mustString( options.bankId, "bankId" );
    const bankCode = this.mustString( options.bankCode, "bankCode" );

    const bank = await BankModel.findOne( { companyId, bankId, bankCode } ).lean<
      BankLeanForSnapshot | null
    >();
    if ( !bank ) throw new Error( "[Error:] Bank not found for given bankId.\n" );

    if ( String( bank.status ) !== "active" ) {
      throw new Error( "[Error:] Cannot link an inactive bank.\n" );
    }

    const bankRefId = bank._id as Types.ObjectId;

    const bankNameSnapshot = this.mustString( bank.name, "bank.name" );
    const bankCountrySnapshot = this.mustString(
      bank.countryCca2,
      "bank.countryCca2"
    ).toUpperCase();

    const bankCodeSnapshot = this.optTrim( bank.bankCode );
    const swiftBicSnapshot = this.optTrim( bank.swiftBic );

    return {
      bankRefId,
      bankId: this.mustString( bank.bankId, "bank.bankId" ),
      bankCode: this.mustString( bank.bankCode, "bank.bankCode" ),
      bankNameSnapshot,
      ...( bankCodeSnapshot ? { bankCodeSnapshot } : {} ),
      ...( swiftBicSnapshot ? { swiftBicSnapshot } : {} ),
      bankCountrySnapshot,
    };
  }

  /**
   * Clear default flag for company (best-effort).
   *
   * @param options.exceptAccountId
   * - Optional: keep this account default; clear others
   *
   * @param options.actorMini
   * - Optional: if provided, writes audit fields on cleared docs
   */
  private async clearDefaultForCompany( options: {
    companyId: string;
    exceptAccountId?: string;
    actorMini?: ActorMini;
  } ): Promise<void> {
    const companyId = this.mustString( options.companyId, "companyId" );
    const exceptAccountId = this.optTrim( options.exceptAccountId );

    const q: Record<string, unknown> = { companyId, isDefault: true };
    if ( exceptAccountId ) q.accountId = { $ne: exceptAccountId };

    const setDoc: Record<string, unknown> = { isDefault: false };
    if ( options.actorMini ) {
      setDoc.updatedBy = options.actorMini;
      setDoc.updatedAt = new Date();
    }

    await BankAccountModel.updateMany( q, { $set: setDoc } );
  }

  private applyOptionalSnapshot(
    setDoc: Record<string, unknown>,
    unsetDoc: Record<string, 1>,
    field:
      | "bankNameSnapshot"
      | "bankCodeSnapshot"
      | "swiftBicSnapshot"
      | "bankCountrySnapshot",
    value?: string
  ): void {
    const v = this.optTrim( value );
    if ( !v ) {
      unsetDoc[ field ] = 1;
      return;
    }
    setDoc[ field ] = v;
  }

  // ===========================================================================
  // DTO mapping (Admin + Public) — MUST MATCH TYPES FILE 100%
  // ===========================================================================

  /**
   * Map to Admin DTO (includes raw accountNumber + optional iban).
   */
  private toAdminDto( doc: BankAccountLean ): BankAccountAdminDto {
    const createdAt = this.toIso( doc.createdAt );
    const updatedAt = this.toIso( doc.updatedAt );
    const isActive = doc.status === BankAccountStatus.Active;

    const dto: BankAccountAdminDto = {
      _id: MongoIdUtil.toIdString( doc._id ),

      accountId: this.mustString( doc.accountId, "accountId" ),
      companyId: this.mustString( doc.companyId, "companyId" ),

      alias: this.mustString( doc.alias, "alias" ),
      bankId: this.mustString( doc.bankId, "bankId" ),
      bankCode: this.mustString( doc.bankCode, "bankCode" ),

      ...( this.hasText( doc.bankNameSnapshot )
        ? {
          bankNameSnapshot: this.mustString(
            doc.bankNameSnapshot,
            "bankNameSnapshot"
          ),
        }
        : {} ),
      ...( this.hasText( doc.bankCodeSnapshot )
        ? {
          bankCodeSnapshot: this.mustString(
            doc.bankCodeSnapshot,
            "bankCodeSnapshot"
          ),
        }
        : {} ),
      ...( this.hasText( doc.swiftBicSnapshot )
        ? {
          swiftBicSnapshot: this.mustString(
            doc.swiftBicSnapshot,
            "swiftBicSnapshot"
          ),
        }
        : {} ),
      ...( this.hasText( doc.bankCountrySnapshot )
        ? {
          bankCountrySnapshot: this.mustString(
            doc.bankCountrySnapshot,
            "bankCountrySnapshot"
          ).toUpperCase(),
        }
        : {} ),

      accountHolderName: this.mustString( doc.accountHolderName, "accountHolderName" ),

      // raw (admin only)
      accountNumber: this.mustString( doc.accountNumber, "accountNumber" ),
      ...( this.hasText( doc.iban ) ? { iban: this.mustString( doc.iban, "iban" ) } : {} ),

      // safe fields
      accountNumberMasked: this.mustString( doc.accountNumberMasked, "accountNumberMasked" ),
      accountNumberLast4: this.mustString( doc.accountNumberLast4, "accountNumberLast4" ),

      ...( this.hasText( doc.branchName )
        ? { branchName: this.mustString( doc.branchName, "branchName" ) }
        : {} ),
      ...( this.hasText( doc.branchCode )
        ? { branchCode: this.mustString( doc.branchCode, "branchCode" ) }
        : {} ),

      currencyCode: this.mustString( doc.currencyCode, "currencyCode" ).toUpperCase(),

      isDefault: Boolean( doc.isDefault ),
      status: doc.status,
      isActive,

      ...( this.hasText( doc.notes )
        ? { notes: this.mustString( doc.notes, "notes" ) }
        : {} ),

      createdBy: this.mustActor( doc.createdBy ),
      ...( doc.updatedBy ? { updatedBy: this.mustActor( doc.updatedBy ) } : {} ),

      createdAt,
      updatedAt,
    };

    return dto;
  }

  /**
   * Map to Public DTO (masked-only; no raw fields).
   */
  private toPublicDto( doc: BankAccountLean ): BankAccountPublicDto {
    const createdAt = this.toIso( doc.createdAt );
    const updatedAt = this.toIso( doc.updatedAt );
    const isActive = doc.status === BankAccountStatus.Active;

    const dto: BankAccountPublicDto = {
      _id: MongoIdUtil.toIdString( doc._id ),

      accountId: this.mustString( doc.accountId, "accountId" ),
      companyId: this.mustString( doc.companyId, "companyId" ),

      alias: this.mustString( doc.alias, "alias" ),
      bankId: this.mustString( doc.bankId, "bankId" ),
      bankCode: this.mustString( doc.bankCode, "bankCode" ),

      ...( this.hasText( doc.bankNameSnapshot )
        ? {
          bankNameSnapshot: this.mustString(
            doc.bankNameSnapshot,
            "bankNameSnapshot"
          ),
        }
        : {} ),
      ...( this.hasText( doc.bankCodeSnapshot )
        ? {
          bankCodeSnapshot: this.mustString(
            doc.bankCodeSnapshot,
            "bankCodeSnapshot"
          ),
        }
        : {} ),
      ...( this.hasText( doc.swiftBicSnapshot )
        ? {
          swiftBicSnapshot: this.mustString(
            doc.swiftBicSnapshot,
            "swiftBicSnapshot"
          ),
        }
        : {} ),
      ...( this.hasText( doc.bankCountrySnapshot )
        ? {
          bankCountrySnapshot: this.mustString(
            doc.bankCountrySnapshot,
            "bankCountrySnapshot"
          ).toUpperCase(),
        }
        : {} ),

      accountHolderName: this.mustString( doc.accountHolderName, "accountHolderName" ),

      // safe only
      accountNumberMasked: this.mustString( doc.accountNumberMasked, "accountNumberMasked" ),
      accountNumberLast4: this.mustString( doc.accountNumberLast4, "accountNumberLast4" ),

      ...( this.hasText( doc.branchName )
        ? { branchName: this.mustString( doc.branchName, "branchName" ) }
        : {} ),
      ...( this.hasText( doc.branchCode )
        ? { branchCode: this.mustString( doc.branchCode, "branchCode" ) }
        : {} ),

      currencyCode: this.mustString( doc.currencyCode, "currencyCode" ).toUpperCase(),

      isDefault: Boolean( doc.isDefault ),
      status: doc.status,
      isActive,

      // notes intentionally omitted for public by policy
      createdBy: this.mustActor( doc.createdBy ),
      ...( doc.updatedBy ? { updatedBy: this.mustActor( doc.updatedBy ) } : {} ),

      createdAt,
      updatedAt,
    };

    return dto;
  }

  // ===========================================================================
  // Notifications (best-effort)
  // ===========================================================================

  private async emitNotificationSafe( options: {
    eventKey: NotificationActionKey;
    actionKey: NotificationActionKey;
    actor: AuthUserNormalized;
    refMongoId: unknown;
    module: string;
    params: Record<string, unknown>;
  } ): Promise<void> {
    const refId = MongoIdUtil.toIdString( options.refMongoId );

    try {
      await this.notificationHub.emit( {
        eventKey: options.eventKey,
        actor: options.actor,
        audiences: [
          { mode: "Role", roleKey: "admin" },
          { mode: "Role", roleKey: "cfo" },
          { mode: "Role", roleKey: "ceo" },
          { mode: "Role", roleKey: "cio" },
          { mode: "Role", roleKey: "coo" },
          { mode: "Role", roleKey: "cto" },
        ],
        target: {
          actionKey: options.actionKey,
          category: "Payment",
          params: { ...options.params, refId },
          refId,
          module: options.module,
        },
      } );
    } catch {
      console.error(
        "[Warning:] [BankAccountWriteService:] emitNotificationSafe: emit failed.\n"
      );
    }
  }

  // ===========================================================================
  // Actor helpers
  // ===========================================================================

  private toActorMini( actor: AuthUser ): ActorMini {
    const minActor: ActorMini = {
      userId: MongoIdUtil.toIdString( actor.userId ),
      username: actor.username,
      ...( this.hasText( actor.role ) ? { role: actor.role } : {} ),
    };
    return this.mustActor( minActor );
  }

  private toAuthUserNormalized( actor: AuthUser ): AuthUserNormalized {
    // IMPORTANT: Do not replace AuthUser in recyclebin flows.
    // Normalized actor is only for notification engine payload stability.
    const normalized: AuthUserNormalized = {
      ...actor,
      userId: MongoIdUtil.toIdString( actor.userId ),
    };
    return normalized;
  }

  // ===========================================================================
  // Normalization + validation helpers
  // ===========================================================================

  /**
   * Canonical status resolver.
   * - status wins over isActive.
   */
  private normalizeStatus( options: {
    status?: BankAccountStatus;
    isActive?: boolean;
    fallback?: BankAccountStatus;
  } ): BankAccountStatus | undefined {
    if (
      options.status === BankAccountStatus.Active ||
      options.status === BankAccountStatus.Inactive
    ) {
      return options.status;
    }

    if ( typeof options.isActive === "boolean" ) {
      return options.isActive
        ? BankAccountStatus.Active
        : BankAccountStatus.Inactive;
    }

    return options.fallback;
  }

  /**
   * Build safe masked fields from accountNumber.
   * - Output MUST satisfy model requirements.
   */
  private buildMaskedAccountFields( accountNumber: string ): {
    accountNumberMasked: string;
    accountNumberLast4: string;
  } {
    const raw = this.mustString( accountNumber, "accountNumber" );

    // Keep digits/letters; remove spaces only (do NOT log raw values)
    const clean = raw.replace( /\s+/g, "" );

    const last4 =
      clean.length >= 4 ? clean.slice( -4 ) : clean.padStart( 4, "0" );

    const maskedPrefixLen = Math.max( 0, clean.length - 4 );
    const masked = `${ "*".repeat( maskedPrefixLen ) }${ last4 }`;

    return { accountNumberMasked: masked, accountNumberLast4: last4 };
  }

  /**
   * Convert Mongo duplicate key errors into friendly messages.
   * - Uses keyPattern to determine which unique index triggered.
   */
  private wrapMongoDuplicateKey( err: unknown, op: "create" | "update" ): Error {
    const anyErr = err as { code?: number; keyPattern?: Record<string, unknown>; };

    if ( anyErr?.code !== 11000 ) {
      return err instanceof Error
        ? err
        : new Error( `[Error:] BankAccount ${ op } failed.\n` );
    }

    const kp = anyErr.keyPattern ?? {};
    const keys = Object.keys( kp );

    if ( keys.includes( "alias" ) ) {
      return new Error( "[Error:] Alias already exists in this company.\n" );
    }
    if ( keys.includes( "iban" ) ) {
      return new Error( "[Error:] IBAN already exists in this company.\n" );
    }
    if ( keys.includes( "accountNumber" ) ) {
      return new Error(
        "[Error:] This bank account number already exists for the selected bank.\n"
      );
    }
    if ( keys.includes( "accountId" ) ) {
      return new Error( "[Error:] Duplicate accountId conflict.\n" );
    }

    return new Error( "[Error:] Duplicate key conflict.\n" );
  }

  // ===========================================================================
  // Misc helpers (strict + exactOptionalPropertyTypes-safe)
  // ===========================================================================

  private newAccountId(): string {
    return randomUUID();
  }

  private hasText( input?: string ): boolean {
    return Boolean( this.optTrim( input ) );
  }

  private optTrim( input?: unknown ): string | null {
    const v = this.safeTrim( input );
    return v ? v : null;
  }

  private safeTrim( input?: unknown ): string {
    if ( input === null || input === undefined ) return "";
    return String( input ).trim();
  }

  private mustString( input: unknown, fieldName: string ): string {
    const v = this.safeTrim( input );
    if ( !v ) throw new Error( `[Error:] Missing required field: ${ fieldName }\n` );
    return v;
  }

  private mustActor( actor: ActorMini ): ActorMini {
    const userId = this.mustString( actor.userId, "actor.userId" );
    const username = this.mustString( actor.username, "actor.username" );
    const role = this.optTrim( actor.role );
    return role ? { userId, username, role } : { userId, username };
  }

  /**
   * Apply “set or unset” for optional string fields.
   * - If incoming is undefined => ignore (no changes)
   * - If incoming is "" / whitespace => unset
   * - Else => set trimmed value
   */
  private applyOptSetOrUnset(
    setDoc: Record<string, unknown>,
    unsetDoc: Record<string, 1>,
    field: string,
    incoming?: string
  ): void {
    if ( incoming === undefined ) return;

    const v = this.optTrim( incoming );
    if ( !v ) {
      unsetDoc[ field ] = 1;
      return;
    }

    setDoc[ field ] = v;
  }

  private toIso( value: Date | string ): ISODateString {
    if ( value instanceof Date ) return value.toISOString();

    const d = new Date( value );
    if ( Number.isNaN( d.getTime() ) ) return new Date().toISOString();

    return d.toISOString();
  }

  /**
   * Build normalizeStatus() argument object WITHOUT passing undefined keys.
   *
   * @param input.status
   * - Expected: BankAccountStatus OR undefined
   * - Usage: if undefined => omitted
   *
   * @param input.isActive
   * - Expected: boolean OR undefined
   * - Usage: if undefined => omitted
   *
   * @param input.fallback
   * - Expected: BankAccountStatus OR undefined
   * - Usage: if undefined => omitted
   */
  private buildStatusArgs( input: {
    status?: BankAccountStatus | undefined;
    isActive?: boolean | undefined;
    fallback?: BankAccountStatus | undefined;
  } ): { status?: BankAccountStatus; isActive?: boolean; fallback?: BankAccountStatus; } {
    const out: { status?: BankAccountStatus; isActive?: boolean; fallback?: BankAccountStatus; } = {};

    if ( input.status !== undefined ) out.status = input.status;
    if ( input.isActive !== undefined ) out.isActive = input.isActive;
    if ( input.fallback !== undefined ) out.fallback = input.fallback;

    return out;
  }
}