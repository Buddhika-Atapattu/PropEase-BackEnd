// Path: src/services/payments/bank-registry/bank-registry.service.ts
// =============================================================================
// BankRegistryService — Bank Master Operations (REST-secure, company-scoped)
// =============================================================================

import { randomUUID } from "crypto";
import type { ClientSession, FilterQuery } from "mongoose";
import { Request } from "express";

import { BankModel, type IBank } from "../../../../models/payments/bank-registry/bank.model";

import {
  BankStatus,
  type BankCoreDto,
  type BankCreateInput,
  type BankUpdateInput,
} from "../../../../types/payments/bank-registry/banks/bank.types";

import type {
  ActorMini,
  AuthUser,
  AuthUserNormalized,
  ISODateString,
  PhoneNumber,
} from "../../../../types/common";

import {
  RecycleBinDomainDeleteService,
  type DomainDeletePlan,
} from "../../../recyclebin/recyclebin-domain-delete.service";

import { NotificationHubEngineService } from "../../../notifications/notification-hub-engine.service";
import { MongoIdUtil } from "../../../../utils/mongo-id.util";
import type { RecycleRecordResult } from "../../../recyclebin/recyclebin-engine.service";
import type { NotificationActionKey } from "../../../../types/notification/notification-action-keys.catalog";

// =============================================================================
// Lean Shapes (DB reads) — keep aligned with model
// =============================================================================

interface BankLean {
  _id: unknown;

  bankId: string;
  companyId: string;

  name: string;
  countryCca2: string;

  bankCode?: string;
  swiftBic?: string;

  supportedCurrencyCodes: string[];

  addressLine1: string;
  addressLine2?: string;
  city: string;
  district: string;
  province: string;
  postalCode: string;
  phone: PhoneNumber;

  notes?: string;

  status: BankStatus;

  createdAt: Date | string;
  updatedAt: Date | string;

  createdBy: ActorMini;
  updatedBy?: ActorMini;
}

export class BankRegistryService {
  private readonly notificationHub: NotificationHubEngineService =
    new NotificationHubEngineService();

  private readonly deleteSvc: RecycleBinDomainDeleteService =
    new RecycleBinDomainDeleteService();

  public constructor () {}

  // ===========================================================================
  // CREATE
  // ===========================================================================

  /**
   * Create a Bank record under a company scope.
   *
   * @param options.companyId
   * - Expected: authenticated tenant boundary (e.g., "COMPANY-001")
   *
   * @param options.actor
   * - Expected: AuthUser from ApiGuardExport.GetAuthUser(req)
   *
   * @param options.input
   * - Expected: BankCreateInput (validated at controller boundary)
   */
  public async create( options: {
    companyId: string;
    actor: AuthUser;
    input: BankCreateInput;
  } ): Promise<BankCoreDto> {
    const minActor = this.toActorMini( options.actor );
    const normalisedActor = this.toAuthUserNormalized( options.actor );

    const companyId = this.mustString(
      options.actor.companyId ?? options.companyId,
      "companyId"
    );

    const name = this.mustString( options.input.name, "name" );
    const countryCca2 = this.mustString( options.input.countryCca2, "countryCca2" ).toUpperCase();

    const bankCode = this.optTrim( options.input.bankCode );
    const swiftBic = this.optTrim( options.input.swiftBic );

    const addressLine1 = this.mustString( options.input.addressLine1, "addressLine1" );
    const addressLine2 = this.optTrim( options.input.addressLine2 ); // optional
    const city = this.mustString( options.input.city, "city" );
    const district = this.mustString( options.input.district, "district" );
    const province = this.mustString( options.input.province, "province" );
    const postalCode = this.mustString( options.input.postalCode, "postalCode" );

    const notes: string | null = this.optTrim( this.mustString( options.input.notes, 'notes' ) );

    const phone: PhoneNumber = options.input.phone;

    // Currency codes sanitation (strict)
    const supportedCurrencyCodes = this.optCurrencyCodes( options.input.supportedCurrencyCodes );
    if ( supportedCurrencyCodes.length === 0 ) {
      throw new Error(
        "[Error:] supportedCurrencyCodes must contain at least 1 valid currency code.\n"
      );
    }

    const status = options.input.status ?? BankStatus.Active;

    const now = new Date();

    // exactOptionalPropertyTypes-safe: omit optional props unless they exist
    const doc: Omit<IBank, "_id"> = {
      bankId: this.newBankId(),
      companyId,

      name,
      countryCca2,

      ...( bankCode ? { bankCode } : {} ),
      ...( swiftBic ? { swiftBic } : {} ),

      supportedCurrencyCodes,

      addressLine1,
      ...( addressLine2 ? { addressLine2 } : {} ),
      city,
      district,
      province,
      postalCode,
      phone,

      status,

      ...( notes ? { notes } : {} ),
      createdBy: minActor,

      // timestamps are enabled in schema, but your IBank includes these fields,
      // so we set them explicitly for predictable DTO timestamps
      createdAt: now,
      updatedAt: now,
    };

    const created = await BankModel.create( doc );

    const lean = await BankModel.findById( created._id ).lean<BankLean | null>();
    if ( !lean ) throw new Error( "[Error:] Bank created but failed to re-load.\n" );

    await this.emitNotificationSafe( {
      eventKey: "payment:bank.created",
      actionKey: "payment:bank.created",
      actor: normalisedActor,
      refMongoId: lean._id,
      module: "Bank Registry",
    } );

    return this.toDto( lean );
  }

