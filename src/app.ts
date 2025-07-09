import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import Database from "./configs/database";
import * as path from "path";
import * as fs from "fs";
import { glob } from "glob";
import cors from "cors";
import Dotenv from "dotenv";
import UserRoute from "./api/user";
import "./services/auto-delete.service";
import Tracking from "./api/tracking";
import Property from "./api/property";
import { PlacesController } from "./api/PlacesController";
import Tenant from "./api/tenant";
import FileTransfer from "./api/fileTransfer";
import Lease from "./api/lease";

Dotenv.config();

export default class App {
  private user: UserRoute = new UserRoute();
  private tracking: Tracking = new Tracking();
  private property: Property = new Property();
  private placesController: PlacesController = new PlacesController();
  private tenant: Tenant = new Tenant();
  private fileTransfer: FileTransfer = new FileTransfer();
  private lease: Lease = new Lease();

  constructor(private app: Express = express()) {
    Database.connect().then(() => {
      this.app.set("view engine", "ejs"); // Enable EJS
      this.app.set("views", path.join(__dirname, "../public/view")); // Views folder

      this.app.use(
        cors({
          origin: ["http://localhost:4200", process.env.FRONTEND_ORIGIN].filter(
            Boolean
          ) as string[],
          credentials: true,
        })
      );

      this.app.use(express.json());
      this.app.use(express.urlencoded({ extended: true }));

      this.app.use("/api-user", this.user.route);
      this.app.use("/api-tracking", this.tracking.route);
      this.app.use("/api-property", this.property.route);
      this.app.use("/api-places", this.placesController.router);
      this.app.use("/api-tenant", this.tenant.route);
      this.app.use("/api-file-transfer", this.fileTransfer.route);
      this.app.use("/api-lease", this.lease.route);
      this.app.use(express.static(path.join(__dirname, "../public")));

      this.indexPage();
    });
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

  public listen(port: number): void {
    this.app.listen(port, "0.0.0.0", () => {
      console.log(
        `Server running on http://localhost:${port} / http://0.0.0.0:3000`
      );
    });
  }
}

const server = new App();
server.listen(3000);
