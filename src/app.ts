import express, {Express, Request, Response} from 'express';
import http from 'http';
import Database from './configs/database';
import * as path from 'path';
import * as fs from 'fs';
import cors from 'cors';
import Dotenv from 'dotenv';

// API Routes
import UserRoute from './api/user';
import Tracking from './api/tracking';
import Property from './api/property';
import {PlacesController} from './api/PlacesController';
import Tenant from './api/tenant';
import FileTransfer from './api/fileTransfer';
import Lease from './api/lease';
import Validator from './api/validator';

// Services
import {AutoDeleteUserService} from './services/auto-delete.service';

// Socket.IO
import {setupSocket} from './socket/socket';

Dotenv.config();

export default class App {
  private app: Express = express();
  private httpServer = http.createServer(this.app);
  private io = setupSocket(this.httpServer); // ✅ unified socket setup

  // Route modules
  private user: UserRoute = new UserRoute();
  private tracking: Tracking = new Tracking();
  private property: Property = new Property();
  private placesController: PlacesController = new PlacesController();
  private tenant: Tenant = new Tenant();
  private fileTransfer: FileTransfer = new FileTransfer();
  private lease: Lease = new Lease();
  private validator: Validator = new Validator();

  // Services
  private autoDeleteUserService = new AutoDeleteUserService(this.io);

  constructor () {
    Database.connect()
      .then(() => {
        this.configureApp();
        this.registerRoutes();
        this.indexPage();
        this.attachSocketToApp(); // ✅ allows access via req.app.get('io')
      })
      .catch((err) => console.error('Database connection failed:', err));
  }

  private configureApp(): void {
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(__dirname, '../public/view'));

    this.app.use(
      cors({
        origin: [
          'http://localhost:4200',
          process.env.FRONTEND_ORIGIN,
        ].filter(Boolean) as string[],
        credentials: true,
      })
    );
    this.app.use(express.json());
    this.app.use(express.urlencoded({extended: true}));
    this.app.use(express.static(path.join(__dirname, '../public')));
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
  }

  private indexPage(): void {
    this.app.get('/', (req: Request, res: Response) => {
      fs.readFile(path.join(__dirname, '../public/index.html'), (err, data) => {
        if(err) {
          console.error(err);
          res.status(500).send('Internal Server Error');
        } else {
          res.send(data);
        }
      });
    });
  }

  /** ✅ attach io instance to express app so it’s accessible everywhere */
  private attachSocketToApp(): void {
    this.app.set('io', this.io);
  }

  public listen(port: number): void {
    this.httpServer.listen(port, '0.0.0.0', () => {
      console.log(
        `🚀 Server running on http://localhost:${port} (Socket.IO enabled)`
      );
    });
  }
}

// Bootstrap
const server = new App();
server.listen(3000);
