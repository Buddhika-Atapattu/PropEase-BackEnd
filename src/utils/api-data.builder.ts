// Path: src/utils/api-data.builder.ts
// ============================================================================
// ApiDataBuilder
// ----------------------------------------------------------------------------
// Purpose:
//  - Build ApiData<TSystem, TOther> safely without `any`
//  - Allow "system partial" merge updates without forcing a full SystemData object
//  - Provide small domain builders only if they truly add value
//
// Notes:
//  - DO NOT import Mongoose Document types here.
//  - Only DTO / plain JSON types should appear in ApiData layer.
// ============================================================================

import type {
    ApiData,
    PaginationMeta,
    ValidationUnit,
    SystemData,
    LeaseSystemData,
    PropertySystemData,
    TenantSystemData,
    ComplaintSystemData,
    FileUploadSystemData,
    TeamManagementSystemData,
    FileMetaPacket,
    FileMetaSystemData,
    WorkSystemData,
} from '../types/api-message';

import type { LeasePayload, LeasePayloadWithProperty } from '../models/lease.model';
import type { IProperty } from '../models/property.model';
import type { ITenant } from '../models/tenant.model';
import type { IComplaint } from '../models/complaint.model';
import type { UserDocumentEntity } from '../models/file-upload.model';
import type { TeamManagementDto } from '../types/teamManagement/teamMain/teamManagement.types';
import type { WorkItemDto } from '../types/teamManagement/workItem/workItem.types';
import type { WorkEventDto } from '../models/teamManagement/workEvent.model';

// ----------------------------------------------------------------------------
// Generic ApiData builder
// ----------------------------------------------------------------------------

export class ApiDataBuilder<
    TSystem = SystemData,
    TOther extends Record<string, unknown> = Record<string, unknown>
> {
    private pagination?: PaginationMeta;
    private validation?: ValidationUnit;
    private system?: TSystem;
    private other?: TOther;

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

    /**
     * Safer than forcing callers to cast a Partial<> into a full SystemData.
     * This merges partial updates into an existing system object.
     */
    public withSystemPartial( partial: Partial<TSystem> ): this {
        const current: TSystem | undefined = this.system;
        const next: TSystem = { ...( current ?? {} ), ...( partial ?? {} ) } as TSystem;
        this.system = next;
        return this;
    }

    public build(): ApiData<TSystem, TOther> {
        const data: ApiData<TSystem, TOther> = {};

        if ( this.pagination ) data.pagination = this.pagination;
        if ( this.validation ) data.validation = this.validation;
        if ( this.system ) data.system = this.system;
        if ( this.other ) data.other = this.other;

        return data;
    }
}

// ----------------------------------------------------------------------------
// Optional sugar builders (still DTO-only)
// ----------------------------------------------------------------------------

export class LeaseDataBuilder extends ApiDataBuilder<LeaseSystemData> {
    public withLease( lease: LeasePayload ): this {
        return this.withSystemPartial( { lease } );
    }

    public withLeases( leases: LeasePayload[] ): this {
        return this.withSystemPartial( { leases } );
    }

    public withLeaseWithProperty( leaseWithProperty: LeasePayloadWithProperty ): this {
        return this.withSystemPartial( { leaseWithProperty } );
    }

    public withLeaseWithProperties( leaseWithProperties: LeasePayloadWithProperty[] ): this {
        return this.withSystemPartial( { leaseWithProperties } );
    }
}

export class PropertyDataBuilder extends ApiDataBuilder<PropertySystemData> {
    public withProperty( property: IProperty ): this {
        return this.withSystemPartial( { property } );
    }

    public withProperties( properties: IProperty[] ): this {
        return this.withSystemPartial( { properties } );
    }
}

export class TenantDataBuilder extends ApiDataBuilder<TenantSystemData> {
    public withTenant( tenant: ITenant ): this {
        return this.withSystemPartial( { tenant } );
    }

    public withTenants( tenants: ITenant[] ): this {
        return this.withSystemPartial( { tenants } );
    }
}

export class ComplaintDataBuilder extends ApiDataBuilder<ComplaintSystemData> {
    public withComplaint( complaint: IComplaint ): this {
        return this.withSystemPartial( { complaint } );
    }

    public withComplaints( complaints: IComplaint[] ): this {
        return this.withSystemPartial( { complaints } );
    }
}

export class FileUploadDataBuilder extends ApiDataBuilder<FileUploadSystemData> {
    public withFileUpload( fileUpload: UserDocumentEntity ): this {
        return this.withSystemPartial( { fileUpload } );
    }

    public withFileUploads( fileUploads: UserDocumentEntity[] ): this {
        return this.withSystemPartial( { fileUploads } );
    }
}

/**
 * Team Management API builder MUST use DTO only.
 */
export class TeamManagementDataBuilder extends ApiDataBuilder<TeamManagementSystemData> {
    public withTeam( team: TeamManagementDto ): this {
        return this.withSystemPartial( { team } );
    }

    public withTeams( teams: TeamManagementDto[] ): this {
        return this.withSystemPartial( { teams } );
    }
}


export class WorkSystemDataBuilder extends ApiDataBuilder<WorkSystemData> {
    public withWorkItem( workItem: WorkItemDto ): this {
        return this.withSystemPartial( { workItem } );
    }

    public withWorkItems( workItems: WorkItemDto[] ): this {
        return this.withSystemPartial( { workItems } );
    }

    public withEvent( event: WorkEventDto ): this {
        return this.withSystemPartial( { event } );
    }

    public withEvents( events: WorkEventDto[] ): this {
        return this.withSystemPartial( { events } );
    }
}



export class FileMetaDataBuilder extends ApiDataBuilder<FileMetaSystemData> {
    public withFile( file: FileMetaPacket ): this {
        return this.withSystemPartial( { file } );
    }

    public withFiles( files: FileMetaPacket[] ): this {
        return this.withSystemPartial( { files } );
    }
}
