import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import dns from "dns";
import axios from "axios";
import dotenv from "dotenv";
import { CryptoService } from "../services/crypto.service";

dotenv.config();

type ValidationResponse = {
  status: "success" | "error" | "warning";
  message: string;
  data: any;
}

export default class Validator {
  private router: Router;
  private cryptoService: CryptoService = new CryptoService();

  constructor() {
    this.router = express.Router();
    this.emailValidator();
  }

  get route(): Router {
    return this.router;
  }

  private emailValidator() {
    this.router.get(
      "/email-validator/:email",
      async (req: Request<{ email: string }>, res: Response): Promise<any> => {
        try {
          const { email } = req.params;
          const safeEmail = email.trim().toLowerCase();
          const validFormat = this.isEmailFormatValid(safeEmail);
          const hasMXRecord = await this.hasValidMXRecord(safeEmail);

          if (!validFormat) {
            return res.status(400).json({
              status: "error",
              error: "Invalid email format!",
              data: {
                email: safeEmail,
                validation: validFormat,
              },
            });
          }

          if (!hasMXRecord) {
            return res.status(400).json({
              status: "error",
              message: "Email domain is invalid (no MX record)!",
              data: {
                email: safeEmail,
                validation: hasMXRecord,
              },
            });
          }

          return res.status(200).json({
            status: "success",
            message: "Email is valid!",
            data: {
              email: safeEmail,
              validation: hasMXRecord,
            },
          });
        } catch (error) {
          if (error instanceof Error) {
            res.status(500).json({ status: "error", error: error.message });
          } else {
            res.status(500).json({
              status: "error",
              error: "An unknown error occurred." + error,
            });
          }
        }
      }
    );
  }

  private isEmailFormatValid(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
  }

  private async hasValidMXRecord(email: string): Promise<boolean> {
    const domain = email.split("@")[1];
    return new Promise((resolve) => {
      dns.resolveMx(domain, (err, addresses) => {
        if (err || !addresses || addresses.length === 0) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }
}