  // ===========================================================================
  // UPDATE (PATCH)
  // ===========================================================================

  public async update( options: {
    companyId: string;
    actor: AuthUser;
    bankId: string;
    patch: BankUpdateInput;
  } ): Promise<BankCoreDto> {
    const minActor = this.toActorMini( options.actor );
    const normalisedActor = this.toAuthUserNormalized( options.actor );

    const companyId = this.mustString(
      options.actor.companyId ?? options.companyId,
      "companyId"
    );
    const bankId = this.mustString( options.bankId, "bankId" );

    const updateSet: Record<string, unknown> = {};
    const updateUnset: Record<string, 1> = {};

    if ( this.hasText( options.patch.name ) ) {
      updateSet.name = this.mustString( options.patch.name, "name" );
    }

    if ( this.hasText( options.patch.countryCca2 ) ) {
      updateSet.countryCca2 = this.mustString( options.patch.countryCca2, "countryCca2" ).toUpperCase();
    }

    // Address fields (patch-like)
    this.applyOptSetOrUnset( updateSet, updateUnset, "addressLine2", options.patch.addressLine2 );

    if ( this.hasText( options.patch.addressLine1 ) ) {
      updateSet.addressLine1 = this.mustString( options.patch.addressLine1, "addressLine1" );
    }
    if ( this.hasText( options.patch.city ) ) {
      updateSet.city = this.mustString( options.patch.city, "city" );
    }
    if ( this.hasText( options.patch.district ) ) {
      updateSet.district = this.mustString( options.patch.district, "district" );
    }
    if ( this.hasText( options.patch.province ) ) {
      updateSet.province = this.mustString( options.patch.province, "province" );
    }
    if ( this.hasText( options.patch.postalCode ) ) {
      updateSet.postalCode = this.mustString( options.patch.postalCode, "postalCode" );
    }
    if ( options.patch.phone !== undefined ) {
      updateSet.phone = options.patch.phone;
    }

    // Currency codes patch semantics
    if ( Array.isArray( options.patch.supportedCurrencyCodes ) ) {
      const cleaned = this.optCurrencyCodes( options.patch.supportedCurrencyCodes );
      if ( cleaned.length === 0 ) {
        throw new Error( "[Error:] supportedCurrencyCodes cannot be empty after sanitation.\n" );
      }
      updateSet.supportedCurrencyCodes = cleaned;
    }

    // Optional fields: set/unset rules
    if ( this.optTrim( options.patch.notes ) ) {
      updateSet.notes = this.mustString( options.patch.notes, "notes" );
    }

    this.applyOptSetOrUnset( updateSet, updateUnset, "bankCode", options.patch.bankCode );
    this.applyOptSetOrUnset( updateSet, updateUnset, "swiftBic", options.patch.swiftBic );

    // Enum patch
    if ( options.patch.status !== undefined ) {
      updateSet.status = options.patch.status;
    }

    // Audit
    updateSet.updatedBy = minActor;
    updateSet.updatedAt = new Date();

    const op: Record<string, unknown> = {};
    if ( Object.keys( updateSet ).length > 0 ) op.$set = updateSet;
    if ( Object.keys( updateUnset ).length > 0 ) op.$unset = updateUnset;

    if ( Object.keys( op ).length === 0 ) {
      const cur = await BankModel.findOne( { companyId, bankId } ).lean<BankLean | null>();
      if ( !cur ) throw new Error( "[Error:] Bank not found.\n" );
      return this.toDto( cur );
    }

    const updated = await BankModel.findOneAndUpdate( { companyId, bankId }, op, { new: true } )
      .lean<BankLean | null>();

    if ( !updated ) throw new Error( "[Error:] Bank not found.\n" );

    await this.emitNotificationSafe( {
      eventKey: "payment:bank.updated",
      actionKey: "payment:bank.updated",
      actor: normalisedActor,
      refMongoId: updated._id,
      module: "Bank Registry",
    } );

    return this.toDto( updated );
  }

