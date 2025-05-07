// src/models/user.model.ts
import mongoose, { Schema, Document } from "mongoose";

export interface Country {
  name: string;
  code: string;
  emoji: string;
  unicode: string;
  image: string;
}

export interface UserCredentials {
  username: string;
  password: string;
  rememberMe?: boolean;
}

export interface Address {
  street: string;
  houseNumber: string;
  city: string;
  postcode: string;
  country?: string;
  stateOrProvince?: string;
}

export interface Role {
  role: "admin" | "agent" | "tenant" | "operator" | "developer" | "user";
}

export interface BaseUser {
  __id?: string;
  __v?: number;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  username: string;
  email: string;
  dateOfbirth?: Date | null;
  age: number;
  image?: string | File;
  phoneNumber?: string;
  role: Role;
  address: Address;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewUser extends BaseUser {
  password: string;
}

export interface UsersType extends NewUser {}

export interface UpdateUserType extends Omit<BaseUser, "createdAt"> {}

export interface LoggedUserType extends Omit<NewUser, "password"> {}

export interface IUser extends Document {
  firstName: string;
  middleName?: string;
  lastName: string;
  username: string;
  email: string;
  dateOfBirth?: Date;
  password: string;
  age: number;
  image?: string | File;
  phoneNumber?: string;
  role: Role;
  address: Address;
  isActive: boolean;
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
    dateOfBirth: { type: Date, required: true },
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
