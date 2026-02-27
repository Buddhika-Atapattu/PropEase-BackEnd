// Path: src/bootstrap/notifications/notification-resolvers.bootstrap.ts
// =============================================================================
// Notification Resolvers Bootstrap
// =============================================================================
//
// 01) Purpose of this code
// -----------------------------------------------------------------------------
// - Register ("wire") recipient resolvers into NotificationRecipientResolverRegistry.
// - Each resolver converts a NotificationAudience into a concrete list of usernames.
// - This enables the Notification Hub Engine to:
//    a) resolve final recipients
//    b) create per-user inbox rows
//    c) allow Delivery Layer to deliver real-time WS / Email / SMS etc.
//
// 02) What this code is managing
// -----------------------------------------------------------------------------
// - Manages FOUR resolver registrations:
//    1) Company: everyone
//    2) Role: everyone in a role
//    3) Team: everyone in a team (captain + members)
//    4) User: one user by userId
//
// 03) Key things this code highlights
// -----------------------------------------------------------------------------
// - exactOptionalPropertyTypes-safe handling:
//    - NEVER pass { session: undefined }.
// - Mongoose session safety:
//    - NEVER call `.session(null)`.
//    - Apply `.session(session)` only when the session exists.
// - Defensive resolution:
//    - always sanitize input strings
//    - always return empty list for invalid inputs
//    - always dedupe usernames
//
// 04) Need to keep in mind
// -----------------------------------------------------------------------------
// - MUST be executed ONCE at app startup (after DB connect).
// - If not executed:
//    - registry will hold null resolvers
//    - resolve(...) will return empty recipients
//    - notifications appear "created" but never reach users
// =============================================================================

import { Types, type ClientSession } from "mongoose";

import { NotificationRecipientResolverRegistry } from "../../services/notifications/notification-recipient-resolver.registry.service";

import { UserModel } from "../../models/user.model";
import { TeamManagementModel } from "../../models/teamManagement/teamMain/teamManagement.model";

// ----------------------------------------------------------------------------
// Context passed from Hub Engine / caller
// ----------------------------------------------------------------------------
interface DbCtx {
  session?: ClientSession;
}

// ----------------------------------------------------------------------------
// Lean row shapes (avoid pulling full docs)
// ----------------------------------------------------------------------------
interface UsernameRow {
  username: string;
}

interface TeamLeanRow {
  captain?: { user?: Types.ObjectId; };
  members?: Array<{ user?: Types.ObjectId; }>;
}

/* =============================================================================
 * Helper Class: MongooseSessionApplier
 * =============================================================================
 *
 * 01) Why this helper exists
 * ---------------------------------------------------------------------------
 * - Mongoose Query supports `.session(session)` but does NOT accept null safely.
 * - Our code must remain exactOptionalPropertyTypes-safe:
 *    - we cannot do `.session(opts.session ?? null)`
 * - We also keep the bootstrap clean:
 *    - the resolver logic stays readable without repeated `if(session)` blocks.
 *
 * 02) How to use this helper
 * ---------------------------------------------------------------------------
 * - Create a query as normal:
 *      const q = UserModel.find(...).lean<...>();
 * - Then apply session if you have one:
 *      MongooseSessionApplier.applyQuerySession(q, session);
 *
 * 03) What parameters it needs and why
 * ---------------------------------------------------------------------------
 * - query  : a mongoose Query-like object (find/findOne/findById)
 * - session: optional ClientSession
 *
 * 04) How it links with other parts and returns
 * ---------------------------------------------------------------------------
 * - It mutates the query to attach a session (only when provided).
 * - Returns the SAME query object (for chain-friendly usage).
 * ============================================================================= */
class MongooseSessionApplier {
  private constructor () {}

  public static applyQuerySession<TQuery>( query: TQuery, session?: ClientSession ): TQuery {
    if ( !session ) return query;

    // We avoid function-based helpers and keep this inside a class method.
    ( query as unknown as { session: ( s: ClientSession ) => unknown; } ).session( session );
    return query;
  }
}