  // ===========================================================================
  // STATUS (helper)
  // ===========================================================================

  public async setStatus( options: {
    companyId: string;
    actor: AuthUser;
    bankId: string;
    status: BankStatus;
  } ): Promise<BankCoreDto> {
    return this.update( {
      companyId: options.companyId,
      actor: options.actor,
      bankId: options.bankId,
      patch: { status: options.status },
    } );
  }

  // ===========================================================================
  // LIST
  // ===========================================================================

  public async list( options: {
    companyId: string;
    onlyActive?: boolean;
    countryCca2?: string;
    search?: string;
    limit?: number;
    page?: number;
  } ): Promise<{ items: BankCoreDto[]; other: { total: number; }; }> {
    const q = this.buildListQuery( options );

    const safeLimit = this.clampNumber( options.limit, 200, 1, 500 );
    const safePage = this.clampNumber( options.page, 1, 1, 1_000_000 );
    const skip = ( safePage - 1 ) * safeLimit;

    const [ items, total ] = await Promise.all( [
      BankModel.find( q )
        .sort( { name: 1, createdAt: -1 } )
        .skip( skip )
        .limit( safeLimit )
        .lean<BankLean[]>(),
      BankModel.countDocuments( q ),
    ] );

    return { items: items.map( ( x ) => this.toDto( x ) ), other: { total } };
  }

  // ===========================================================================
  // READ ONE
  // ===========================================================================

  public async getByBankId( options: {
    companyId: string;
    bankId: string;
  } ): Promise<BankCoreDto | null> {
    const companyId = this.mustString( options.companyId, "companyId" );
    const bankId = this.mustString( options.bankId, "bankId" );

    const found = await BankModel.findOne( { companyId, bankId } ).lean<BankLean | null>();
    if ( !found ) return null;

    return this.toDto( found );
  }

  public async getByBankCode( options: {
    companyId: string;
    bankCode: string;
  } ): Promise<BankCoreDto | null> {
    const companyId = this.mustString( options.companyId, "companyId" );
    const bankCode = this.mustString( options.bankCode, "bankCode" );

    const found = await BankModel.findOne( { companyId, bankCode } ).lean<BankLean | null>();

    if ( !found ) return null;

    return this.toDto( found );
  }

  // ===========================================================================
  // DELETE (RecycleBin + Notification)
  // ===========================================================================

  public async delete( options: {
    companyId: string;
    actor: AuthUser;
    bankId: string;
    req: Request;
  } ): Promise<{ deleted: boolean; entry: RecycleRecordResult | null; }> {
    const normalisedActor = this.toAuthUserNormalized( options.actor );

    const companyId = this.mustString( options.companyId, "companyId" );
    const bankId = this.mustString( options.bankId, "bankId" );

    const exist = await BankModel.findOne( { companyId, bankId } ).lean<BankLean | null>().exec();
    if ( !exist ) {
      console.error( "[Error:] [BankRegistryService:] delete: Bank does not exist!\n" );
      return { deleted: false, entry: null };
    }

    const refMongoIdStr = MongoIdUtil.toIdString( exist._id );

    const plan: DomainDeletePlan<BankLean> = {
      collectionName: BankModel.collection.name,
      files: [],
      label: `Bank: ${ exist.name }`,
      refId: refMongoIdStr,
      snapshotData: exist as unknown as Record<string, unknown>,
      sourceKey: "bank",
      module: "Bank Registry",
      tags: [ "bank", "registry" ],

      deleteDbRecord: async ( session?: ClientSession ): Promise<void> => {
        if ( session ) {
          await BankModel.deleteOne( { companyId, bankId }, { session } );
          return;
        }
        await BankModel.deleteOne( { companyId, bankId } );
        return;
      },
    };

    const result = await this.deleteSvc.deleteWithRecycleBin( options.actor, plan, options.req );

    await this.emitNotificationSafe( {
      eventKey: "payment:bank.deleted",
      actionKey: "payment:bank.deleted",
      actor: normalisedActor,
      refMongoId: exist._id,
      module: "Bank Registry",
    } );

    return {
      deleted: Boolean( result.entry ),
      entry: result.entry,
    };
  }

  // ===========================================================================
  // Query builder
  // ===========================================================================

