// Path: src/models/complaint.model.ts
// =============================================================================
// Complaint Model (Mongoose) — Updated to use Universal Comments Contract
// =============================================================================

import mongoose, { Schema, Document, Model } from 'mongoose';



// ─────────────────────────────────────────────────────────────────────────────
// Shared literals & client contracts (kept for BE/FE parity)
// ─────────────────────────────────────────────────────────────────────────────

export type ComplaintStatus =
  | 'new'
  | 'triaged'
  | 'in_progress'
  | 'awaiting_tenant'
  | 'resolved'
  | 'closed'
  | 'reopened'
  | 'cancelled';

export type ComplaintPriority = 'low' | 'medium' | 'high' | 'urgent';

export type ComplaintsCategory =
  | 'Plumbing'
  | 'Electrical'
  | 'Hvac'
  | 'Appliances'
  | 'Structural'
  | 'Doors Windows'
  | 'Security Safety'
  | 'Water Leak Damp'
  | 'Sanitation'
  | 'Internet Telecom'
  | 'Elevator Lift'
  | 'Pests Vermin'
  | 'Landscaping Garden'
  | 'Parking Garage'
  | 'Common Areas'
  | 'Access Keys Locks'
  | 'Cleaning Housekeeping'
  | 'Waste Management'
  | 'Painting Decor'
  | 'Gas Supply'
  | 'Noise Nuisance'
  | 'Renovation Work'
  | 'Other';

export const COMPLAINT_CATEGORIES: readonly ComplaintsCategory[] = [
  'Plumbing',
  'Electrical',
  'Hvac',
  'Appliances',
  'Structural',
  'Doors Windows',
  'Security Safety',
  'Water Leak Damp',
  'Sanitation',
  'Internet Telecom',
  'Elevator Lift',
  'Pests Vermin',
  'Landscaping Garden',
  'Parking Garage',
  'Common Areas',
  'Access Keys Locks',
  'Cleaning Housekeeping',
  'Waste Management',
  'Painting Decor',
  'Gas Supply',
  'Noise Nuisance',
  'Renovation Work',
  'Other',
] as const;



// ─────────────────────────────────────────────────────────────────────────────
// Client-facing attachment type (complaint attachments are separate from comment attachments)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplaintAttachmentClient {
  _id?: string;

  name: string;
  mimetype: string;
  size: number;      // bytes

  url: string;       // public/secured URL

  width?: number;
  height?: number;
}



// ─────────────────────────────────────────────────────────────────────────────
// Timeline types (client view)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplaintTimelineEventClient {
  _id?: string;

  at: string;                    // ISO string

  fromStatus?: ComplaintStatus;
  toStatus: ComplaintStatus;

  byUserId: string;

  note?: string;
}



// ─────────────────────────────────────────────────────────────────────────────
// ComplaintClient — IMPORTANT CHANGE
// -----------------------------------------------------------------------------
// ✅ comments is now CommentDto[] from your universal comment contract
// -----------------------------------------------------------------------------
// This prevents repeated rework and keeps FE consistent across modules.
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplaintClient {
  _id?: string;

  code: string;

  tenantId: string;
  tenantName?: string;

  propertyId?: string;
  propertyName?: string;

  leaseId?: string;

  title: string;
  description: string;

  category: ComplaintsCategory;
  priority: ComplaintPriority;
  status: ComplaintStatus;

  assigneeId?: string;
  assigneeName?: string;

  createdAt: string;             // ISO
  updatedAt: string;             // ISO
  dueAt?: string;                // ISO

  attachments?: ComplaintAttachmentClient[];

  timeline?: ComplaintTimelineEventClient[];
}



// ─────────────────────────────────────────────────────────────────────────────
// Mongoose Subdocuments
// ─────────────────────────────────────────────────────────────────────────────

/** Subdocument: Complaint Attachment */
export interface IComplaintAttachment extends Document {
  name: string;
  mimetype: string;
  size: number;
  url: string;

  width?: number | null;
  height?: number | null;

  source?: string | null;
}

class AttachmentSchemaBuilder {
  public static build(): Schema<IComplaintAttachment> {
    return new Schema<IComplaintAttachment>(
      {
        name: { type: String, required: true, trim: true },
        mimetype: { type: String, required: true, trim: true },
        size: { type: Number, required: true },
        url: { type: String, required: true, trim: true },

        width: { type: Number, default: null },
        height: { type: Number, default: null },

        source: { type: String, default: null, trim: true },
      },
      { _id: true, timestamps: false },
    );
  }
}



/** Subdocument: Timeline event */
export interface IComplaintTimelineEvent extends Document {
  at: Date;

  fromStatus?: ComplaintStatus | null;
  toStatus: ComplaintStatus;

  byUserId: string;

  note?: string | null;
}