/* =============================================================================
 * Main Bootstrap Class: NotificationResolversBootstrap
 * =============================================================================
 *
 * 01) Why this class exists
 * ---------------------------------------------------------------------------
 * - To ensure recipient resolvers are registered at startup in one predictable place.
 *
 * 02) How to use this class
 * ---------------------------------------------------------------------------
 * - Call ONCE after DB connect:
 *      NotificationResolversBootstrap.init();
 *
 * 03) What parameters it needs and why
 * ---------------------------------------------------------------------------
 * - init() takes no params because it binds resolvers globally via registry.
 *
 * 04) How it links with other parts and returns
 * ---------------------------------------------------------------------------
 * - Links to NotificationRecipientResolverRegistry:
 *    - registers company/role/team/user resolvers
 * - Does not return values; it sets global resolver functions.
 * ============================================================================= */
export class NotificationResolversBootstrap {
  private constructor () {}

  /* ===========================================================================
   * Method: init()
   * ===========================================================================
   *
   * 01) Why this method
   * -------------------------------------------------------------------------
   * - It is the ONE entry point to register all resolvers.
   * - Prevents partial registrations (which cause silent empty recipients).
   *
   * 02) How to use this method
   * -------------------------------------------------------------------------
   * - Execute once on startup (after DB connect), example:
   *      Database.connect();
   *      NotificationResolversBootstrap.init();
   *
   * 03) Parameters to pass and why
   * -------------------------------------------------------------------------
   * - None.
   * - Resolvers will receive ctx from Hub Engine later.
   *
   * 04) Linkage and return behavior
   * -------------------------------------------------------------------------
   * - Registers resolver functions into registry (side-effect).
   * - Returns void.
   * ========================================================================= */
  public static init(): void {
    // -------------------------
    // Company resolver
    // -------------------------
    // Why:
    // - When audience.mode === "Company", we deliver to all users.
    // Company => ALL users
    NotificationRecipientResolverRegistry.registerCompany(async (ctx) => {
      const session = ctx.session;
      const q = UserModel.find( {}, { username: 1, _id: 0 } ).lean();
      if ( session ) q.session( session );

      const rows = await q.exec();
      const usernames = rows
        .map( ( r ) => ( typeof ( r as any )?.username === "string" ? ( r as any ).username.trim() : "" ) )
        .filter( ( x ) => !!x );

      return { usernames };
    });

    // -------------------------
    // Role resolver
    // -------------------------
    // Why:
    // - When audience.mode === "Role", we deliver to all users with that roleKey.
    NotificationRecipientResolverRegistry.registerRole(async (roleKey, ctx) => {
      const rk = typeof roleKey === "string" ? roleKey.trim() : "";
      if ( !rk ) return { usernames: [] };

      const session = ctx.session;

      const rx = new RegExp( `^${ rk.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" ) }$`, "i" );

      const q = UserModel.find(
        {
          $or: [
            { roleKey: rk },
            { roleKey: { $regex: rx } },

            // legacy support if your user schema uses "role"
            { role: rk },
            { role: { $regex: rx } },
          ],
        },
        { username: 1, _id: 0 }
      ).lean();

      if ( session ) q.session( session );

      const rows = await q.exec();
      const usernames = rows
        .map( ( r ) => ( typeof ( r as any )?.username === "string" ? ( r as any ).username.trim() : "" ) )
        .filter( ( x ) => !!x );

      return { usernames };
    });

    // -------------------------
    // Team resolver
    // -------------------------
    // Why:
    // - When audience.mode === "Team", deliver to captain + members of the team.
    NotificationRecipientResolverRegistry.registerTeam( async ( teamCode, ctx ) => {
      const code = this.safeStr( teamCode );
      if ( !code ) return { usernames: [] };

      const session = this.pickSession( ctx );

      // Step 1: load team user ObjectIds (captain + members)
      const teamQuery = TeamManagementModel.findOne(
        { teamCode: code },
        { captain: 1, members: 1 }
      ).lean<TeamLeanRow | null>();

      MongooseSessionApplier.applyQuerySession( teamQuery, session );

      const team = await teamQuery.exec();
      if ( !team ) return { usernames: [] };

      const userIds = this.collectTeamUserIds( team );
      if ( !userIds.length ) return { usernames: [] };

      // Step 2: map those ObjectIds -> usernames
      const userQuery = UserModel.find( { _id: { $in: userIds } }, { username: 1 } ).lean<
        UsernameRow[]
      >();

      MongooseSessionApplier.applyQuerySession( userQuery, session );

      const rows = await userQuery.exec();
      return { usernames: this.pickUsernames( rows ) };
    } );

    // -------------------------
    // User resolver
    // -------------------------
    // Why:
    // - When audience.mode === "User", deliver to exactly one user.
    NotificationRecipientResolverRegistry.registerUser( async ( username, ctx ) => {
      const u = this.safeStr( username );
      if ( !u ) return { usernames: [] };

      const session = this.pickSession( ctx );

      const q = UserModel.findOne( { username: u }, { username: 1 } ).lean<UsernameRow | null>();
      MongooseSessionApplier.applyQuerySession( q, session );

      const row = await q.exec();
      const resolved = row?.username ? row.username.trim() : "";

      return { usernames: resolved ? [ resolved ] : [] };
    } );

    // eslint-disable-next-line no-console
    console.log( "[Success:] NotificationResolversBootstrap initialized.\n" );
  }

