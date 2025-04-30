// src/models/user.model.ts
import mongoose, { Schema, Document } from "mongoose";

export interface Address {
  street: string;
  houseNumber: string;
  city: string;
  postcode: string;
  country?: string;
  stateOrProvince?: string;
}

export interface Roles {
  role: "admin" | "agent" | "tenant" | "operator" | "developer" | "user";
}

export interface IUser extends Document {
  firstName: string;
  middleName?: string;
  lastName: string;
  username: string;
  email: string;
  password: string;
  age: number;
  image?: string;
  phoneNumber?: string;
  role: Roles;
  address: Address;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AddressSchema = new Schema<Address>({
  street: { type: String, required: true },
  houseNumber: { type: String, required: true },
  city: { type: String, required: true },
  postcode: { type: String, required: true },
  country: String,
  stateOrProvince: String,
});

const RoleSchema = new Schema<string>({
  role: {
    type: String,
    enum: ["admin", "agent", "tenant", "operator", "developer", "user"],
    required: true,
  },
});

const UserSchema = new Schema<IUser>(
  {
    firstName: { type: String, required: true },
    middleName: String,
    lastName: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    age: { type: Number, required: true },
    image: String,
    phoneNumber: String,
    role: RoleSchema,
    address: { type: AddressSchema, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const UserModel = mongoose.model<IUser>("User", UserSchema);
