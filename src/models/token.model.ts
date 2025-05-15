import { Schema, model, Document } from "mongoose";

interface ITokenMap extends Document {
  token: string;
  username: string;
  type: "view" | "email" | "session" | string;
  expiresAt: Date;
}

//Token generation
const TokenMapSchema = new Schema<ITokenMap>({
  token: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  type: { type: String, enum: ["view", "email", "session"], default: "view" },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 },
  },
});

export const TokenMap = model<ITokenMap>("TokenMap", TokenMapSchema);