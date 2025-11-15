// Path: src/models/complaint.model.ts

// ─────────────────────────────────────────────────────────────────────────────
// Shared literals & client contracts (kept for BE/FE parity)
// ─────────────────────────────────────────────────────────────────────────────
export type ComplaintStatus =
    | 'new' | 'triaged' | 'in_progress' | 'awaiting_tenant'
    | 'resolved' | 'closed' | 'reopened' | 'cancelled';

export type ComplaintPriority = 'low' | 'medium' | 'high' | 'urgent';
export type ComplaintAudience = 'admin' | 'all' | 'agent' | 'tenant' | 'owner'
    | 'operator' | 'manager' | 'developer' | 'user' | 'system';

export type AttachmentSource = 'camera' | 'filesystem' | 'paste' | 'dragdrop';

export type ComplaintsCategory =
    | 'Plumbing' | 'Electrical' | 'Hvac' | 'Appliances' | 'Structural'
    | 'Doors Windows' | 'Security Safety' | 'Water Leak Damp' | 'Sanitation'
    | 'Internet Telecom' | 'Elevator Lift' | 'Pests Vermin' | 'Landscaping Garden'
    | 'Parking Garage' | 'Common Areas' | 'Access Keys Locks' | 'Cleaning Housekeeping'
    | 'Waste Management' | 'Painting Decor' | 'Gas Supply' | 'Noise Nuisance'
    | 'Renovation Work' | 'Other';

export const COMPLAINT_CATEGORIES: readonly ComplaintsCategory[] = [
    'Plumbing', 'Electrical', 'Hvac', 'Appliances', 'Structural', 'Doors Windows', 'Security Safety',
    'Water Leak Damp', 'Sanitation', 'Internet Telecom', 'Elevator Lift', 'Pests Vermin', 'Landscaping Garden',
    'Parking Garage', 'Common Areas', 'Access Keys Locks', 'Cleaning Housekeeping', 'Waste Management',
    'Painting Decor', 'Gas Supply', 'Noise Nuisance', 'Renovation Work', 'Other',
] as const;

export const DEFINED_AUDIENCES: readonly string[] = ['admin', 'all', 'agent', 'developer', 'manager', 'operator', 'owner', 'system', 'tenant', 'user'] as const;
export interface ComplaintAttachmentClient {
    _id?: string;
    name: string;
    mimetype: string;
    size: number;    // bytes
    url: string;     // public/secured URL
    width?: number;
    height?: number;
}

export interface PendingAttachmentClient {
    source: AttachmentSource;
    file: File;
    previewDataUrl?: string;
}

export interface ComplaintCommentClient {
    _id?: string;
    byUserId: string;
    byName: string;                  // allowed duplication (display)
    image: string;
    audience: ComplaintAudience;
    message: string;
    createdAt: string;               // ISO
    attachments?: ComplaintAttachmentClient[];
}

export interface ComplaintTimelineEventClient {
    _id?: string;
    at: string;                      // ISO
    fromStatus?: ComplaintStatus;
    toStatus: ComplaintStatus;
    byUserId: string;
    note?: string;
}

export interface ComplaintClient {
    _id?: string;
    code: string;
    tenantId: string;
    tenantName?: string;             // not persisted; injected at read
    propertyId?: string;
    propertyName?: string;           // not persisted; injected at read
    leaseId?: string;               // not persisted; injected at read
    title: string;
    description: string;
    category: ComplaintsCategory;
    priority: ComplaintPriority;
    status: ComplaintStatus;
    assigneeId?: string;
    assigneeName?: string;           // not persisted; injected at read
    createdAt: string;               // ISO
    updatedAt: string;               // ISO
    dueAt?: string;                  // ISO
    attachments?: ComplaintAttachmentClient[];
    comments?: ComplaintCommentClient[];         // duplication OK (display)
    timeline?: ComplaintTimelineEventClient[];
}

export interface CreateComplaintRequest {
    tenantId: string;
    propertyId?: string;
    title: string;
    description: string;
    category: string;
    priority: ComplaintPriority;
    attachmentIds?: string[];
}

export interface UpdateComplaintRequest {
    title?: string;
    description?: string;
    category?: string;
    priority?: ComplaintPriority;
    status?: ComplaintStatus;
    assigneeId?: string;
    dueAt?: string;
    addAttachmentIds?: string[];
    removeAttachmentIds?: string[];
}

