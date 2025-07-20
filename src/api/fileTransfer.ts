import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import multer from "multer";
import sharp from "sharp";
import {CryptoService} from "../services/crypto.service";
import {
  FILE,
  TokenViceData,
  ScannedFileRecordJSON,
  TenantScannedFilesDataJSON,
} from "../models/lease.model";
import * as libre from 'libreoffice-convert';
import {promisify} from 'util';
import axios from 'axios';


dotenv.config();

export default class FileTransfer {
  private router: Router;
  private cryptoService: CryptoService = new CryptoService();

  constructor () {
    this.router = express.Router();
    this.getTenantMobileFileUpload();
    this.getReasonFileUploadsByTenantUsername();
    this.cleanTheTokenFolderAfterThirtyMinutesAutomatically();
    this.convertToPDF();
  }

  get route(): Router {
    return this.router;
  }

  private getTenantMobileFileUpload() {
    let uniqueName: string;
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const {token} = req.params;

        const uploadPath = path.join(
          __dirname,
          `../../public/tenants/tokens/${token}`
        );

        if(!fs.existsSync(uploadPath)) {
          fs.mkdirSync(uploadPath, {recursive: true});
        }

        cb(null, uploadPath);
      },
      filename: (req, file, cb) => {
        uniqueName = `${Date.now()}-${file.originalname}`;
        cb(null, uniqueName);
      },
    });

    const upload = multer({storage});

    this.router.post(
      "/get-tenant-mobile-file-upload/:token",
      upload.single("image"),
      async (req: Request<{token: string}>, res: Response) => {
        try {
          // Define base URL
          const host = req.get("host");
          const protocol = req.protocol;
          const baseUrl = `${protocol}://${host}`;

          const {token} = req.params;
          if(!token) throw new Error("Token is required!");

          const encryptedToken = decodeURIComponent(req.params.token);

          if(!encryptedToken) throw new Error("Invalid Token!");
          console.log("encryptedToken: ", encryptedToken);

          const decryptedToken = await this.cryptoService.decrypt(
            encryptedToken
          );

          console.log("decryptedToken: ", decryptedToken);

          const {tenant, issuedAt} = JSON.parse(decryptedToken);

          if(!tenant || !issuedAt) throw new Error("Invalid token");

          const maxAgeMs = 10 * 60 * 1000;

          if(Date.now() - issuedAt > maxAgeMs) {
            throw new Error("Token expired!");
          }

          const file = req.file as Express.Multer.File | undefined;

          if(!file) throw new Error("Image is required");

          const JSONFile = path.join(
            __dirname,
            "../../public/tenants/scanned-files/tenantScannedFilesData.json"
          );

          // Ensure JSON file exists
          if(!fs.existsSync(JSONFile)) {
            await fs.promises.writeFile(JSONFile, JSON.stringify({}));
          }

          const distincPath = path.join(
            __dirname,
            `../../public/tenants/scanned-files/${tenant}/`
          );
          const currentPath = path.join(
            __dirname,
            `../../public/tenants/tokens/${token}/`
          );

          if(fs.existsSync(currentPath)) {
            fs.promises.rename(currentPath, distincPath);
          }

          const fileContent = await fs.promises.readFile(JSONFile, "utf8");
          let existing: TenantScannedFilesDataJSON = fileContent
            ? JSON.parse(fileContent)
            : {};

          const filedata: FILE = {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            filename: uniqueName,
            URL: `${baseUrl}/tenants/scanned-files/${tenant}/${uniqueName}`,
          };

          const tokenEntry: TokenViceData = {
            ageInMinutes: 0,
            date: new Date().toISOString(),
            file: filedata,
            token,
            folder: distincPath,
          };

          // Initialize tenant array if it doesn't exist
          if(!existing[tenant]) {
            existing[tenant] = [];
          }

          // Find existing token record for this tenant
          let record: ScannedFileRecordJSON | undefined = existing[tenant].find(
            (r) => r.token === token
          );

          if(!record) {
            // If no record for this token, create new one
            record = {
              date: new Date().toISOString(),
              tenant,
              token,
              files: [],
              folder: distincPath,
            };
            existing[tenant].push(record);
          }

          record.files.push(tokenEntry);

          // Save back to JSON file
          await fs.promises.writeFile(
            JSONFile,
            JSON.stringify(existing, null, 2)
          );

          res.status(200).json({
            status: "success",
            message: "Image uploaded successfully",
            data: record,
          });
        } catch(error) {
          if(error) {
            console.error("Error occurred: ", error);
            res.status(500).json({
              status: "error",
              message: "Error occured: " + error,
            });
          }
        }
      }
    );
  }

  private getReasonFileUploadsByTenantUsername() {
    this.router.get(
      "/get-reason-file-uploads-by-tenant-username/:tenant",
      async (req: Request<{tenant: string}>, res: Response) => {
        try {
          const {tenant} = req.params;
          if(!tenant) throw new Error("Tenant is required");

          const host = req.get("host");
          const protocol = req.protocol;
          const baseUrl = `${protocol}://${host}`;

          const jsonDataFile = path.join(
            __dirname,
            "../../public/tenants/scanned-files/tenantScannedFilesData.json"
          );

          if(!fs.existsSync(jsonDataFile)) {
            throw new Error("Scanned files JSON not found");
          }

          const row = await fs.promises.readFile(jsonDataFile, "utf8");
          const JSON_DATA: TenantScannedFilesDataJSON = JSON.parse(row);

          const tenantRecords = JSON_DATA[tenant];

          if(!tenantRecords || tenantRecords.length === 0) {
            throw new Error("No scan records found for this tenant");
          }

          const now = Date.now();
          // 24 hours in milliseconds
          const msIn24Hours = 24 * 60 * 60 * 1000;
          const results: ScannedFileRecordJSON[] = [];

          for(const item of tenantRecords) {
            const createdAt = new Date(item.date).getTime();
            const ageInMinutes: number = Math.floor(
              (now - createdAt) / (60 * 1000)
            );

            item.files.forEach((file) => (file.ageInMinutes = ageInMinutes));
            const dateToCheck = new Date(item.date).getTime();
            const isWithin24Hours = now - dateToCheck <= msIn24Hours;

            if(isWithin24Hours) results.push(item);
          }

          res.status(200).json({
            status: "success",
            tenant,
            total: results.length,
            data: results,
          });
        } catch(error) {
          console.error("Error reading tenant scanned files:", error);
          res.status(500).json({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );
  }

  private cleanTheTokenFolderAfterThirtyMinutesAutomatically() {
    const mainFolder = path.join(__dirname, `../../public/tenants/tokens/`);
    const timeLimit = 30 * 60 * 1000; // 30 minutes

    try {
      if(!fs.existsSync(mainFolder)) {
        console.warn("Token root folder not found.");
        return;
      }

      const tokenFolders = fs.readdirSync(mainFolder);

      tokenFolders.forEach((tokenFolder) => {
        const tokenFolderPath = path.join(mainFolder, tokenFolder);

        try {
          const stats = fs.statSync(tokenFolderPath);
          const createdTime = stats.birthtimeMs || stats.ctimeMs;
          const now = Date.now();

          if(now - createdTime > timeLimit) {
            fs.promises
              .rm(tokenFolderPath, {recursive: true, force: true})
              .then(() => {
                console.log(
                  `Deleted: ${tokenFolder} cteated at ${createdTime}`
                );
              })
              .catch((err) => {
                console.error(
                  `Failed to delete ${tokenFolder}: ${err.message}`
                );
              });
          }
        } catch(folderErr) {
          console.error(`Error checking folder ${tokenFolder}: ${folderErr}`);
        }
      });
    } catch(err) {
      console.error("Unexpected error during token folder cleanup:", err);
    }
  }

  private convertToPDF() {
    this.router.post('/convert-to-pdf', async (req: Request, res: Response): Promise<any> => {
      try {
        const {fileUrl} = req.body;
        if(!fileUrl) return res.status(400).send('File URL is required');

        const response = await axios.get(fileUrl, {responseType: 'arraybuffer'});
        const fileBuffer = Buffer.from(response.data);
        const extension = path.extname(fileUrl);

        libre.convert(fileBuffer, '.pdf', undefined, (err, done) => {
          if(err) {
            console.error('Conversion error:', err);
            return res.status(500).send('PDF conversion failed');
          }

          res.setHeader('Content-Type', 'application/pdf');
          res.send(done);
        });

      } catch(error) {
        console.error('PDF conversion failed:', error);
        res.status(500).json({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
