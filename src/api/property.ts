// File: src/api/property.ts
// Import necessary modules and types
import express, {
  Express,
  Request,
  Response,
  NextFunction,
  Router,
} from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import {UserDocument} from "../models/file-upload.model";
import {UserModel} from "../models/user.model";
import {
  PropertyModel,
  IProperty,
  Address,
  CountryDetails,
  AddedBy,
  GoogleMapLocation,
} from "../models/property.model";
import fs from "fs";
import path from "path";
import multer from "multer";
import sharp from "sharp";
import NotificationService from '../services/notification.service';
import fsp from 'fs/promises';
import {Types} from "mongoose";
import {Http2ServerResponse} from "http2";
import {HttpMethod} from "twilio/lib/interfaces";



dotenv.config();

interface filterDialogData {
  minPrice: number;
  maxPrice: number;
  beds: string;
  bathrooms: string;
  amenities: string[];
  type: string;
  status: string;
}

interface UploadedImage {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  imageURL: string;
}

interface UploadedDocument {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  documentURL: string;
}

export default class Property {
  // Define the router for the property API
  // This will handle the routing for the property API
  private router: express.Router;
  // This is the constructor for the Property class
  // It initializes the router and sets up the routes
  constructor () {
    this.router = express.Router();
    // Insert property and used muter for file handle
    this.insertProperty();
    this.test();
    // Get all properties with pagination, search and filter
    this.getAllPropertiesWithPagination();
    // Get single property by ID
    this.getSinglePropertyById();
    // Delete the property by ID
    this.deleteProperty();
    // Update the property by ID and used muter to file handle
    this.updateProperty();
    // Get all properties
    this.getAllProperties();
  }

  get route(): Router {
    return this.router;
  }

  private test() {
    this.router.get("/test", (req: Request, res: Response) => {
      // This is a test route to check if the server is running
      // It returns a simple message
      res.status(200).json({
        status: "success",
        message: "Property API is working",
      });
    });
  }
  //<==================== INSERT PROPERTY ====================>
  // This method is used to insert a property into the database
  private insertProperty(): void {
    // Define allowed document types
    // You can add more types as per your requirements
    const allowedDocumentTypes = [
      // Word Documents
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/rtf",

      // Excel Documents
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "text/csv",
      "text/tab-separated-values",

      // PowerPoint Documents
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.template",

      // OpenDocument Formats
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",

      // PDF
      "application/pdf",

      // Plain Text
      "text/plain",
    ];

    // Define allowed images types
    // You can add more types as per your requirements
    const allowedImageTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/bmp",
      "image/tiff",
      "image/webp",
      "image/svg+xml",
    ];

    // Define the storage engine for multer
    // This will save the files to the disk
    const storage = multer.diskStorage({
      // Define the destination for the uploaded files
      // The destination is determined based on the field name
      destination: (req, file, cb) => {
        // Check if the property ID is provided in the form data
        // This is used to create a unique folder for each property
        const propertyID = req.params.propertyID;

        // If property ID is not provided, return an error
        // This is important to ensure that files are saved in the correct location
        if(!propertyID) {
          // If property ID is not provided, return an error
          // This is important to ensure that files are saved in the correct location
          return cb(new Error("Property ID is required in form data."), "");
        }

        // Define the upload path based on the field name
        // This will create a unique folder for each property
        let uploadPath = "";
        // Check the field name to determine the upload path
        // If the field name is "images", save to the images folder
        if(file.fieldname === "images") {
          // Create the upload path for images
          // This will create a unique folder for each property
          uploadPath = path.join(
            __dirname,
            `../../public/propertyUploads/${propertyID}/tempImages/`
          );
          // If the field name is "documents", save to the documents folder
          // This will create a unique folder for each property
        } else if(file.fieldname === "documents") {
          // Create the upload path for documents
          // This will create a unique folder for each property
          uploadPath = path.join(
            __dirname,
            `../../public/propertyUploads/${propertyID}/documents/`
          );
          // If the field name is not recognized, return an error
          // This is important to ensure that files are saved in the correct location
        } else {
          // If the field name is not recognized, return an error
          // This is important to ensure that files are saved in the correct location
          return cb(new Error("Unexpected field: " + file.fieldname), "");
        }
        // Create the upload path if it doesn't exist
        // This is important to ensure that files are saved in the correct location
        fs.mkdirSync(uploadPath, {recursive: true});
        // Return the upload path to multer
        // This is important to ensure that files are saved in the correct location
        cb(null, uploadPath);
      },
      // Define the filename for the uploaded files
      // This will create a unique filename for each file
      filename: (req, file, cb) => {
        // Create a unique filename using the current timestamp and a random number
        // This is important to ensure that files are saved in the correct location
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        // Replace spaces in the original filename with underscores
        // This is important to ensure that files are saved in the correct location
        const sanitized = file.originalname.replace(/\s+/g, "_");
        // Create the final filename using the unique suffix and the sanitized original filename
        // This is important to ensure that files are saved in the correct location
        cb(null, `${uniqueSuffix}-${sanitized}`);
      },
    });

    // Define the file filter for multer
    // This will check the file type and size before uploading
    const fileFilter = (req: Request, file: Express.Multer.File, cb: any) => {
      // Check if the image type is allowed
      // This is important to ensure that files are saved in the correct location
      if(
        file.fieldname === "images" &&
        allowedImageTypes.includes(file.mimetype)
      ) {
        // If the image type is allowed, return true
        // This is important to ensure that files are saved in the correct location
        cb(null, true);
        // Check if the document type is allowed
        // This is important to ensure that files are saved in the correct location
      } else if(
        file.fieldname === "documents" &&
        allowedDocumentTypes.includes(file.mimetype)
      ) {
        // If the document type is allowed, return true
        // This is important to ensure that files are saved in the correct location
        cb(null, true);
      } else {
        // If the file type is not allowed, return an error
        // This is important to ensure that files are saved in the correct location
        cb(new Error("File type not allowed: " + file.mimetype));
      }
    };

