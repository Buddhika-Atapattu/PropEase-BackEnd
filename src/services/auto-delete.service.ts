// src/services/auto-delete.service.ts
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import {Namespace} from 'socket.io';
import {UserModel} from '../models/user.model';
import NotificationService from './notification.service';

const asBool = (v: unknown, def = false) => {
  if(typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  if(typeof v === 'boolean') return v;
  return def;
};

export class AutoDeleteUserService {
  /**
   * Base path where we keep JSON backups of auto-deleted users.
   * (Think of this like a "Recycle Bin")
   */
  private readonly RECYCLE_BASE_PATH = path.join(
    __dirname,
    '../../public/recyclebin/auto-delete-users'
  );

  /** Toggle deletion behavior with env. If false, runs dry-run & notifies. */
  private readonly ENABLED = asBool(process.env.AUTO_DELETE_ENABLED, false);

  /** How many days old to be eligible for auto deletion */
  private readonly AGE_DAYS = Number(process.env.AUTO_DELETE_AGE_DAYS ?? 30);

  /** Roles to notify about auto-deletion events */
  private readonly NOTIFY_ROLES = (process.env.AUTO_DELETE_NOTIFY_ROLES ?? 'admin,operator,manager')
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);

  private readonly notificationService = new NotificationService();

  constructor (private io: Namespace) {
    // Kick off the scheduler when the service is created.
    this.initializeCronJob();
  }

  /**
   * Set up a cron job to run daily at 01:00.
   * Add timezone as needed: { timezone: 'Asia/Colombo' }
   */
  private initializeCronJob(): void {
    cron.schedule(
      '0 1 * * *',
      () => {
        this.performAutoDeletion().catch((err) => {
          const msg = '[AutoDelete] Unhandled error in performAutoDeletion';
          console.error(msg, err);
          this.safeEmit('auto-delete-notify', {
            type: 'error',
            message: msg,
            error: err?.message || String(err),
            date: new Date().toISOString(),
          });
        });
      },
      // { timezone: 'Asia/Colombo' }
    );

    console.log(
      `[AutoDelete] Daily job scheduled at 01:00. Enabled=${this.ENABLED} AgeDays=${this.AGE_DAYS} NotifyRoles=[${this.NOTIFY_ROLES.join(
        ', '
      )}]`
    );
  }

  /**
   * Core logic:
   *  - Make a dated folder (e.g., "1st of July 2025") under RECYCLE_BASE_PATH
   *  - Find users where autoDelete=true AND createdAt <= T-AGE_DAYS
   *  - Backup them to JSON
   *  - If ENABLED -> Delete them from DB, else dry-run
   *  - Emit socket events + Create a Notification with full metadata
   */
  private async performAutoDeletion(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.AGE_DAYS * 24 * 60 * 60 * 1000);
    const folderName = this.formatDateFolderName(now);
    const targetDir = path.join(this.RECYCLE_BASE_PATH, folderName);

    try {
      // Ensure parent folder exists
      fs.mkdirSync(targetDir, {recursive: true});

      // Find users that should be auto-deleted
      const usersToDelete = await UserModel.find({
        autoDelete: true,
        createdAt: {$lte: cutoff},
      })
        .lean()
        .exec();

      // If no users to delete, notify and exit
      if(!usersToDelete.length) {
        const infoMsg = '[AutoDelete] No users to delete today.';
        console.log(infoMsg);
        this.safeEmit('auto-delete-notify', {
          type: 'info',
          message: infoMsg,
          date: now.toISOString(),
        });

        await this.notifyAdmins({
          runMode: 'dry-run', // nothing to delete anyway
          cutoffISO: cutoff.toISOString(),
          deletedCount: 0,
          deletedUsers: [],
          backupPath: null,
          recycleFolder: folderName,
          when: now.toISOString(),
        });

        return;
      }

      // Backup user data as JSON before deletion (kept even in dry-run)
      const backupFilePath = path.join(targetDir, 'users.json');
      fs.writeFileSync(backupFilePath, JSON.stringify(usersToDelete, null, 2), 'utf-8');

      // Keep this false in non-prod to avoid any real deletions.
      // In production, you can either:
      //   1) set `const deletionActive = this.ENABLED;`
      //   2) or uncomment the delete block below.
      const deletionActive = false;

      let deletedCount = 0;

      if(deletionActive) {
        /* ───────────────────────────────────────────────────────────────
         *  PROD-ONLY: UNCOMMENT TO ENABLE ACTUAL DELETION
         * ───────────────────────────────────────────────────────────────
        const result = await UserModel.deleteMany({
          _id: { $in: usersToDelete.map((u) => u._id) },
        }).exec();
  
        deletedCount = result.deletedCount ?? 0;
  
        const successMessage =
          `[AutoDelete] Deleted ${deletedCount} user(s). ` +
          `Backup saved to: ${backupFilePath}`;
        console.log(successMessage);
  
        this.safeEmit('auto-delete-notify', {
          type: 'success',
          message: successMessage,
          deletedCount,
          backupPath: backupFilePath,
          date: now.toISOString(),
        });
        */
      } else {
        // Dry-run
        const dryMsg =
          `[AutoDelete] Dry-run: would delete ${usersToDelete.length} user(s). ` +
          `Backup preview saved to: ${backupFilePath}. Cutoff: ${cutoff.toISOString()}`;
        console.log(dryMsg);

        this.safeEmit('auto-delete-notify', {
          type: 'info',
          message: dryMsg,
          wouldDeleteCount: usersToDelete.length,
          backupPath: backupFilePath,
          date: now.toISOString(),
        });
      }

      // Notify admins/operators with full metadata
      await this.notifyAdmins({
        runMode: deletionActive ? 'delete' : 'dry-run',
        cutoffISO: cutoff.toISOString(),
        deletedCount: deletionActive ? deletedCount : 0,
        deletedUsers: this.packUsersForMeta(usersToDelete), // safe mapper (no undefineds)
        backupPath: backupFilePath,
        recycleFolder: folderName,
        when: now.toISOString(),
      });
    } catch(error: any) {
      const errMsg = '[AutoDelete] Error during deletion.';
      console.error(errMsg, error);

      this.safeEmit('auto-delete-notify', {
        type: 'error',
        message: errMsg,
        error: error?.message || String(error),
        date: now.toISOString(),
      });

      // Also notify admins about the failure (as a notification)
      await this.notifyAdmins({
        runMode: 'dry-run',
        cutoffISO: cutoff.toISOString(),
        deletedCount: 0,
        deletedUsers: [],
        backupPath: null,
        recycleFolder: folderName,
        when: now.toISOString(),
        error: error?.message || String(error),
      });
    }
  }


  /** Reduce user docs to lightweight, useful metadata for Notifications. */
  private packUsersForMeta(users: any[]) {
    type MetaUser = {
      _id: string;
      username?: string;
      email?: string;
      role?: string;
      isActive?: boolean;
      createdAt?: string;  // must NOT receive undefined when exactOptionalPropertyTypes=true
      autoDelete?: boolean;
    };

    return users.map((u): MetaUser => {
      const m: MetaUser = {_id: String(u._id)};

      if(typeof u.username === 'string' && u.username) m.username = u.username;
      if(typeof u.email === 'string' && u.email) m.email = u.email;
      if(typeof u.role === 'string' && u.role) m.role = u.role;
      if(typeof u.isActive === 'boolean') m.isActive = u.isActive;

      // Only set createdAt if we have a valid date; otherwise omit the property entirely
      if(u.createdAt) {
        const d = new Date(u.createdAt);
        if(!Number.isNaN(d.getTime())) m.createdAt = d.toISOString();
      }

      if(u.autoDelete != null) m.autoDelete = !!u.autoDelete;

      return m;
    });
  }


  /**
   * Create an in-app notification to admins/operators with a rich metadata payload.
   * Uses NotificationService.createNotification and emits via Socket.IO rooms.
   */
  private async notifyAdmins(meta: {
    runMode: 'delete' | 'dry-run';
    cutoffISO: string;
    deletedCount: number;
    deletedUsers: Array<{
      _id: string;
      username?: string;
      email?: string;
      role?: string;
      isActive?: boolean;
      createdAt?: string;
      autoDelete?: boolean;
    }>;
    backupPath: string | null;
    recycleFolder: string;
    when: string;
    error?: string;
  }) {
    const title = meta.error
      ? ('Auto Delete Users Failed' as const)
      : (meta.runMode === 'delete'
        ? ('Users Auto-Deleted' as const)
        : ('Users Auto-Delete Dry-Run' as const));

    const body = meta.error
      ? `Auto delete process failed. Check server logs.`
      : meta.runMode === 'delete'
        ? `Deleted ${meta.deletedCount} user(s).`
        : `Dry-run: would delete ${meta.deletedUsers.length} user(s).`;

    // Build notification doc
    const doc = {
      title,
      body,
      type: meta.error ? ('error' as const) : ('maintenance' as const),
      severity: meta.error ? ('error' as const) : ('info' as const),
      audience: {
        mode: 'role' as const,
        roles: this.NOTIFY_ROLES as Array<
          'admin' | 'agent' | 'tenant' | 'owner' | 'operator' | 'manager' | 'developer' | 'user'
        >,
      },
      channels: ['inapp'] as const, // add 'email' later if you also want email delivery
      metadata: {
        runMode: meta.runMode,
        cutoffISO: meta.cutoffISO,
        deletedCount: meta.deletedCount,
        deletedUsers: meta.deletedUsers, // full list
        backupPath: meta.backupPath,
        recycleFolder: meta.recycleFolder,
        executedAt: meta.when,
        error: meta.error,
      },
      source: 'auto-delete-service',
      tags: ['system', 'auto-delete'],
    } as const;

    // Send + emit
    await this.notificationService.createNotification(
      doc as any,
      (rooms, payload) => {
        // rooms is string[] like ['role:admin', 'role:operator']
        rooms.forEach((room) => this.io.to(room).emit('notification.new', payload));
      }
    );
  }

  /**
   * Format folder name like "1st of July 2025"
   * Uses a type-safe ordinal generator (no out-of-range array indexing).
   */
  private formatDateFolderName(date: Date): string {
    const day = date.getDate();
    const monthNames = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ] as const;
    const month = monthNames[date.getMonth()];
    const year = date.getFullYear();

    return `${this.getOrdinal(day)} of ${month} ${year}`;
  }

  /**
   * Return day-of-month with ordinal: 1 -> "1st", 2 -> "2nd", 3 -> "3rd", else "th".
   * This avoids any possibly-undefined array indexing.
   */
  private getOrdinal(n: number): string {
    const v = n % 100;
    if(v > 10 && v < 20) return `${n}th`; // 11th, 12th, 13th, ...
    switch(n % 10) {
      case 1:
        return `${n}st`;
      case 2:
        return `${n}nd`;
      case 3:
        return `${n}rd`;
      default:
        return `${n}th`;
    }
  }

  /**
   * Emit safely to the socket namespace; guards against runtime issues.
   */
  private safeEmit(event: string, payload: unknown): void {
    try {
      this.io.emit(event, payload as any);
    } catch(e) {
      console.error('[AutoDelete] Socket emit failed:', e);
    }
  }
}