  // ===========================================================================
  // Internal Helpers (pure, class-based)
  // ===========================================================================

  /* ===========================================================================
   * Method: pickSession()
   * ===========================================================================
   * 01) Why this method
   * - Centralizes session extraction.
   * - Keeps resolver blocks clean and avoids repetition.
   *
   * 02) How to use
   * - Called inside resolvers: const session = this.pickSession(ctx);
   *
   * 03) Parameters
   * - ctx: contains optional `session`
   *
   * 04) Linkage / return
   * - Returns ClientSession | undefined
   * ========================================================================= */
  private static pickSession( ctx: DbCtx ): ClientSession | undefined {
    return ctx.session;
  }

  /* ===========================================================================
   * Method: safeStr()
   * ===========================================================================
   * 01) Why this method
   * - Sanitizes unknown inputs safely (prevents runtime errors).
   *
   * 02) How to use
   * - safeStr(roleKey) / safeStr(teamCode) / safeStr(userId)
   *
   * 03) Parameters
   * - v: unknown
   *
   * 04) Return
   * - returns trimmed string or ""
   * ========================================================================= */
  private static safeStr( v: unknown ): string {
    return typeof v === "string" ? v.trim() : "";
  }

  /* ===========================================================================
   * Method: pickUsernames()
   * ===========================================================================
   * 01) Why this method
   * - Deduplication is critical because:
   *    - user might appear as captain and also in members
   *    - multiple DB matches could include duplicates
   * - Prevents redundant inbox row creation attempts.
   *
   * 02) How to use
   * - After querying { username: 1 } rows:
   *      const usernames = this.pickUsernames(rows)
   *
   * 03) Parameters
   * - rows: UsernameRow[]
   *
   * 04) Return
   * - returns unique, trimmed usernames[]
   * ========================================================================= */
  private static pickUsernames( rows: UsernameRow[] ): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    const list = Array.isArray( rows ) ? rows : [];
    for ( const r of list ) {
      const u = typeof r.username === "string" ? r.username.trim() : "";
      if ( !u ) continue;
      if ( seen.has( u ) ) continue;

      seen.add( u );
      out.push( u );
    }

    return out;
  }

  /* ===========================================================================
   * Method: collectTeamUserIds()
   * ===========================================================================
   * 01) Why this method
   * - Team resolver needs to include:
   *    - captain.user
   *    - members[].user
   * - We must dedupe ObjectIds before querying usernames.
   *
   * 02) How to use
   * - Call after loading lean team:
   *      const ids = this.collectTeamUserIds(team)
   *
   * 03) Parameters
   * - team: TeamLeanRow (lean team doc with captain + members)
   *
   * 04) Return
   * - Returns unique ObjectId[] for later UserModel query.
   * ========================================================================= */
  private static collectTeamUserIds( team: TeamLeanRow ): Types.ObjectId[] {
    const out: Types.ObjectId[] = [];
    const seen = new Set<string>();

    const cap = team.captain?.user;
    if ( cap ) {
      const key = String( cap );
      if ( !seen.has( key ) ) {
        seen.add( key );
        out.push( cap );
      }
    }

    const members = Array.isArray( team.members ) ? team.members : [];
    for ( const m of members ) {
      const id = m?.user;
      if ( !id ) continue;

      const key = String( id );
      if ( seen.has( key ) ) continue;

      seen.add( key );
      out.push( id );
    }

    return out;
  }
}