export interface AddCommentRequest {
    complaintId: string;
    message: string;
    audience: ComplaintAudience;
    attachmentIds?: string[];
}

export interface UploadInitResponse {
    attachmentId: string;
    uploadUrl: string;
    viewUrl: string;
    expiresAt: string;               // ISO
}

// ─────────────────────────────────────────────────────────────────────────────
// Mongoose model (class-based construction, exported as ComplaintModel)
// ─────────────────────────────────────────────────────────────────────────────
import mongoose, {Schema, Document, Model} from 'mongoose';

/** Subdocument: Attachment */
export interface IComplaintAttachment extends Document {
    name: string;
    mimetype: string;
    size: number;
    url: string;
    width?: number | null;
    height?: number | null;
    source?: string | null; // optional provenance if retained later
}

class AttachmentSchemaBuilder {
    public static build(): Schema<IComplaintAttachment> {
        return new Schema<IComplaintAttachment>(
            {
                name: {type: String, required: true, trim: true},
                mimetype: {type: String, required: true, trim: true},
                size: {type: Number, required: true},
                url: {type: String, required: true, trim: true},
                width: {type: Number, default: null},
                height: {type: Number, default: null},
                source: {type: String, default: null, trim: true},
            },
            {_id: true, timestamps: false}
        );
    }
}

/** Subdocument: Comment (display duplication of byName permitted) */
export interface IComplaintComment extends Document {
    byUserId: string;
    byName: string;
    image: string;
    audience: ComplaintAudience;
    message: string;
    createdAt: Date;
    attachments?: IComplaintAttachment[];
}

class CommentSchemaBuilder {
    public static build(attachmentSchema: Schema<IComplaintAttachment>): Schema<IComplaintComment> {
        return new Schema<IComplaintComment>(
            {
                byUserId: {type: String, required: true, trim: true},
                byName: {type: String, required: true, trim: true},
                audience: {type: String, enum: ['admin', 'all', 'agent', 'tenant', 'owner', 'operator', 'manager', 'developer', 'user', 'system'], required: true, default: 'all'},
                image: {type: String, required: true, trim: true, default: 'https://www.google.com/url?sa=i&url=https%3A%2F%2Fohmylens.com%2Fdummy-profile-pic%2F&psig=AOvVaw0eaeWajno5AHrxzbwviD4U&ust=1762825037264000&source=images&cd=vfe&opi=89978449&ved=0CBUQjRxqFwoTCPjyt5S55pADFQAAAAAdAAAAABAE'},
                message: {type: String, required: true, trim: true},
                createdAt: {type: Date, required: true},
                attachments: {type: [attachmentSchema], default: []},
            },
            {_id: true, timestamps: false}
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
                at: {type: Date, required: true},
                fromStatus: {
                    type: String,
                    enum: ['new', 'triaged', 'in_progress', 'awaiting_tenant', 'resolved', 'closed', 'reopened', 'cancelled'],
                    default: null,
                },
                toStatus: {
                    type: String,
                    enum: ['new', 'triaged', 'in_progress', 'awaiting_tenant', 'resolved', 'closed', 'reopened', 'cancelled'],
                    required: true,
                },
                byUserId: {type: String, required: true, trim: true},
                note: {type: String, default: null, trim: true},
            },
            {_id: true, timestamps: false}
        );
    }
}

/** Main document: Complaint (no duplication of names in persistence) */
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
    comments: IComplaintComment[];           // allowed display duplication
    timeline: IComplaintTimelineEvent[];
    createdAt: Date;
    updatedAt: Date;

    toClient(partial?: {
        tenantName?: string | null;
        propertyName?: string | null;
        assigneeName?: string | null;
    }): ComplaintClient;
}