  private buildListQuery( options: {
    companyId: string;
    onlyActive?: boolean;
    countryCca2?: string;
    search?: string;
  } ): FilterQuery<unknown> {
    const q: Record<string, unknown> = {};
    q.companyId = this.mustString( options.companyId, "companyId" );

    const onlyActive = options.onlyActive !== false;
    if ( onlyActive ) q.status = BankStatus.Active;

    const cca2 = this.optTrim( options.countryCca2 );
    if ( cca2 ) q.countryCca2 = cca2.toUpperCase();

    const search = this.optTrim( options.search );
    if ( search ) {
      const safe = this.escapeRegex( search );
      q.$or = [
        { name: { $regex: safe, $options: "i" } },
        { bankCode: { $regex: safe, $options: "i" } },
        { swiftBic: { $regex: safe, $options: "i" } },
      ];
    }

    return q;
  }

  // ===========================================================================
  // DTO mapping
  // ===========================================================================

  private toDto( doc: BankLean ): BankCoreDto {
    const createdAt = this.toIso( doc.createdAt );
    const updatedAt = this.toIso( doc.updatedAt );

    const base: BankCoreDto = {
      bankId: this.mustString( doc.bankId, "bankId" ),
      companyId: this.mustString( doc.companyId, "companyId" ),

      name: this.mustString( doc.name, "name" ),
      countryCca2: this.mustString( doc.countryCca2, "countryCca2" ).toUpperCase(),

      supportedCurrencyCodes: this.optCurrencyCodes( doc.supportedCurrencyCodes ),

      status: doc.status,

      addressLine1: doc.addressLine1,
      ...( this.hasText( doc.addressLine2 ) ? { addressLine2: this.mustString( doc.addressLine2, "addressLine2" ) } : {} ),
      city: doc.city,
      district: doc.district,
      province: doc.province,
      postalCode: doc.postalCode,
      phone: doc.phone,
      ...( doc.notes ? { notes: doc.notes } : {} ),

      createdAt,
      updatedAt,

      createdBy: this.mustActor( doc.createdBy ),
    };

    const withUpdatedBy = doc.updatedBy
      ? { ...base, updatedBy: this.mustActor( doc.updatedBy ) }
      : base;

    const withBankCode = this.hasText( doc.bankCode )
      ? { ...withUpdatedBy, bankCode: this.mustString( doc.bankCode, "bankCode" ) }
      : withUpdatedBy;

    const withSwift = this.hasText( doc.swiftBic )
      ? { ...withBankCode, swiftBic: this.mustString( doc.swiftBic, "swiftBic" ) }
      : withBankCode;

    return withSwift;
  }

  // ===========================================================================
  // Notifications (safe)
  // ===========================================================================

  private async emitNotificationSafe( options: {
    eventKey: NotificationActionKey;
    actionKey: NotificationActionKey;
    actor: AuthUserNormalized;
    refMongoId: unknown;
    module: string;
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
          params: { bankId: refId },
          refId,
          module: options.module,
        },
      } );
    } catch {
      console.error( "[Warning:] [BankRegistryService:] emitNotificationSafe: emit failed.\n" );
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
    const normalized: AuthUserNormalized = {
      ...actor,
      userId: MongoIdUtil.toIdString( actor.userId ),
    };
    return normalized;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private newBankId(): string {
    return randomUUID();
  }

  private hasText( input?: string ): boolean {
    return Boolean( this.optTrim( input ) );
  }

  private optTrim( input?: string ): string | null {
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

  private escapeRegex( input: string ): string {
    return input.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
  }

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

  private clampNumber( value: number | undefined, fallback: number, min: number, max: number ): number {
    const n = typeof value === "number" ? value : Number.NaN;
    if ( !Number.isFinite( n ) ) return fallback;

    const x = Math.floor( n );
    if ( x < min ) return min;
    if ( x > max ) return max;
    return x;
  }

  // ===========================================================================
  // Currency-code sanitation (STRICT)
  // ===========================================================================

  private optCurrencyCodes( arg: unknown ): string[] {
    if ( !Array.isArray( arg ) || arg.length === 0 ) return [];

    const out: string[] = [];
    const seen = new Set<string>();

    for ( const raw of arg ) {
      if ( typeof raw !== "string" ) continue;

      const code = this.cleanCurrencyCode( raw );
      if ( !code ) continue;

      if ( seen.has( code ) ) continue;
      seen.add( code );

      out.push( code );
      if ( out.length >= 50 ) break;
    }

    return out;
  }

  private cleanCurrencyCode( input: string ): string {
    const raw = this.safeTrim( input ).toUpperCase();
    const code = raw.replace( /[^A-Z0-9]/g, "" );
    if ( code.length < 2 || code.length > 10 ) return "";
    return code;
  }
}