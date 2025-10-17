// src/models/tracking.model.ts
// ============================================================================
// Tracking Models
// ----------------------------------------------------------------------------
// PURPOSE:
//   1. Track user login sessions (IP + date).
//   2. Track user activity events performed after login.
//
// STRUCTURE:
//   - LoggedUserTracking: Keeps history of each user’s login IPs and timestamps.
//   - LoggedUserActivities: Records activity events (actions) for auditing.
//
// DEPENDENCIES:
//   - mongoose : ODM library to define schemas and interact with MongoDB.
// ============================================================================

import {Schema, model, InferSchemaType} from "mongoose";

// ============================================================================
// 1️⃣ LOGGED USER LOGIN TRACKING
// ============================================================================

// ------------------------------ Subdocument Schema ------------------------------
// This defines a single login record for a user.
// Each record stores:
//   - ip_address : The IP address from which the user logged in.
//   - date       : The date/time of the login.
//
// _id is disabled ( _id: false ) because each entry is just a small subdocument
// and we don’t need an ObjectId for every single login record.
const LoggedUserDataSchema = new Schema(
  {
    ip_address: {type: String, required: true},   // The user's IP at login
    date: {type: Date, required: true, default: Date.now}, // Auto-set login timestamp
  },
  {_id: false}
);

// ------------------------------ Main Schema ------------------------------
// This represents one document per user inside the "LoggedUserTracking" collection.
// It contains:
//   - username : The unique username being tracked.
//   - data     : An array of login records (each from LoggedUserDataSchema).
//
// timestamps: true → adds createdAt and updatedAt fields automatically.
const loggedUserTrackingSchema = new Schema(
  {
    username: {type: String, required: true},  // Which user this record belongs to
    data: {type: [LoggedUserDataSchema], default: []}, // All login entries for that user
  },
  {timestamps: true}
);

// ------------------------------ TypeScript Integration ------------------------------
// InferSchemaType automatically creates a TypeScript type that matches
// the shape of the Mongoose schema above.
export type LoggedUserTracking = InferSchemaType<typeof loggedUserTrackingSchema>;

// ------------------------------ Model Export ------------------------------
// This creates a Mongoose model called "LoggedUserTracking" which you can use like:
//
//   import { TrackingLoggedUserModel } from "../models/tracking.model";
//   const record = new TrackingLoggedUserModel({ username: "john_doe" });
//   await record.save();
//
export const TrackingLoggedUserModel = model(
  "LoggedUserTracking",
  loggedUserTrackingSchema
);

// ============================================================================
// 2️⃣ LOGGED USER ACTIVITY TRACKING
// ============================================================================

// ------------------------------ Subdocument Schema ------------------------------
// This schema defines one user activity event such as:
//   "Viewed dashboard", "Updated lease agreement", etc.
//
// Fields:
//   - activity  : Short description of the action.
//   - timestamp : When the activity occurred.
const activitySchema = new Schema(
  {
    activity: {type: String, required: true},     // Description of what the user did
    timestamp: {type: Date, default: Date.now},   // When it happened
  },
  {_id: false}
);

// ------------------------------ Main Schema ------------------------------
// This represents a log entry for each user with multiple activity records.
// Fields:
//   - username   : User performing the actions.
//   - ip_address : Where the activity came from (helps trace users).
//   - activities : Array of subdocuments (each one an activity event).
//
// timestamps: true → adds createdAt / updatedAt automatically.
const loggedUserActivitiesSchema = new Schema(
  {
    username: {type: String, required: true},     // Which user the record belongs to
    ip_address: {type: String, required: true},   // User's IP during the session
    activities: {type: [activitySchema], default: []}, // List of performed actions
  },
  {timestamps: true}
);

// ------------------------------ TypeScript Integration ------------------------------
// This type will have the exact shape of the Mongoose schema,
// allowing you to use autocompletion and strict typing in your code.
export type LoggedUserActivities = InferSchemaType<typeof loggedUserActivitiesSchema>;

// ------------------------------ Model Export ------------------------------
// The "LoggedUserActivities" collection holds user action logs.
// Example usage:
//
//   import { LoggedUserActivitiesModel } from "../models/tracking.model";
//   await LoggedUserActivitiesModel.updateOne(
//     { username: "john_doe" },
//     { $push: { activities: { activity: "Opened dashboard" } } },
//     { upsert: true }
//   );
//
export const LoggedUserActivitiesModel = model(
  "LoggedUserActivities",
  loggedUserActivitiesSchema
);

// ============================================================================
// SUMMARY
// ----------------------------------------------------------------------------
// LoggedUserTracking:
//   Tracks where/when users log in (IP + timestamp).
//
// LoggedUserActivities:
//   Tracks what users do during their session.
//
// Combined, these models provide a solid audit trail system for PropEase.
// ============================================================================
