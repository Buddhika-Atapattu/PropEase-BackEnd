import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import http from "http";
import Database from "./configs/database";
import * as path from "path";
import * as fs from "fs";
import { glob } from "glob";
import cors from "cors";
import Dotenv from "dotenv";
import UserRoute from "./api/user";
import { AutoDeleteUserService } from "./services/auto-delete.service";
import Tracking from "./api/tracking";
import Property from "./api/property";
import { PlacesController } from "./api/PlacesController";
import Tenant from "./api/tenant";
import FileTransfer from "./api/fileTransfer";
import Lease from "./api/lease";
import Validator from "./api/validator";
import { Server as SocketIOServer } from 'socket.io';

Dotenv.config();

export default class App {
  private app: Express = express();
  private httpServer = http.createServer(this.app);
  private user: UserRoute = new UserRoute();
  private tracking: Tracking = new Tracking();
  private property: Property = new Property();
  private placesController: PlacesController = new PlacesController();
  private tenant: Tenant = new Tenant();
  private fileTransfer: FileTransfer = new FileTransfer();
  private lease: Lease = new Lease();
  private validator: Validator = new Validator();
  private io = new SocketIOServer(this.httpServer, {
    cors: {
      origin: '*',
    },
  });
  private autoDeleteUserService = new AutoDeleteUserService(this.io);



  constructor() {
    Database.connect().then(() => {
      this.configureApp();
      this.registerRoutes();
      this.indexPage();
      this.setupSocket();
    });
  }

  private configureApp(): void {
    this.app.set("view engine", "ejs");
    this.app.set("views", path.join(__dirname, "../public/view"));

    this.app.use(
      cors({
        origin: ["http://localhost:4200", process.env.FRONTEND_ORIGIN].filter(Boolean) as string[],
        credentials: true,
      })
    );
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(express.static(path.join(__dirname, "../public")));
  }

  private registerRoutes(): void {
    this.app.use("/api-user", this.user.route);
    this.app.use("/api-tracking", this.tracking.route);
    this.app.use("/api-property", this.property.route);
    this.app.use("/api-places", this.placesController.router);
    this.app.use("/api-tenant", this.tenant.route);
    this.app.use("/api-file-transfer", this.fileTransfer.route);
    this.app.use("/api-lease", this.lease.route);
    this.app.use("/api-validator", this.validator.route);
  }

  private indexPage(): void {
    this.app.get("/", (req: Request, res: Response) => {
      fs.readFile(path.join(__dirname, "../public/index.html"), (err, data) => {
        if (err) {
          console.error(err);
          res.status(500).send("Internal Server Error");
        } else {
          res.send(data);
        }
      });
    });
  }

  private setupSocket(): void {
    this.io.on("connection", (socket) => {
      console.log("[Socket.IO] New client connected");

      // Example: emit a welcome message
      socket.emit("welcome", { message: "Welcome to the socket server!" });

      socket.on("disconnect", () => {
        console.log("[Socket.IO] Client disconnected");
      });
    });
  }

  public listen(port: number): void {
    this.httpServer.listen(port, "0.0.0.0", () => {
      console.log(
        `Server running with Socket.IO on http://localhost:${port} / http://0.0.0.0:${port}`
      );
    });
  }
}

const server = new App();
server.listen(3000);
