// Path: src/services/notifications/notification-recipient-resolver.rigistry.service.ts
import {
    RecipientResolveContext,
    RecipientResolution
}from './notification-hub-engine.service';
import {
    NotificationAudience
}
    from '../../types/notification/notification.types';

export class NotificationRecipientResolverRegistry {
    private static companyResolver: ( ( ctx: RecipientResolveContext ) => Promise<RecipientResolution> ) | null = null;
    private static roleResolver: ( ( roleKey: string, ctx: RecipientResolveContext ) => Promise<RecipientResolution> ) | null = null;
    private static teamResolver: ( ( teamCode: string, ctx: RecipientResolveContext ) => Promise<RecipientResolution> ) | null = null;
    private static userResolver: ( ( userId: string, ctx: RecipientResolveContext ) => Promise<RecipientResolution> ) | null = null;

    public static registerCompany( fn: ( ctx: RecipientResolveContext ) => Promise<RecipientResolution> ): void {
        this.companyResolver = fn;
    }

    public static registerRole( fn: ( roleKey: string, ctx: RecipientResolveContext ) => Promise<RecipientResolution> ): void {
        this.roleResolver = fn;
    }

    public static registerTeam( fn: ( teamCode: string, ctx: RecipientResolveContext ) => Promise<RecipientResolution> ): void {
        this.teamResolver = fn;
    }

    public static registerUser( fn: ( userId: string, ctx: RecipientResolveContext ) => Promise<RecipientResolution> ): void {
        this.userResolver = fn;
    }

    public static async resolve( audience: NotificationAudience, ctx: RecipientResolveContext ): Promise<RecipientResolution> {
        if ( audience.mode === "Company" ) {
            if ( !this.companyResolver ) return { usernames: [] };
            return this.companyResolver( ctx );
        }

        if ( audience.mode === "Role" ) {
            if ( !this.roleResolver ) return { usernames: [] };
            return this.roleResolver( audience.roleKey, ctx );
        }

        if ( audience.mode === "Team" ) {
            if ( !this.teamResolver ) return { usernames: [] };
            return this.teamResolver( audience.teamCode, ctx );
        }

        if ( audience.mode === "User" ) {
            if ( !this.userResolver ) return { usernames: [] };
            return this.userResolver( audience.userId, ctx );
        }

        return { usernames: [] };
    }
}