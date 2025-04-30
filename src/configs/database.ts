import mongoose from "mongoose";

export default class Database {
  // Default URI, can be overridden by .env
  private static uri: string =
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/propease";

  // Static method to connect to MongoDB
  public static async connect(): Promise<void> {
    try {
      const connection = await mongoose.connect(this.uri);
      console.log(`MongoDB connected: ${connection.connection.name}`);
    } catch (error) {
      console.error("MongoDB connection error:", error);
      process.exit(1);
    }
  }
}
