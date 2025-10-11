// src/controller/notification.controller.ts
import { Router, RequestHandler } from 'express';
import NotificationService from '../services/notification.service';
import SocketServer from '../socket/socket';
import { Role } from '../types/roles';

// Auth-augmented request (runtime cast only)
type AuthedReq = Express.Request & { user: { username: string; role: Role } };

export default class NotificationController {
  public readonly router = Router();

  constructor(
    private readonly service: NotificationService,
    private readonly sockets: SocketServer
  ) {
    this.router.get('/', this.listMine);
    this.router.post('/create', this.create);
    this.router.post('/:id/read', this.markRead);
    this.router.post('/read-all', this.markAllRead);
  }

  /** List all notifications for the logged-in user (filtered by role + username) */
  private listMine: RequestHandler = async (req, res) => {
    try {
      const { username, role } = ((req as unknown) as AuthedReq).user;
      const { skip = '0', limit = '50', unread } = req.query as any;

      const data = await this.service.listForUser(username, role, {
        skip: Number(skip),
        limit: Number(limit),
        onlyUnread: unread === 'true',
      });

      res.json({ success: true, data });
    } catch (err: any) {
      console.error('Error listing notifications:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  };

  /** Create a new notification (admin/operator typically) */
  private create: RequestHandler = async (req, res) => {
    try {
      const allowedRoles: ReadonlyArray<Role> = ['admin', 'operator', 'manager'];
      const { role } = ((req as unknown) as AuthedReq).user;

      if (!allowedRoles.includes(role)) {
        res.status(403).json({ message: 'Permission denied' });
        return;
      }

      const created = await this.service.createNotification(
        req.body,
        (rooms, payload) => {
          // Use the helper from socket.ts
          this.sockets.emitToRooms(rooms, 'notification.new', payload);
        }
      );

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      console.error('Error creating notification:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  };

  /** Mark one notification as read for the current user */
  private markRead: RequestHandler = async (req, res) => {
    try {
      const { username } = ((req as unknown) as AuthedReq).user;
      const { id } = req.params;

      await this.service.markRead(username, id);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Error marking notification as read:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  };

  /** Mark all notifications as read */
  private markAllRead: RequestHandler = async (req, res) => {
    try {
      const { username } = ((req as unknown) as AuthedReq).user;
      await this.service.markAllRead(username);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Error marking all notifications as read:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  };
}