class TimelineSchemaBuilder {
  public static build(): Schema<IComplaintTimelineEvent> {
    return new Schema<IComplaintTimelineEvent>(
      {
        at: { type: Date, required: true },

        fromStatus: {
          type: String,
          enum: [
            'new',
            'triaged',
            'in_progress',
            'awaiting_tenant',
            'resolved',
            'closed',
            'reopened',
            'cancelled',
          ],
          default: null,
        },

        toStatus: {
          type: String,
          enum: [
            'new',
            'triaged',
            'in_progress',
            'awaiting_tenant',
            'resolved',
            'closed',
            'reopened',
            'cancelled',
          ],
          required: true,
        },

        byUserId: { type: String, required: true, trim: true },

        note: { type: String, default: null, trim: true },
      },
      { _id: true, timestamps: false },
    );
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// Main document: Complaint
// ─────────────────────────────────────────────────────────────────────────────

export interface IComplaint extends Document {
  code: string;

  tenantId: string;

  propertyId?: string | null;
  leaseId?: string | null;

  title: string;
  description: string;

  category: ComplaintsCategory;
  priority: ComplaintPriority;
  status: ComplaintStatus;

  assigneeId?: string | null;

  dueAt?: Date | null;

  attachments: IComplaintAttachment[];

  timeline: IComplaintTimelineEvent[];

  createdAt: Date;
  updatedAt: Date;

  toClient( partial?: {
    tenantName?: string | null;
    propertyName?: string | null;
    assigneeName?: string | null;
  } ): ComplaintClient;
}



class ComplaintSchemaBuilder {
  public static build(): Schema<IComplaint> {

    const attachmentSchema = AttachmentSchemaBuilder.build();


    const timelineSchema = TimelineSchemaBuilder.build();



    const s = new Schema<IComplaint>(
      {
        code: { type: String, required: true, unique: true, index: true, trim: true },

        tenantId: { type: String, required: true, trim: true },

        propertyId: { type: String, default: null, trim: true },
        leaseId: { type: String, default: null, trim: true },

        title: { type: String, required: true, trim: true },
        description: { type: String, required: true, trim: true },

        category: { type: String, enum: [ ...COMPLAINT_CATEGORIES ], required: true },

        priority: {
          type: String,
          enum: [ 'low', 'medium', 'high', 'urgent' ],
          required: true,
        },

        status: {
          type: String,
          enum: [
            'new',
            'triaged',
            'in_progress',
            'awaiting_tenant',
            'resolved',
            'closed',
            'reopened',
            'cancelled',
          ],
          required: true,
        },

        assigneeId: { type: String, default: null, trim: true },

        dueAt: { type: Date, default: null },

        attachments: { type: [ attachmentSchema ], default: [] },

        timeline: { type: [ timelineSchema ], default: [] },
      },
      {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
      },
    );



    // Helpful indexes
    s.index( { tenantId: 1, createdAt: -1 } );
    s.index( { propertyId: 1, createdAt: -1 } );
    s.index( { status: 1, priority: 1 } );
    s.index( { category: 1 } );



    // -------------------------------------------------------------------------
    // Instance: toClient()
    // -------------------------------------------------------------------------
    s.methods.toClient = function toClient(
      this: IComplaint,
      partial?: {
        tenantName?: string | null;
        propertyName?: string | null;
        assigneeName?: string | null;
      },
    ): ComplaintClient {

      // Base output (required fields)
      const out: ComplaintClient = {
        code: this.code,
        tenantId: this.tenantId,

        title: this.title,
        description: this.description,

        category: this.category,
        priority: this.priority,
        status: this.status,

        createdAt: this.createdAt.toISOString(),
        updatedAt: this.updatedAt.toISOString(),
      };



      // Optional top-level fields
      if ( this._id ) out._id = this._id.toString();

      if ( partial?.tenantName ) out.tenantName = partial.tenantName;

      if ( this.propertyId ) out.propertyId = this.propertyId;
      if ( partial?.propertyName ) out.propertyName = partial.propertyName;

      if ( this.assigneeId ) out.assigneeId = this.assigneeId;
      if ( partial?.assigneeName ) out.assigneeName = partial.assigneeName;

      if ( this.dueAt ) out.dueAt = this.dueAt.toISOString();



      // Complaint attachments (these are NOT comment attachments)
      const atts: ComplaintAttachmentClient[] = ( this.attachments ?? [] ).map( ( a ) => {
        const att: ComplaintAttachmentClient = {
          name: a.name,
          mimetype: a.mimetype,
          size: a.size,
          url: a.url,
        };

        if ( a._id ) att._id = a._id.toString();
        if ( a.width != null ) att.width = a.width;
        if ( a.height != null ) att.height = a.height;

        return att;
      } );

      if ( atts.length ) out.attachments = atts;

      // Timeline → client view
      const tls: ComplaintTimelineEventClient[] = ( this.timeline ?? [] ).map( ( t ) => {
        const tl: ComplaintTimelineEventClient = {
          toStatus: t.toStatus,
          at: t.at.toISOString(),
          byUserId: t.byUserId,
        };

        if ( t._id ) tl._id = t._id.toString();
        if ( t.fromStatus != null ) tl.fromStatus = t.fromStatus;
        if ( t.note != null ) tl.note = t.note;

        return tl;
      } );

      if ( tls.length ) out.timeline = tls;



      return out;
    };



    return s;
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// Model Builder
// ─────────────────────────────────────────────────────────────────────────────

class ComplaintModelBuilder {
  private static instance: Model<IComplaint> | null = null;

  public static get(): Model<IComplaint> {
    if ( this.instance ) return this.instance;

    const name = 'Complaint';

    if ( mongoose.models[ name ] ) {
      this.instance = mongoose.model<IComplaint>( name );
      return this.instance;
    }

    const schema = ComplaintSchemaBuilder.build();
    this.instance = mongoose.model<IComplaint>( name, schema );

    return this.instance;
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const ComplaintModel: Model<IComplaint> = ComplaintModelBuilder.get();