    // Create the multer instance with the defined storage and file filter
    // This will check the file type and size before uploading
    const upload = multer({storage, fileFilter});

    // Define the route for inserting a property
    // This will handle the file upload and save the property to the database
    this.router.post(
      "/insert-property/:propertyID",
      upload.fields([{name: "images"}, {name: "documents"}]),
      async (
        req: Request<{propertyID: string}>,
        res: Response,
        next: NextFunction
      ): Promise<any> => {
        try {
          // Get the property ID from the form data
          const propertyID = req.body.id;



          // Define the property files
          const propertyFiles = req.files as
            | {[fieldname: string]: Express.Multer.File[]}
            | undefined;

          // Check if the property files are provided in the form data
          if(!propertyFiles) {
            throw new Error("No property files were uploaded.");
          }

          // Check if the property ID is provided in the form data
          if(!propertyID) {
            throw new Error("Property ID is required in form data.");
          }

          // Define the property documents and images
          const documents = propertyFiles?.documents;
          const propertyImages = propertyFiles?.images;
          // Define the property empty images and document arrays

          const Images: UploadedImage[] = [];
          const Docs: UploadedDocument[] = [];

          // Array to hold promises
          const conversionPromises: Promise<void>[] = [];

          // Check if the property documents are provided
          if(documents) {
            // Loop through each document and create a file URL
            for(const file of documents) {
              // Create the file path for the document
              // const filePath = path.join(
              //   __dirname,
              //   `../../public/propertyUploads/${propertyID}/documents/${file.filename}`
              // );
              // Create the file URL for the document
              const fileURL = `${req.protocol}://${req.get(
                "host"
              )}/propertyUploads/${propertyID}/documents/${file.filename}`;
              // Create the document object and push it to the documents array
              Docs.push({
                originalname: file.originalname.trim(),
                filename: file.filename.trim(),
                mimetype: file.mimetype.trim(),
                size: file.size,
                documentURL: fileURL.trim(),
              });
            }
          } else {
            //Throw new error No property documents were uploaded
            throw new Error("No property documents were uploaded.");
          }

          // Check if the property images are provided
          if(propertyImages) {
            const convertDir = path.join(
              __dirname,
              `../../public/propertyUploads/${propertyID}/images/`
            );

            fs.mkdirSync(convertDir, {recursive: true});
            // Loop through each image and create a file URL
            for(const file of propertyImages) {
              // Create the file path for the image
              const ext = path.extname(file.filename);
              const baseName = path.basename(file.filename, ext);

              const convertedImagePath = path.join(
                __dirname,
                `../../public/propertyUploads/${propertyID}/images/${baseName}.webp`
              );
              const originalImagePath = file.path;

              // Create the file URL for the image
              const fileURL = `${req.protocol}://${req.get(
                "host"
              )}/propertyUploads/${propertyID}/images/${baseName}.webp`;

              /*
              All image conversions using sharp finish properly before deleting the temp folder,

              Avoid the EBUSY error caused by open file handles,

              Ensure correct .webp file naming and referencing,

              Should move all conversion tasks into an array of Promises and await them using Promise.all(...) before proceeding to deletion.
                          
              */

              // Push the conversion promise into the array and Reshape the image to a specific size
              const conversionPromise = sharp(originalImagePath)
                .webp({quality: 100})
                .resize(800, 600, {
                  fit: "inside",
                  withoutEnlargement: true,
                })
                .toFile(convertedImagePath)
                .then(() => {
                  // console.log("WebP Image saved to:", convertedImagePath);
                })
                .catch((error) => {
                  // console.error("Error converting image to WebP:", error);
                });

              // Create the image object and push it to the images array
              Images.push({
                originalname: file.originalname.trim(),
                filename: `${baseName}.webp`,
                mimetype: "image/webp",
                size: file.size,
                imageURL: fileURL.trim(),
              });

              conversionPromises.push(conversionPromise);
            }
          } else {
            //Throw new error No property images were uploaded
            throw new Error("No property images were uploaded.");
          }

          // Get the property details from the request body

          //<============================= Oganizing the data to insert into the DB =============================>

          const DbData = {
            // Basic Property Details
            id: propertyID.trim(),
            title: req.body.title.trim(),
            type: req.body.type.trim().toLowerCase(),
            listing: req.body.listing.trim().toLowerCase(),
            description: req.body.description.trim(),
            // Basic Property Details

            // Location Details
            countryDetails: JSON.parse(req.body.countryDetails.trim()),
            address: JSON.parse(req.body.address.trim()),
            location:
              typeof req.body.location === "string"
                ? JSON.parse(req.body.location.trim())
                : {},
            // End Location Details

            // Property Specifications
            totalArea: Number(req.body.totalArea.trim()),
            builtInArea: Number(req.body.builtInArea.trim()),
            livingRooms: Number(req.body.livingRooms.trim()),
            balconies: Number(req.body.balconies.trim()),
            kitchen: Number(req.body.kitchen.trim()),
            bedrooms: Number(req.body.bedrooms.trim()),
            bathrooms: Number(req.body.bathrooms.trim()),
            maidrooms: Number(req.body.maidrooms.trim()),
            driverRooms: Number(req.body.driverRooms.trim()),
            furnishingStatus: req.body.furnishingStatus.trim(),
            totalFloors: Number(req.body.totalFloors.trim()),
            numberOfParking: Number(req.body.numberOfParking.trim()),
            // End Property Specifications

            // Construction & Age
            builtYear: Number(req.body.builtYear.trim()),
            propertyCondition: req.body.propertyCondition.trim().toLowerCase(),
            developerName: req.body.developerName.trim(),
            projectName:
              typeof req.body.projectName === "string"
                ? req.body.projectName.trim()
                : "",
            ownerShipType: req.body.ownerShipType.trim().toLowerCase(),
            // End Construction & Age

            // Financial Details
            price: Number(req.body.price.trim()),
            currency: req.body.currency.trim(),
            pricePerSqurFeet: Number(req.body.pricePerSqurFeet.trim()),
            expectedRentYearly:
              typeof req.body.expectedRentYearly === "string"
                ? Number(req.body.expectedRentYearly.trim())
                : 0,
            expectedRentQuartely:
              typeof req.body.expectedRentQuartely === "string"
                ? Number(req.body.expectedRentQuartely.trim())
                : 0,
            expectedRentMonthly:
              typeof req.body.expectedRentMonthly === "string"
                ? Number(req.body.expectedRentMonthly.trim())
                : 0,
            expectedRentDaily:
              typeof req.body.expectedRentDaily === "string"
                ? Number(req.body.expectedRentDaily.trim())
                : 0,
            maintenanceFees: Number(req.body.maintenanceFees.trim()),
            serviceCharges: Number(req.body.serviceCharges.trim()),
            transferFees:
              typeof req.body.transferFees === "string"
                ? Number(req.body.transferFees.trim())
                : 0,
            availabilityStatus: req.body.availabilityStatus
              .trim()
              .toLowerCase(),
            // End Financial Details

            // Features & Amenities
            featuresAndAmenities: JSON.parse(req.body.featuresAndAmenities),
            // End Features & Amenities

            // Media
            images: Images,
            documents: Docs,
            videoTour:
              typeof req.body.videoTour === "string"
                ? req.body.videoTour.trim()
                : "",
            virtualTour:
              typeof req.body.virtualTour === "string"
                ? req.body.virtualTour.trim()
                : "",
            // End Media

            // Listing Management
            listingDate: new Date(req.body.listingDate.trim()).toISOString(),
            availabilityDate:
              typeof req.body.availabilityDate === "string"
                ? new Date(req.body.availabilityDate.trim()).toISOString()
                : null,
            listingExpiryDate:
              typeof req.body.listingExpiryDate === "string"
                ? new Date(req.body.listingExpiryDate.trim()).toISOString()
                : null,
            rentedDate:
              typeof req.body.rentedDate === "string" &&
                req.body.rentedDate !== ""
                ? new Date(req.body.rentedDate.trim()).toISOString()
                : null,
            soldDate:
              typeof req.body.soldDate === "string" && req.body.soldDate !== ""
                ? new Date(req.body.soldDate.trim()).toISOString()
                : null,
            addedBy: JSON.parse(req.body.addedBy.trim()),
            owner: req.body.owner.trim(),
            // End Listing Management

            // Administrative & Internal Use
            referenceCode: req.body.referenceCode.trim(),
            verificationStatus: req.body.verificationStatus
              .trim()
              .toLowerCase(),
            priority: req.body.priority.trim().toLowerCase(),
            status: req.body.status.trim().toLowerCase(),
            internalNote: req.body.internalNote.trim(),
            // End Administrative & Internal Use
          };

          const insertToTheDB = new PropertyModel(DbData);
          const insertedProperty = await insertToTheDB.save();



          // Check if the property was inserted successfully

          if(insertedProperty) {
            // Notify all admins about the new property added
            const notificationService = new NotificationService();
            // Get the io instance from the app
            const io = req.app.get('io');
            await notificationService.createNotification(
              {
                title: 'New Property',
                body: `A new property titled "${insertedProperty.title}" has been added. Please review and verify the listing.`,
                type: 'create',          // OK (your entity allows custom strings)
                severity: 'info',
                audience: {mode: 'role', roles: ['admin', 'agent', 'manager', 'operator']}, // target all admins  
                channels: ['inapp', 'email'], // keep if you'll email later; harmless otherwise
                metadata: {newPropertyData: DbData},
                // DO NOT send createdAt here; NotificationService sets it  
              },
              // Real-time emit callback: send to each audience room


              (rooms, payload) => {
                rooms.forEach((room) => {
                  io.to(room).emit('notification.new', payload);
                });
              }
            );



            // Send susscess message
            res.status(200).json({
              status: "success",
              message: "Property inserted successfully",
              data: insertedProperty,
            });

            // Wait until all the promise is resolved
            await Promise.all(conversionPromises);

            await this.deleteFolderWithRetry(
              path.join(
                __dirname,
                `../../public/propertyUploads/${propertyID}/tempImages/`
              )
            );
          } else {
            throw new Error("Property insertion failed.");
          }
        } catch(error) {
          // Handle any errors that occur during the file upload or property insertion
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
  //<==================== END OF INSERT PROPERTY ====================>

  //<==================== DRLETE PROPERTY TEMP IMAGES FOLDER ====================>
  private async deleteFolderWithRetry(
    folderPath: string,
    retries: number = 5,
    delayMs: number = 500
  ): Promise<void> {
    for(let attempt = 1; attempt <= retries; attempt++) {
      try {
        await fs.promises.rm(folderPath, {recursive: true, force: true});
        console.log(`Deleted folder on attempt ${attempt}: ${folderPath}`);
        return;
      } catch(err: any) {
        if(err.code === "EBUSY" || err.code === "EPERM") {
          console.warn(
            `Attempt ${attempt} failed to delete folder. Retrying in ${delayMs}ms...`
          );
          await new Promise((res) => setTimeout(res, delayMs));
        } else {
          throw err; // Unexpected error, rethrow
        }
      }
    }

    throw new Error(
      `Failed to delete folder after ${retries} attempts: ${folderPath}`
    );
  }

  //<==================== END DRLETE PROPERTY TEMP IMAGES FOLDER ====================>

  //<==================== GET ALL PROPERTIES WITH THE PAGINATION ====================>
  private getAllPropertiesWithPagination(): void {
    this.router.get(
      "/get-all-properties-with-pagination/:start/:end/",
      async (
        req: Request<{
          start: string;
          end: string;
        }>,
        res: Response
      ) => {
        try {
          const {start, end} = req.params;
          const safeStart = Math.max(0, parseInt(start, 10));
          const safeEnd = Math.max(1, parseInt(end, 10));
          const priorityOrder = {high: 1, medium: 2, low: 3};

          const search = req.query.search as string | "";
          const filter = req.query.filter as string | "";

          const safeSearch =
            typeof search === "string" && search.trim() !== ""
              ? search.trim()
              : "";
          const safeFilter =
            typeof filter === "string" && filter.trim() !== ""
              ? filter.trim()
              : "";

          if(isNaN(safeStart) || isNaN(safeEnd)) {
            throw new Error("Invalid start or end parameters.");
          }

          const filterDialogData: filterDialogData = safeFilter
            ? JSON.parse(safeFilter)
            : {
              minPrice: 0,
              maxPrice: Number.MAX_SAFE_INTEGER,
              beds: "",
              bathrooms: "",
              amenities: [],
              type: "",
              status: "",
            };

          const andFilters: any[] = [];

          // Keyword-based search across multiple fields
          if(safeSearch) {
            const searchRegex = new RegExp(safeSearch, "i");
            andFilters.push({
              $or: [
                {title: {$regex: searchRegex}},
                {type: {$regex: searchRegex}},
                {status: {$regex: searchRegex}},
                {"address.country": {$regex: searchRegex}},
              ],
            });
          }

          // Apply filters if available
          if(filterDialogData) {
            andFilters.push({
              price: {
                $gte: filterDialogData.minPrice,
                $lte: filterDialogData.maxPrice,
              },
            });

            if(filterDialogData.beds === "10+") {
              andFilters.push({bedrooms: {$gte: 10}});
            } else if(filterDialogData.beds) {
              andFilters.push({
                bedrooms: parseInt(filterDialogData.beds, 10),
              });
            }

            if(filterDialogData.bathrooms === "10+") {
              andFilters.push({bathrooms: {$gte: 10}});
            } else if(filterDialogData.bathrooms) {
              andFilters.push({
                bathrooms: parseInt(filterDialogData.bathrooms, 10),
              });
            }

            if(filterDialogData.type) {
              andFilters.push({type: filterDialogData.type});
            }

            if(filterDialogData.status) {
              andFilters.push({status: filterDialogData.status});
            }

            if(
              filterDialogData.amenities &&
              filterDialogData.amenities.length > 0
            ) {
              andFilters.push({
                featuresAndAmenities: {$all: filterDialogData.amenities},
              });
            }
          }

          const filterQuery = andFilters.length > 0 ? {$and: andFilters} : {};

          // const properties = await PropertyModel.find(filterQuery)
          //   .skip(safeStart)
          //   .limit(safeEnd - safeStart)
          //   .sort({ createdAt: -1 });

          const properties = await PropertyModel.aggregate([
            {$match: filterQuery},
            {
              $addFields: {
                priorityOrder: {
                  $switch: {
                    branches: [
                      {case: {$eq: ["$priority", "high"]}, then: 1},
                      {case: {$eq: ["$priority", "medium"]}, then: 2},
                      {case: {$eq: ["$priority", "low"]}, then: 3},
                    ],
                    default: 4,
                  },
                },
              },
            },
            {$sort: {priorityOrder: 1, updatedAt: -1}},
            {$skip: safeStart},
            {$limit: safeEnd - safeStart},
          ]);

          const totalCount = await PropertyModel.countDocuments(filterQuery);

          const resData = {
            properties: properties,
            count: totalCount,
          };

          res.status(200).json({
            status: "success",
            message: "Properties fetched successfully.",
            data: resData,
          });
        } catch(error) {
          console.error("Error occurred while fetching properties: ", error);
          res.status(500).json({
            status: "error",
            message: "Error occurred while fetching properties: " + error,
          });
        }
      }
    );
  }
  //<==================== END GET ALL PROPERTIES WITH THE PAGINATION ====================>

  //<==================== GET SINGLE PROPERTY BY ID ====================>
  private getSinglePropertyById(): void {
    this.router.get(
      "/get-single-property-by-id/:id",
      async (req: Request<{id: string}>, res: Response) => {
        try {
          const {id} = req.params;
          const safeID = id.trim();

          if(!safeID) {
            throw new Error("Property ID is required.");
          }

          const property = await PropertyModel.findOne({id: safeID});
          if(!property) {
            throw new Error("Property not found.");
          }
          res.status(200).json({
            status: "success",
            message: "Property fetched successfully.",
            data: property,
          });
        } catch(error) {
          console.error("Error occurred while fetching properties: ", error);
          res.status(500).json({
            status: "error",
            message: "Error occurred while fetching properties: " + error,
          });
        }
      }
    );
  }
  //<==================== END GET SINGLE PROPERTY BY ID ====================>

  //<==================== DELETE THE PROPERTY BY PROPERTY ID ====================>
  /**
   * DELETE /delete-property/:id
   *
   * - Validates the UUID in the path.
   * - Loads the record by persisted string `id` (UUID) — your sample shows this field exists.
   * - Moves files from /public/propertyUploads/:id to /public/recyclebin/properties/:id (or :id_TIMESTAMP if taken).
   * - Writes a JSON snapshot of the deleted doc into the recycle bin folder.
   * - Deletes the record from Mongo.
   * - Optionally notifies admins via Socket.IO; notification failures do NOT break the delete.
   */
  private deleteProperty(): void {
    this.router.delete(
      '/delete-property/:id/:username',
      async (req: Request<{id: string; username: string}>, res: Response): Promise<any> => {
        try {
          // 1) Safe params
          const safeID = (req.params.id ?? '').trim();
          const urlUsername = (req.params.username ?? '').trim();

          if(!safeID) {
            return res.status(400).json({status: 'error', message: 'Property ID is required.'});
          }

          // Prefer authenticated user if available; fall back to URL param
          const actorUsername =
            // @ts-ignore - if you've augmented Express.Request with user
            (req.user?.username as string | undefined)?.trim() || urlUsername;

          if(!actorUsername) {
            return res.status(400).json({status: 'error', message: 'Username is required.'});
          }

          // 2) Lookup property
          const property = await PropertyModel.findOne({id: safeID}).lean();
          if(!property) {
            return res.status(404).json({status: 'error', message: 'Property not found.'});
          }

          // 3) Paths
          const root = process.cwd();
          const uploadsRoot = path.join(root, 'public', 'propertyUploads');
          const recycleRoot = path.join(root, 'public', 'recyclebin', 'properties');

          const srcDir = path.join(uploadsRoot, safeID);
          let dstDir = path.join(recycleRoot, safeID);

          await fsp.mkdir(recycleRoot, {recursive: true});

          // 4) Existence checks
          const srcExists = await fsp.stat(srcDir).then(() => true).catch(() => false);
          const dstExists = await fsp.stat(dstDir).then(() => true).catch(() => false);
          if(dstExists) dstDir = path.join(recycleRoot, `${safeID}_${Date.now()}`);

          // 5) Move (rename or cp+rm fallback)
          if(srcExists) {
            try {
              await fsp.rename(srcDir, dstDir);
            } catch(e: any) {
              if(e?.code === 'EXDEV') {
                await fsp.mkdir(dstDir, {recursive: true});
                // Node 16.7+; if older, replace with a manual directory copy
                // @ts-ignore
                await fsp.cp(srcDir, dstDir, {recursive: true});
                await fsp.rm(srcDir, {recursive: true, force: true});
              } else {
                throw e;
              }
            }
          } else {
            await fsp.mkdir(dstDir, {recursive: true});
          }

          // 6) Snapshot the document in recycle bin
          await fsp.writeFile(
            path.join(dstDir, 'property.json'),
            JSON.stringify(property, null, 2),
            'utf-8'
          );

          // 7) Notify (best-effort, non-blocking)
          try {
            const io = req.app.get('io');
            if(io) {
              const notificationService = new NotificationService();

              // Safely pick the target user from the document if present
              const targetUser =
                (property as any)?.addedBy?.username ||
                (property as any)?.addedBy ||
                actorUsername;

              await notificationService.createNotification(
                {
                  title: 'Delete Property',
                  body: `Property with ID ${safeID} has been deleted.`,
                  type: 'delete',
                  severity: 'warning',
                  // Include BOTH: the owner (addedBy) and admin roles
                  audience: {
                    mode: 'user', // will still work if you implement "include all provided rooms" logic
                    usernames: [String(targetUser)],
                    roles: ['admin', 'agent', 'manager', 'operator'],
                  },
                  channels: ['inapp', 'email'],
                  metadata: {
                    deletedBy: actorUsername,
                    deletedAt: new Date().toISOString(),
                    propertyId: safeID,
                    propertyTitle: (property as any)?.title,
                    recyclePath: dstDir,
                  },
                },
                (rooms, payload) => {
                  rooms.forEach((room) => io.to(room).emit('notification.new', payload));
                }
              );
            } else {
              console.warn('[delete-property] io is undefined; skipping notifications');
            }
          } catch(notifyErr) {
            console.warn('[delete-property] notification failed:', notifyErr);
          }

          // 8) Delete DB record
          const del = await PropertyModel.deleteOne({id: safeID});
          if(del.deletedCount !== 1) {
            return res
              .status(409)
              .json({status: 'error', message: 'Delete conflict: document not removed.'});
          }

          // 9) Done — return OK with a message (200 is better than 204 if you want a body)
          return res.status(200).json({
            status: 'success',
            message: 'Property deleted.',
            data: null,
          });
        } catch(error: any) {
          console.error('[delete-property] error:', error);
          return res
            .status(500)
            .json({status: 'error', message: 'Error occurred while deleting property.'});
        }
      }
    );
  }


  //<==================== END DELETE THE PROPERTY BY PROPERTY ID ====================>

  //<==================== UPDATE THE PROPERTY BY PROPERTY ID =====================>
  private updateProperty(): void {
    // Define allowed document types
    // You can add more types as per your requirements
    const allowedDocumentTypes = [
      // Word Documents
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/rtf",

      // Excel Documents
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "text/csv",
      "text/tab-separated-values",

      // PowerPoint Documents
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.template",

      // OpenDocument Formats
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",

      // PDF
      "application/pdf",

      // Plain Text
      "text/plain",
    ];

    // Define allowed images types
    // You can add more types as per your requirements
    const allowedImageTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/bmp",
      "image/tiff",
      "image/webp",
      "image/svg+xml",
    ];

    const storage = multer.diskStorage({
      // Define the destination for the uploaded files
      // The destination is determined based on the field name
      destination: (req, file, cb) => {
        // Check if the property ID is provided in the form data
        // This is used to create a unique folder for each property
        const propertyID = req.params.id;

        // If property ID is not provided, return an error
        // This is important to ensure that files are saved in the correct location
        if(!propertyID) {
          // If property ID is not provided, return an error
          // This is important to ensure that files are saved in the correct location
          return cb(new Error("Property ID is required in form data."), "");
        }

        // Define the upload path based on the field name
        // This will create a unique folder for each property
        let uploadPath = "";
        // Check the field name to determine the upload path
        // If the field name is "images", save to the images folder
        if(file.fieldname === "images") {
          // Create the upload path for images
          // This will create a unique folder for each property
          uploadPath = path.join(
            __dirname,
            `../../public/propertyUploads/${propertyID}/tempImages/`
          );
          // If the field name is "documents", save to the documents folder
          // This will create a unique folder for each property
        } else if(file.fieldname === "documents") {
          // Create the upload path for documents
          // This will create a unique folder for each property
          uploadPath = path.join(
            __dirname,
            `../../public/propertyUploads/${propertyID}/documents/`
          );
          // If the field name is not recognized, return an error
          // This is important to ensure that files are saved in the correct location
        } else {
          // If the field name is not recognized, return an error
          // This is important to ensure that files are saved in the correct location
          return cb(new Error("Unexpected field: " + file.fieldname), "");
        }
        // Create the upload path if it doesn't exist
        // This is important to ensure that files are saved in the correct location
        fs.mkdirSync(uploadPath, {recursive: true});
        // Return the upload path to multer
        // This is important to ensure that files are saved in the correct location
        cb(null, uploadPath);
      },
      // Define the filename for the uploaded files
      // This will create a unique filename for each file
      filename: (req, file, cb) => {
        // Create a unique filename using the current timestamp and a random number
        // This is important to ensure that files are saved in the correct location
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        // Replace spaces in the original filename with underscores
        // This is important to ensure that files are saved in the correct location
        const sanitized = file.originalname.replace(/\s+/g, "_");
        // Create the final filename using the unique suffix and the sanitized original filename
        // This is important to ensure that files are saved in the correct location
        cb(null, `${uniqueSuffix}-${sanitized}`);
      },
    });

    // Define the file filter for multer
    // This will check the file type and size before uploading
    const fileFilter = (req: Request, file: Express.Multer.File, cb: any) => {
      // Check if the image type is allowed
      // This is important to ensure that files are saved in the correct location
      if(
        file.fieldname === "images" &&
        allowedImageTypes.includes(file.mimetype)
      ) {
        // If the image type is allowed, return true
        // This is important to ensure that files are saved in the correct location
        cb(null, true);
        // Check if the document type is allowed
        // This is important to ensure that files are saved in the correct location
      } else if(
        file.fieldname === "documents" &&
        allowedDocumentTypes.includes(file.mimetype)
      ) {
        // If the document type is allowed, return true
        // This is important to ensure that files are saved in the correct location
        cb(null, true);
      } else {
        // If the file type is not allowed, return an error
        // This is important to ensure that files are saved in the correct location
        cb(new Error("File type not allowed: " + file.mimetype));
      }
    };

    // Create the multer instance with the defined storage and file filter
    // This will check the file type and size before uploading
    const upload = multer({storage, fileFilter});

    // Define the route for inserting a property
    // This will handle the file upload and save the property to the database

    this.router.put(
      "/update-property/:id",
      upload.fields([{name: "images"}, {name: "documents"}]),
      async (req: Request<{id: string}>, res: Response): Promise<any> => {
        try {
          // make the property id more reliable without and empty string
          const propertyID = (req.params?.id || req.body?.id || "").trim();
          // Check the property id
          if(!propertyID)
            throw new Error("Property ID is required in URL or request body.");

          const updator = req.body?.updator.trim()

          if(!updator) throw new Error("The updator must login to the system before update the prroperty!")

          // define the property files to check whether the files are uploaded
          const propertyFiles = req.files as
            | {[fieldname: string]: Express.Multer.File[]}
            | undefined;

          const uploadedImages = propertyFiles?.["images"];
          const uploadedDocuments = propertyFiles?.["documents"];

          // Define the property empty images and document arrays
          const Images: UploadedImage[] = [];
          const Docs: UploadedDocument[] = [];

          // Exsiting images and documents
          const existingImages: UploadedImage[] =
            JSON.parse(req.body.existingImages.trim()) || [];

          if(!Array.isArray(existingImages))
            throw new Error("Invalid existingImages");

          const existingDocuments: UploadedDocument[] =
            JSON.parse(req.body.existingDocuments.trim()) || [];

          if(!Array.isArray(existingDocuments))
            throw new Error("Invalid existingDocuments");

          // Push existing images and documents to the Images and Docs array
          Images.push(...existingImages);
          Docs.push(...existingDocuments);

          // Remove Images
          const removeImages: UploadedImage[] = this.safeJSONPass(
            req.body.removeImages.trim(),
            []
          );

          // Check if the removeImages is an array
          if(removeImages && removeImages.length > 0) {
            for(let i = 0; i < removeImages.length; i++) {

              try {
                // Define the image
                const image = removeImages[i];

                if(!image) throw new Error("Invalid image" + image);

                // Define the image path
                const removeImagePath = path.join(
                  __dirname,
                  `../../public/propertyUploads/${propertyID}/images/${image.filename}`
                );

                // Define the recycle bin path for the image
                const recyclebinForImages = path.join(
                  __dirname,
                  `../../public/recyclebin/properties/${propertyID}/removeredImages/`
                );

                await this.moveToTheRecycleBin(
                  recyclebinForImages,
                  removeImagePath
                );
              }
              catch(error) {
                console.log("Error: ", error)
              }




            }
          }

          // Remove Documents
          const removeDocuments: UploadedDocument[] = this.safeJSONPass(
            req.body.removeDocuments.trim(),
            []
          );

          // Check if the removeDocuments is an array
          if(removeDocuments && removeDocuments.length > 0) {
            // Loop through the removeDocuments array
            for(let i = 0; i < removeDocuments.length; i++) {
              try {
                //Define the document
                const document = removeDocuments[i];

                if(!document) throw new Error("Invalid document" + document);

                // Define the document path
                const removeDocumentPath = path.join(
                  __dirname,
                  `../../public/propertyUploads/${propertyID}/documents/${document.filename}`
                );

                // Define the recyclebin for documents
                const recyclebinForDocuments = path.join(
                  __dirname,
                  `../../public/recyclebin/properties/${propertyID}/removeredDocuments/`
                );

                await this.moveToTheRecycleBin(
                  recyclebinForDocuments,
                  removeDocumentPath
                );
              }
              catch(error) {
                console.log("Error: ", error)
              }


            }
          }

          // Array to hold promises
          const conversionPromises: Promise<void>[] = [];

          // Check if the property new images are provided
          if(uploadedImages && uploadedImages.length > 0) {
            const convertDir = path.join(
              __dirname,
              `../../public/propertyUploads/${propertyID}/images/`
            );

            // Make the directory for image uploads
            fs.mkdirSync(convertDir, {recursive: true});

            // Loop through each image and create a file URL
            for(const file of uploadedImages) {
              // Create the file path for the image
              const ext = path.extname(file.filename);
              const baseName = path.basename(file.filename, ext);

              const convertedImagePath = path.join(
                __dirname,
                `../../public/propertyUploads/${propertyID}/images/${baseName}.webp`
              );
              const originalImagePath = file.path;

              // Create the file URL for the image
              const fileURL = `${req.protocol}://${req.get(
                "host"
              )}/propertyUploads/${propertyID}/images/${baseName}.webp`;

              /*
              All image conversions using sharp finish properly before deleting the temp folder,
  
              Avoid the EBUSY error caused by open file handles,
  
              Ensure correct .webp file naming and referencing,
  
              Should move all conversion tasks into an array of Promises and await them using Promise.all(...) before proceeding to deletion.
                          
              */

              // Push the conversion promise into the array and Reshape the image to a specific size
              const conversionPromise = sharp(originalImagePath)
                .webp({quality: 100})
                .resize(800, 600, {
                  fit: "inside",
                  withoutEnlargement: true,
                })
                .toFile(convertedImagePath)
                .then(() => {
                  // console.log("WebP Image saved to:", convertedImagePath);
                })
                .catch((error) => {
                  // console.error("Error converting image to WebP:", error);
                });

              // Create the image object and push it to the images array
              Images.push({
                originalname: file.originalname.trim(),
                filename: `${baseName}.webp`,
                mimetype: "image/webp",
                size: file.size,
                imageURL: fileURL.trim(),
              });

              conversionPromises.push(conversionPromise);
            }
          }

          // Check if the property new documents are provided
          if(uploadedDocuments && uploadedDocuments.length > 0) {
            for(const file of uploadedDocuments) {
              // Create the file URL for the document
              const fileURL = `${req.protocol}://${req.get(
                "host"
              )}/propertyUploads/${propertyID}/documents/${file.filename}`;
              // Create the document object and push it to the documents array
              Docs.push({
                originalname: file.originalname.trim(),
                filename: file.filename.trim(),
                mimetype: file.mimetype.trim(),
                size: file.size,
                documentURL: fileURL.trim(),
              });
            }
          }


          // --- safe helpers ---
          const s = (v: any): string => (typeof v === 'string' ? v.trim() : '');

          const num = (v: any): number => {
            const n = Number(s(v));
            return Number.isFinite(n) ? n : 0;
          };

          const parseJSON = <T>(v: any, fallback: T): T => {
            try {
              if(v == null) return fallback;
              if(typeof v === 'string') {
                const trimmed = v.trim();
                if(!trimmed) return fallback;
                return JSON.parse(trimmed);
              }
              return v as T; // already object/array
            } catch {
              return fallback;
            }
          };

          const dateOrNull = (v: any): Date | null => {
            const str = s(v);
            if(!str) return null;
            const d = new Date(str);
            return isNaN(d.getTime()) ? null : d;
          };

          const dateOrNow = (v: any): Date => {
            const d = dateOrNull(v);
            return d ?? new Date();
          };


          const invalidDateFields: string[] = [];
          for(const key of ['listingDate', 'availabilityDate', 'listingExpiryDate', 'rentedDate', 'soldDate']) {
            const v = (req.body as any)[key];
            if(v && dateOrNull(v) === null) invalidDateFields.push(key);
          }
          if(invalidDateFields.length) {
            return res.status(400).json({
              status: 'error',
              message: `Invalid date(s): ${invalidDateFields.join(', ')}`
            });
          }


          // Organize the data to update the property
          const DbData = {
            // Basic
            id: s(propertyID),
            title: s(req.body.title),
            type: s(req.body.type).toLowerCase(),
            listing: s(req.body.listing).toLowerCase(),
            description: s(req.body.description),

            // Location
            countryDetails: parseJSON(req.body.countryDetails, {}),
            address: parseJSON(req.body.address, {}),
            location: parseJSON(req.body.location, {}),

            // Specs
            totalArea: num(req.body.totalArea),
            builtInArea: num(req.body.builtInArea),
            livingRooms: num(req.body.livingRooms),
            balconies: num(req.body.balconies),
            kitchen: num(req.body.kitchen),
            bedrooms: num(req.body.bedrooms),
            bathrooms: num(req.body.bathrooms),
            maidrooms: num(req.body.maidrooms),
            driverRooms: num(req.body.driverRooms),
            furnishingStatus: s(req.body.furnishingStatus),
            totalFloors: num(req.body.totalFloors),
            numberOfParking: num(req.body.numberOfParking),

            // Age
            builtYear: num(req.body.builtYear),
            propertyCondition: s(req.body.propertyCondition).toLowerCase(),
            developerName: s(req.body.developerName),
            projectName: s(req.body.projectName),
            ownerShipType: s(req.body.ownerShipType).toLowerCase(),

            // Financial
            price: num(req.body.price),
            currency: s(req.body.currency),
            pricePerSqurFeet: num(req.body.pricePerSqurFeet),
            expectedRentYearly: num(req.body.expectedRentYearly),
            expectedRentQuartely: num(req.body.expectedRentQuartely),
            expectedRentMonthly: num(req.body.expectedRentMonthly),
            expectedRentDaily: num(req.body.expectedRentDaily),
            maintenanceFees: num(req.body.maintenanceFees),
            serviceCharges: num(req.body.serviceCharges),
            transferFees: num(req.body.transferFees),
            availabilityStatus: s(req.body.availabilityStatus).toLowerCase(),

            // Features & Amenities
            featuresAndAmenities: parseJSON(req.body.featuresAndAmenities, []),

            // Media
            images: Images,
            documents: Docs,
            videoTour: s(req.body.videoTour),
            virtualTour: s(req.body.virtualTour),

            // Listing dates (store as Date objects; Mongoose will persist correctly)
            listingDate: dateOrNow(req.body.listingDate),
            availabilityDate: dateOrNull(req.body.availabilityDate),
            listingExpiryDate: dateOrNull(req.body.listingExpiryDate),
            rentedDate: dateOrNull(req.body.rentedDate),
            soldDate: dateOrNull(req.body.soldDate),

            addedBy: parseJSON(req.body.addedBy, {}),
            owner: s(req.body.owner),

            // Admin
            referenceCode: s(req.body.referenceCode),
            verificationStatus: s(req.body.verificationStatus).toLowerCase(),
            priority: s(req.body.priority).toLowerCase(),
            status: s(req.body.status).toLowerCase(),
            internalNote: s(req.body.internalNote),
          };


          const updateThePropertyByID = await PropertyModel.findOneAndUpdate(
            {id: propertyID},
            {$set: DbData},
            {new: true}
          );

          if(!updateThePropertyByID) {
            throw new Error(
              "Error occurred while updating property: " + updateThePropertyByID
            );
          } else {
            //Send notification of successful update
            // inside your update handler (after successful update)
            const notificationService = new NotificationService();
            const io = req.app.get('io');
            await notificationService.createNotification(
              {
                title: 'Update Property',
                body: `Property with ID ${propertyID} has been updated.`,
                type: 'update',
                severity: 'info',
                audience: {
                  mode: 'role',
                  roles: ['admin', 'operator'], // <- PK username
                  usernames: [s(req.body.owner)]
                },
                channels: ['inapp', 'email'],
                metadata: {
                  updatedProperty: DbData,
                  updatedAt: new Date().toISOString(),
                  updatedBy: updator || 'system',
                  propertyID: propertyID,
                },
              },
              // Socket.IO v4 can take Room | Room[] here:
              (rooms, payload) => io?.to(rooms).emit('notification.new', payload)
            );

            // Respond with success
            res.status(200).json({
              status: "success",
              message: "Property updated successfully.",
              data: updateThePropertyByID,
            });

            // Wait until all the promise is resolved
            await Promise.all(conversionPromises);

            await this.deleteFolderWithRetry(
              path.join(
                __dirname,
                `../../public/propertyUploads/${propertyID}/tempImages/`
              )
            );
          }
        } catch(error) {
          if(error) {
            console.log(
              "Error while updating property:",
              error instanceof Error ? error.stack : error
            );
            res.status(500).json({
              status: "error",
              message: "Error occurred while updating property: " + error,
            });
          }
        }
      }
    );
  }
  //<==================== END UPDATE THE PROPERTY BY PROPERTY ID ====================>

  //<==================== MOVE THE DELETING FILE TO THE RECYCLE BIN ====================>
  private async moveToTheRecycleBin(
    recycleBinPath: string,
    filePath: string
  ): Promise<void> {
    try {
      // Create the recyclebin folder if it doesn't exist
      if(!fs.existsSync(recycleBinPath)) {
        await fs.promises.mkdir(recycleBinPath, {recursive: true});
      }

      //Rename the file and create the new file in the recyclebin folder
      const targetPath = path.join(
        recycleBinPath,
        `${Date.now()}-${path.basename(filePath)}`
      );

      // Move the document to the recyclebin
      await fs.promises.rename(filePath, targetPath);

      console.log(`Moved file to recycle bin: ${targetPath}`);
    } catch(error) {
      console.log(
        "Error while moving file to recycle bin:",
        error instanceof Error ? error.stack : error
      );
    }
  }
  //<==================== END MOVE THE DELETING FILE TO THE RECYCLE BIN ====================>

  //<==================== SAFE JSON PASS ====================>
  private safeJSONPass<T>(input: string, fallback: T): T {
    try {
      return JSON.parse(input);
    } catch {
      return fallback;
    }
  }
  //<==================== END SAFE JSON PASS ====================>

  //<==================== GET ALL PROPERTIE ====================>
  private getAllProperties(): void {
    this.router.get(
      "/get-all-properties/",
      async (req: Request, res: Response) => {
        try {
          const properties = await PropertyModel.find().sort({
            createdAt: -1,
          });
          if(!properties) throw new Error("No properties found.");
          res.status(200).json({
            status: "success",
            message: "Properties fetched successfully.",
            data: properties,
          });
        } catch(error) {
          if(error instanceof Error) {
            res.status(500).json({
              status: "error",
              message: "Error: " + error.message,
            });
          } else {
            res.status(500).json({
              status: "error",
              message: "Error: " + error,
            });
          }
        }
      }
    );
  }
  //<==================== END GET ALL PROPERTIE ====================>
}
