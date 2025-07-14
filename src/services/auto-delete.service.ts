import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { Server as SocketIOServer } from 'socket.io';
import { UserModel } from '../models/user.model';

export class AutoDeleteUserService {
  // Define the base path for saving deleted user backups (Recycle Bin)
  private readonly RECYCLE_BASE_PATH = path.join(__dirname, '../../public/recyclebin/auto-delete-users');

  constructor(private io: SocketIOServer) {
    // Initialize the cron job when the service is instantiated
    this.initializeCronJob();
  }

  // Set up a cron job that runs daily at 1 AM
  private initializeCronJob(): void {
    cron.schedule('0 1 * * *', () => {
      this.performAutoDeletion();
    });
  }

  // Core logic: find and delete users older than 30 days with autoDelete enabled
  private async performAutoDeletion(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const folderName = this.formatDateFolderName(now);
    const targetDir = path.join(this.RECYCLE_BASE_PATH, folderName);

    try {
      // Ensure the backup folder exists
      fs.mkdirSync(targetDir, { recursive: true });

      // Find users that should be auto-deleted
      const usersToDelete = await UserModel.find({
        autoDelete: true,
        createdAt: { $lte: cutoff },
      });

      // If no users to delete, notify frontend and exit
      if (usersToDelete.length === 0) {
        this.io.emit('auto-delete-notify', {
          type: 'info',
          message: '[AutoDelete] No users to delete today.',
          date: now.toISOString()
        });
        return;
      }

      // Backup user data as JSON before deletion
      const backupFilePath = path.join(targetDir, 'users.json');
      fs.writeFileSync(backupFilePath, JSON.stringify(usersToDelete, null, 2), 'utf-8');

      // Perform deletion in the database
      const result = await UserModel.deleteMany({
        _id: { $in: usersToDelete.map(u => u._id) }
      });

      // Log and notify successful deletion
      const successMessage = `[AutoDelete] Deleted ${result.deletedCount} user(s). Backup saved to: ${backupFilePath}`;
      console.log(successMessage);

      this.io.emit('auto-delete-notify', {
        type: 'success',
        message: successMessage,
        deletedCount: result.deletedCount,
        backupPath: backupFilePath,
        date: now.toISOString()
      });

    } catch (error: any) {
      // Log and emit error if anything goes wrong
      const errMsg = '[AutoDelete] Error during deletion.';
      console.error(errMsg, error);

      this.io.emit('auto-delete-notify', {
        type: 'error',
        message: errMsg,
        error: error?.message || error.toString(),
        date: now.toISOString()
      });
    }
  }

  // Format folder name like "1st of July 2025"
  private formatDateFolderName(date: Date): string {
    const day = date.getDate();
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const month = monthNames[date.getMonth()];
    const year = date.getFullYear();

    // Generate ordinal suffix (st, nd, rd, th)
    const getOrdinal = (n: number) => {
      const s = ['th', 'st', 'nd', 'rd'];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };

    return `${getOrdinal(day)} of ${month} ${year}`;
  }
}