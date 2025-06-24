import { Schema, model, Document } from "mongoose";

export interface ITenant extends Document {
  username: string;
  image: string;
  name: string;
  contactNumber: string;
  email: string;
  gender: string;
  addedBy: string;
}

const TenantSchema: Schema = new Schema(
  {
    username: { type: String, required: true, default: "" },
    image: { type: String, required: true, default: "" },
    name: { type: String, required: true, default: "" },
    contactNumber: { type: String, required: true, default: "" },
    email: { type: String, required: true, default: "" },
    gender: { type: String, required: true, default: "" },
    addedBy: { type: String, required: true, default: "" },
  },
  { timestamps: true }
);

export const TenantModel = model<ITenant>("Tenant", TenantSchema);
