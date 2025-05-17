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
Dotenv.config();

export default class App {
  private user: UserRoute = new UserRoute();
  private tracking: Tracking = new Tracking();

  constructor(private app: Express = express()) {
    Database.connect().then(() => {
      this.app.use(cors());
      this.app.use(express.json());
      this.app.use(express.urlencoded({ extended: true }));
      this.app.use("/api-user", this.user.route);
      this.app.use("/api-tracking", this.tracking.route);
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
    this.app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  }
}

const server = new App();
server.listen(3000);
