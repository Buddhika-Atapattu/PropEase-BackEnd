// Path: src/utils/api-data.builder.ts
import {
    ApiData,
    PaginationMeta,
    ValidationUnit,
    SystemData,
    LeaseSystemData,
    PropertySystemData,
    TenantSystemData,
    ComplaintSystemData,
    FileUploadSystemData,
    type TeamManagementApiData,
    type FileMetaBase,
    type TeamManagementSystemData,
    type FileMetaSystemData,
} from '../types/api-message';
import { LeasePayload, LeasePayloadWithProperty } from '../models/lease.model';
import { IProperty } from '../models/property.model';
import { ITenant } from '../models/tenant.model';
import { IComplaint } from '../models/complaint.model';
import { UserDocumentEntity } from '../models/file-upload.model';
import type { ITeamManagement } from '../models/teamManagement/teamManagement.model';

/**
 * Generic ApiData builder.
 * TSystem decides which slice of SystemData we are building.
 */
export class ApiDataBuilder<TSystem = SystemData, TOther extends Record<string, unknown> = Record<string, unknown>> {
    private pagination?: PaginationMeta;
    private validation?: ValidationUnit;
    private system?: TSystem;
    private other?: TOther;

    /* Basic builders */
    public withPagination( meta: PaginationMeta ): this {
        this.pagination = meta;
        return this;
    }

    public withValidation( validation: ValidationUnit ): this {
        this.validation = validation;
        return this;
    }

    public withOther( other: TOther ): this {
        this.other = other;
        return this;
    }

    public withSystem( system: TSystem ): this {
        this.system = system;
        return this;
    }

    public build(): ApiData<TSystem, TOther> {
        const data: ApiData<TSystem, TOther> = {};

        if ( this.pagination ) {
            data.pagination = this.pagination;
        }

        if ( this.validation ) {
            data.validation = this.validation;
        }

        if ( this.system ) {
            data.system = this.system;
        }

        if ( this.other ) {
            data.other = this.other;
        }

        return data;
    }
}

/* ──────────────────────────────────────────────────────────────
   Specialised builders for each domain slice
   (Nice sugar so you don't manually build system object)
   ────────────────────────────────────────────────────────────── */

export class LeaseDataBuilder extends ApiDataBuilder<LeaseSystemData> {
    public withLease( lease: LeasePayload ): this {
        const current = ( this as any ).system as LeaseSystemData | undefined;
        const next: LeaseSystemData = { ...( current ?? {} ), lease };
        this.withSystem( next );
        return this;
    }

    public withLeases( leases: LeasePayload[] ): this {
        const current = ( this as any ).system as LeaseSystemData | undefined;
        const next: LeaseSystemData = { ...( current ?? {} ), leases };
        this.withSystem( next );
        return this;
    }

    public withLeaseWithProperty( lease: LeasePayloadWithProperty ): this {
        const current = ( this as any ).system as LeaseSystemData | undefined;
        const next: LeaseSystemData = { ...( current ?? {} ), leaseWithProperty: lease };
        this.withSystem( next );
        return this;
    }

    public withLeaseWithProperties( leases: LeasePayloadWithProperty[] ): this {
        const current = ( this as any ).system as LeaseSystemData | undefined;
        const next: LeaseSystemData = { ...( current ?? {} ), leaseWithProperties: leases };
        this.withSystem( next );
        return this;
    }
}

export class PropertyDataBuilder extends ApiDataBuilder<PropertySystemData> {
    public withProperty( property: IProperty ): this {
        const current = ( this as any ).system as PropertySystemData | undefined;
        const next: PropertySystemData = { ...( current ?? {} ), property };
        this.withSystem( next );
        return this;
    }

    public withProperties( properties: IProperty[] ): this {
        const current = ( this as any ).system as PropertySystemData | undefined;
        const next: PropertySystemData = { ...( current ?? {} ), properties };
        this.withSystem( next );
        return this;
    }
}

export class TenantDataBuilder extends ApiDataBuilder<TenantSystemData> {
    public withTenant( tenant: ITenant ): this {
        const current = ( this as any ).system as TenantSystemData | undefined;
        const next: TenantSystemData = { ...( current ?? {} ), tenant };
        this.withSystem( next );
        return this;
    }

    public withTenants( tenants: ITenant[] ): this {
        const current = ( this as any ).system as TenantSystemData | undefined;
        const next: TenantSystemData = { ...( current ?? {} ), tenants };
        this.withSystem( next );
        return this;
    }
}

export class ComplaintDataBuilder extends ApiDataBuilder<ComplaintSystemData> {
    public withComplaint( complaint: IComplaint ): this {
        const current = ( this as any ).system as ComplaintSystemData | undefined;
        const next: ComplaintSystemData = { ...( current ?? {} ), complaint };
        this.withSystem( next );
        return this;
    }

    public withComplaints( complaints: IComplaint[] ): this {
        const current = ( this as any ).system as ComplaintSystemData | undefined;
        const next: ComplaintSystemData = { ...( current ?? {} ), complaints };
        this.withSystem( next );
        return this;
    }
}

export class FileUploadDataBuilder extends ApiDataBuilder<FileUploadSystemData> {
    public withFileUpload( file: UserDocumentEntity ): this {
        const current = ( this as any ).system as FileUploadSystemData | undefined;
        const next: FileUploadSystemData = { ...( current ?? {} ), fileUpload: file };
        this.withSystem( next );
        return this;
    }

    public withFileUploads( files: UserDocumentEntity[] ): this {
        const current = ( this as any ).system as FileUploadSystemData | undefined;
        const next: FileUploadSystemData = { ...( current ?? {} ), fileUploads: files };
        this.withSystem( next );
        return this;
    }
}

export class TeamManagementBuilder extends ApiDataBuilder<TeamManagementSystemData> {
    public withTeam( team: ITeamManagement ): this {
        const current = ( this as any ).system as TeamManagementSystemData | undefined;
        const next: TeamManagementSystemData = { ...( current ?? {} ), team };
        this.withSystem( next );
        return this;
    }

    public withTeams( teams: ITeamManagement[] ): this {
        const current = ( this as any ).system as TeamManagementSystemData | undefined;
        const next: TeamManagementSystemData = { ...( current ?? {} ), teams };
        this.withSystem( next );
        return this;
    }
}

export class FileMetaBaseBuilder extends ApiDataBuilder<FileMetaSystemData> {
    public withTeam( file: FileMetaBase ): this {
        const current = ( this as any ).system as FileMetaSystemData | undefined;
        const next: FileMetaSystemData = { ...( current ?? {} ), file };
        this.withSystem( next );
        return this;
    }

    public withTeams( files: FileMetaBase[] ): this {
        const current = ( this as any ).system as FileMetaSystemData | undefined;
        const next: FileMetaSystemData = { ...( current ?? {} ), files };
        this.withSystem( next );
        return this;
    }
}
