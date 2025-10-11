import express, {Express, Request, Response, NextFunction} from 'express';
import http from 'http';
import Database from './configs/database';
import path from 'path';
import cors from 'cors';
import 'dotenv/config'; // load env ASAP

// API Routes
import UserRoute from './api/user';
import Tracking from './api/tracking';
import Property from './api/property';
import {PlacesController} from './api/PlacesController';
import Tenant from './api/tenant';
import FileTransfer from './api/fileTransfer';
import Lease from './api/lease';
import Validator from './api/validator';
import NotificationController from './controller/notification.controller';
import NotificationService from './services/notification.service';

// Services
import {AutoDeleteUserService} from './services/auto-delete.service';

// Socket.IO (your class-based server)
import SocketServer from './socket/socket';

// Middleware
import {authMiddleware} from './middleware/authMiddleware';

export default class App {
  private app: Express = express();
  private httpServer = http.createServer(this.app);

  // Create and attach Socket.IO (returns io)
  private socketServer = new SocketServer({
    origins: [
      'http://localhost:4200',
      (process.env.FRONTEND_ORIGIN || '').trim() || undefined,
    ].filter(Boolean) as string[],
    jwtSecret: process.env.JWT_SECRET || 'defaultsecret',
    allowCookieAuth: true,
  });
  private io = this.socketServer.attach(this.httpServer);

  // Route modules
  private user: UserRoute = new UserRoute();
  private tracking: Tracking = new Tracking();
  private property: Property = new Property();
  private placesController: PlacesController = new PlacesController();
  private tenant: Tenant = new Tenant();
  private fileTransfer: FileTransfer = new FileTransfer();
  private lease: Lease = new Lease();
  private validator: Validator = new Validator();
  private notificationService: NotificationService = new NotificationService();
  private notification: NotificationController = new NotificationController(this.notificationService, this.socketServer);

  // Services
  private autoDeleteUserService = new AutoDeleteUserService(this.io);

  constructor () {
    Database.connect()
      .then(() => {
        this.configureApp();

        // Attach io to app early so handlers can rely on req.app.get('io')
        this.attachSocketToApp();

        this.registerRoutes();
        this.indexPage();
        this.registerNotFoundAndErrorHandlers(); // optional but helpful
      })
      .catch((err) => console.error('Database connection failed:', err));
  }

  private configureApp(): void {
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(process.cwd(), 'public', 'view')); // robust against dist/

    this.app.use(
      cors({
        origin: [
          'http://localhost:4200',
          (process.env.FRONTEND_ORIGIN || '').trim() || undefined,
        ].filter(Boolean) as string[],
        credentials: true,
      })
    );

    this.app.use(express.json({limit: '10mb'}));
    this.app.use(express.urlencoded({extended: true}));
    this.app.use(express.static(path.join(process.cwd(), 'public')));
  }

  private registerRoutes(): void {
    this.app.use('/api-user', this.user.route);
    this.app.use('/api-tracking', this.tracking.route);
    this.app.use('/api-property', this.property.route);
    this.app.use('/api-places', this.placesController.router);
    this.app.use('/api-tenant', this.tenant.route);
    this.app.use('/api-file-transfer', this.fileTransfer.route);
    this.app.use('/api-lease', this.lease.route);
    this.app.use('/api-validator', this.validator.route);
    this.app.use('/api-notification', authMiddleware, this.notification.router);

    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({status: 'ok', timestamp: Date.now()});
    });
  }

  private indexPage(): void {
    this.app.get('/', (_req: Request, res: Response) => {
      // Use sendFile for simplicity and correct headers
      res.sendFile(path.join(process.cwd(), 'public', 'index.html'), (err) => {
        if(err) {
          console.error(err);
          res.status(500).send('Internal Server Error');
        }
      });
    });
  }

  /** expose io via req.app.get('io') */
  private attachSocketToApp(): void {
    this.app.set('io', this.io);
  }

  /** optional: consistent 404 + error handling */
  private registerNotFoundAndErrorHandlers() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({status: 'error', message: 'Not Found'});
    });

    // last-resort error handler
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    this.app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      console.error('Unhandled error:', err);
      res.status(500).json({status: 'error', message: 'Internal Server Error'});
    });
  }

  public listen(port: number): void {
    this.httpServer.listen(port, '0.0.0.0', () => {
      console.log(`🚀 Server running on http://localhost:${port} (Socket.IO enabled)`);
    });
  }
}

// Bootstrap
const server = new App();
server.listen(3000);
