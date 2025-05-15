import { UserModel } from "../models/user.model";
import cron from "node-cron";

cron.schedule("0 1 * * *", async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const result = await UserModel.deleteMany({
      autoDelete: true,
      createdAt: { $lte: cutoff },
    });

    console.log(
      `[AutoDelete] Deleted ${result.deletedCount} user(s) older than 30 days.`
    );
  } catch (error) {
    console.error("[AutoDelete] Error during deletion:", error);
  }
});
