import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import * as path from "path";
import * as fs from "fs";
import Database from "./configs/database";
import { glob } from "glob";
import User from "./api/user";
import cors from "cors";
import Dotenv from "dotenv";
Dotenv.config();

export default class App {
  private app: Express;
  private User: User = new User();

  constructor() {
    this.app = express();
    this.app.use(express.static(path.join(__dirname, "../public")));
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(cors());
    this.app.use(this.User.route);
    Database.connect();
  }

  private indexPage(): void {
    this.app.get("/", (req: Request, res: Response) => {
      fs.readFile(path.join(__dirname, "../public/index.html"), (err, data) => {
        if (err) {
          console.error(err);
          res.status(500).send("Internal Server Error");
        } else {
          // res.send(data)
          console.log(data);
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
