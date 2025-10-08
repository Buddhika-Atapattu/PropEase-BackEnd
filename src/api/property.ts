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
import {NotificationService} from '../services/notification.service';



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

          // Get the io instance from the app
          const io = req.app.get('io');

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
            const admins = await UserModel.find({role: {$regex: /^admin$/i}}, {_id: 1}).lean() as unknown as Array<{_id: import("mongoose").Types.ObjectId}>;
            const adminIds = admins.map(admin => admin._id);
            await NotificationService.createAndSend(io, {
              type: 'Property',
              title: 'New Property Added',
              body: `A new property titled "${DbData.title}" has been added.`,
              meta: {propertyId: insertedProperty.id, addedBy: DbData.addedBy},
              recipients: adminIds,
              roles: ['admin']
            });
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
  private deleteProperty(): void {
    this.router.delete(
      "/delete-property/:id",
      async (req: Request<{id: string}>, res: Response) => {
        try {
          const {id} = req.params;
          const safeID = id.trim();
          const io = req.app.get('io');

          if(!safeID) throw new Error("Property ID is required.");

          const property = await PropertyModel.findOne({id: safeID});

          if(!property) throw new Error("Property not found.");

          const fileFolderPath = path.join(
            __dirname,
            `../../public/propertyUploads/${safeID}`
          );

          const recyclebin = path.join(
            __dirname,
            `../../public/recyclebin/properties/${safeID}/`
          );

          // Create recycle bin folder
          await fs.promises.mkdir(recyclebin, {recursive: true});

          // Move files to recycle bin
          await fs.promises.rename(fileFolderPath, recyclebin);

          // Save property data
          fs.writeFileSync(
            path.join(recyclebin, "property.json"),
            JSON.stringify(
              property.toObject ? property.toObject() : property,
              null,
              2
            ),
            "utf-8"
          );

          // Just in case some files still remain (e.g. if rename didn't remove source fully)
          if(fs.existsSync(fileFolderPath)) {
            await fs.promises.rm(fileFolderPath, {
              recursive: true,
              force: true,
            });
          }

          // Notify all admins about the new property added
          const admins = await UserModel.find({role: {$regex: /^admin$/i}}, {_id: 1}).lean() as unknown as Array<{_id: import("mongoose").Types.ObjectId}>;
          const adminIds = admins.map(admin => admin._id);
          await NotificationService.createAndSend(io, {
            type: 'Property',
            title: 'Property Deleted',
            body: `Deleted property titled"${property.title}".`,
            meta: {propertyId: property.id, addedBy: property.addedBy},
            recipients: adminIds,
            roles: ['admin']
          });

          // Delete property from DB
          const deleteProperty = await PropertyModel.findOneAndDelete({
            id: safeID,
          });

          if(!deleteProperty)
            throw new Error(
              "Error occurred while deleting property: " + deleteProperty
            );

          // Send success response
          // Also consider sending deleted property data if needed notifications etc.

          res.status(200).json({
            status: "success",
            message: "Property deleted successfully.",
          });
        } catch(error) {
          if(error) {
            res.status(500).json({
              status: "error",
              message: "Error occurred while deleting property: " + error,
            });
          }
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
      async (req: Request<{id: string}>, res: Response) => {
        try {
          // make the property id more reliable without and empty string
          const propertyID = (req.params?.id || req.body?.id || "").trim();
          // Check the property id
          if(!propertyID)
            throw new Error("Property ID is required in URL or request body.");

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
              // Define the image
              const image = removeImages[i];

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
              //Define the document
              const document = removeDocuments[i];

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

          // Organize the data to update the property
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
              req.body.rentedDate && typeof req.body.rentedDate === "string"
                ? new Date(req.body.rentedDate.trim()).toISOString()
                : null,
            soldDate:
              req.body.soldDate && typeof req.body.soldDate === "string"
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
