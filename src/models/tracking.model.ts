// tracking.model.ts
import { Schema, model, InferSchemaType } from "mongoose";

//<============ LOGGED USER LOGIN ============>

// Subdocument schema
const LoggedUserDataSchema = new Schema(
  {
    ip_address: { type: String, required: true },
    date: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

// Main schema
const loggedUserTrackingSchema = new Schema(
  {
    username: { type: String, required: true },
    data: { type: [LoggedUserDataSchema], default: [] },
  },
  { timestamps: true }
);

// Infer the TypeScript type from the schema
export type LoggedUserTracking = InferSchemaType<
  typeof loggedUserTrackingSchema
>;

// Export the model
export const TrackingLoggedUserModel = model(
  "LoggedUserTracking",
  loggedUserTrackingSchema
);

//<============ LOGGED USER ACTIVITIES ============>

// Subdocument schema
const activitySchema = new Schema(
  {
    activity: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

// Main schema
const loggedUserActivitiesSchema = new Schema(
  {
    username: { type: String, required: true },
    ip_address: { type: String, required: true },
    activities: { type: [activitySchema], default: [] },
  },
  { timestamps: true }
);

// Infer the TypeScript type from the schema
export type LoggedUserActivities = InferSchemaType<
  typeof loggedUserActivitiesSchema
>;

// Export the model
export const LoggedUserActivitiesModel = model(
  "LoggedUserActivities",
  loggedUserActivitiesSchema
);