class ComplaintSchemaBuilder {
    public static build(): Schema<IComplaint> {
        const attachmentSchema = AttachmentSchemaBuilder.build();
        const commentSchema = CommentSchemaBuilder.build(attachmentSchema);
        const timelineSchema = TimelineSchemaBuilder.build();

        const s = new Schema<IComplaint>(
            {
                code: {type: String, required: true, unique: true, index: true, trim: true},
                tenantId: {type: String, required: true, trim: true},
                propertyId: {type: String, default: null, trim: true},
                leaseId: {type: String, default: null, trim: true},
                title: {type: String, required: true, trim: true},
                description: {type: String, required: true, trim: true},
                category: {type: String, enum: [...COMPLAINT_CATEGORIES], required: true},
                priority: {type: String, enum: ['low', 'medium', 'high', 'urgent'], required: true},
                status: {type: String, enum: ['new', 'triaged', 'in_progress', 'awaiting_tenant', 'resolved', 'closed', 'reopened', 'cancelled'], required: true},
                assigneeId: {type: String, default: null, trim: true},
                dueAt: {type: Date, default: null},
                attachments: {type: [attachmentSchema], default: []},
                comments: {type: [commentSchema], default: []},
                timeline: {type: [timelineSchema], default: []},
            },
            {
                timestamps: true,
                toJSON: {virtuals: true},
                toObject: {virtuals: true},
            }
        );

        // Helpful indexes
        s.index({tenantId: 1, createdAt: -1});
        s.index({propertyId: 1, createdAt: -1});
        s.index({status: 1, priority: 1});
        s.index({category: 1});

        // Instance: toClient — include optional fields only when present
        s.methods.toClient = function toClient(this: IComplaint, partial?: {
            tenantName?: string | null;
            propertyName?: string | null;
            assigneeName?: string | null;
        }): ComplaintClient {
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

            // optional top-level fields (add only when have value)
            if(this._id) out._id = this._id.toString();
            if(partial?.tenantName) out.tenantName = partial.tenantName;
            if(this.propertyId) out.propertyId = this.propertyId;
            if(partial?.propertyName) out.propertyName = partial.propertyName;
            if(this.assigneeId) out.assigneeId = this.assigneeId;
            if(partial?.assigneeName) out.assigneeName = partial.assigneeName;
            if(this.dueAt) out.dueAt = this.dueAt.toISOString();

            // attachments
            const atts = (this.attachments || []).map(a => {
                const att: ComplaintAttachmentClient = {
                    name: a.name,
                    mimetype: a.mimetype,
                    size: a.size,
                    url: a.url,
                };
                if(a._id) att._id = a._id.toString();
                if(a.width != null) att.width = a.width;
                if(a.height != null) att.height = a.height;
                return att;
            });
            if(atts.length) out.attachments = atts;

            // comments (duplication byName allowed)
            const cmts = (this.comments || []).map(c => {
                const com: ComplaintCommentClient = {
                    byUserId: c.byUserId,
                    byName: c.byName,
                    image: c.image,
                    audience: c.audience,
                    message: c.message,
                    createdAt: c.createdAt.toISOString(),
                };
                if(c._id) com._id = c._id.toString();
                if(c.attachments && c.attachments.length) {
                    com.attachments = c.attachments.map(a => {
                        const ca: ComplaintAttachmentClient = {
                            name: a.name,
                            mimetype: a.mimetype,
                            size: a.size,
                            url: a.url,
                        };
                        if(a._id) ca._id = a._id.toString();
                        if(a.width != null) ca.width = a.width;
                        if(a.height != null) ca.height = a.height;
                        return ca;
                    });
                }
                return com;
            });
            if(cmts.length) out.comments = cmts;

            // timeline
            const tls = (this.timeline || []).map(t => {
                const tl: ComplaintTimelineEventClient = {
                    toStatus: t.toStatus,
                    at: t.at.toISOString(),
                    byUserId: t.byUserId,
                };
                if(t._id) tl._id = t._id.toString();
                if(t.fromStatus != null) tl.fromStatus = t.fromStatus;
                if(t.note != null) tl.note = t.note;
                return tl;
            });
            if(tls.length) out.timeline = tls;

            return out;
        };

        return s;
    }
}

class ComplaintModelBuilder {
    private static instance: Model<IComplaint> | null = null;

    public static get(): Model<IComplaint> {
        if(this.instance) return this.instance;
        const name = 'Complaint';
        if(mongoose.models[name]) {
            this.instance = mongoose.model<IComplaint>(name);
            return this.instance;
        }
        const schema = ComplaintSchemaBuilder.build();
        this.instance = mongoose.model<IComplaint>(name, schema);
        return this.instance;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export the model as requested
// ─────────────────────────────────────────────────────────────────────────────
export const ComplaintModel: Model<IComplaint> = ComplaintModelBuilder.get();
