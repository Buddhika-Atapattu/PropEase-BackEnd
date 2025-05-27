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
import { UserDocument } from "../models/file-upload.model";
import { UserModel } from "../models/user.model";
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
import { error } from "console";

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

export default class Property {
  // Define the router for the property API
  // This will handle the routing for the property API
  private router: express.Router;
  // This is the constructor for the Property class
  // It initializes the router and sets up the routes
  constructor() {
    this.router = express.Router();
    this.insertProperty();
    this.test();
    this.getAllPropertiesWithPagination();
    this.getSinglePropertyById();
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
        if (!propertyID) {
          // If property ID is not provided, return an error
          // This is important to ensure that files are saved in the correct location
          return cb(new Error("Property ID is required in form data."), "");
        }

        // Define the upload path based on the field name
        // This will create a unique folder for each property
        let uploadPath = "";
        // Check the field name to determine the upload path
        // If the field name is "images", save to the images folder
        if (file.fieldname === "images") {
          // Create the upload path for images
          // This will create a unique folder for each property
          uploadPath = path.join(
            __dirname,
            `../../public/propertyUploads/${propertyID}/images/`
          );
          // If the field name is "propertyDocs", save to the documents folder
          // This will create a unique folder for each property
        } else if (file.fieldname === "propertyDocs") {
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
        fs.mkdirSync(uploadPath, { recursive: true });
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
      if (
        file.fieldname === "images" &&
        allowedImageTypes.includes(file.mimetype)
      ) {
        // If the image type is allowed, return true
        // This is important to ensure that files are saved in the correct location
        cb(null, true);
        // Check if the document type is allowed
        // This is important to ensure that files are saved in the correct location
      } else if (
        file.fieldname === "propertyDocs" &&
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
    const upload = multer({ storage, fileFilter });

    // Define the route for inserting a property
    // This will handle the file upload and save the property to the database
    this.router.post(
      "/insert-property/:propertyID",
      upload.fields([{ name: "images" }, { name: "propertyDocs" }]),
      async (
        req: Request<{ propertyID: string }>,
        res: Response,
        next: NextFunction
      ): Promise<any> => {
        try {
          // Get the property ID from the form data
          const propertyID = req.body.id;

          // Define the property files
          const propertyFiles = req.files as
            | { [fieldname: string]: Express.Multer.File[] }
            | undefined;

          // Check if the property files are provided in the form data
          if (!propertyFiles) {
            throw new Error("No property files were uploaded.");
          }

          // Check if the property ID is provided in the form data
          if (!propertyID) {
            throw new Error("Property ID is required in form data.");
          }

          // Define the property documents and images
          const propertyDocs = propertyFiles?.propertyDocs;
          const propertyImages = propertyFiles?.images;
          // Define the property empty images and document arrays
          const Images = [];
          const Docs = [];
          // Check if the property documents are provided
          if (propertyDocs) {
            // Loop through each document and create a file URL
            for (const file of propertyDocs) {
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
                originalname: file.originalname,
                filename: file.filename,
                mimetype: file.mimetype,
                size: file.size,
                documentURL: fileURL,
              });
            }
          } else {
            //Throw new error No property documents were uploaded
            throw new Error("No property documents were uploaded.");
          }

          // Check if the property images are provided
          if (propertyImages) {
            const convertDir = path.join(
              __dirname,
              `../../public/propertyUploads/${propertyID}/ConvertImages/`
            );

            fs.mkdirSync(convertDir, { recursive: true });
            // Loop through each image and create a file URL
            for (const file of propertyImages) {
              // Create the file path for the image
              const convertedImagePath = path.join(
                __dirname,
                `../../public/propertyUploads/${propertyID}/ConvertImages/${file.filename}`
              );

              const originalImagePath = file.path;

              // Create the file URL for the image
              const fileURL = `${req.protocol}://${req.get(
                "host"
              )}/propertyUploads/${propertyID}/ConvertImages/${file.filename}`;

              try {
                // Check if the image type is webp
                if (file.mimetype !== "image/webp") {
                  // Convert the image to webp format
                  await sharp(originalImagePath)
                    .webp({ quality: 80 })
                    .resize(800, 600, {
                      fit: "inside",
                      withoutEnlargement: true,
                    })
                    .toFile(convertedImagePath);

                  await new Promise((res) => setTimeout(res, 50));
                  await fs.promises.unlink(originalImagePath);
                } else {
                  await sharp(originalImagePath)
                    .resize(800, 600, {
                      fit: "inside",
                      withoutEnlargement: true,
                    })
                    .toFile(convertedImagePath);

                  await new Promise((res) => setTimeout(res, 50));
                  await fs.promises.unlink(originalImagePath);
                }
              } catch (error) {
                console.error("Error occurred while processing image: ", error);
              }

              // Reshape the image to a specific size

              // Create the image object and push it to the images array
              Images.push({
                originalname: file.originalname,
                filename: file.filename,
                mimetype: file.mimetype,
                size: file.size,
                imageURL: fileURL,
              });
            }
          } else {
            //Throw new error No property images were uploaded
            throw new Error("No property images were uploaded.");
          }

          // Get the property details from the request body

          //<======================================================================================================================>

          const DbData = {
            id: propertyID,
            title: req.body.title,
            description: req.body.description,
            type: req.body.type,
            status: req.body.status,
            price: req.body.price,
            currency: req.body.currency,
            bedrooms: req.body.bedrooms,
            bathrooms: req.body.bathrooms,
            maidrooms: req.body.maidrooms,
            area: req.body.area,
            images: Images,
            address: JSON.parse(req.body.address),
            countryDetails: JSON.parse(req.body.countryDetails),
            featuresAndAmenities: JSON.parse(req.body.featuresAndAmenities),
            addedBy: JSON.parse(req.body.addedBy),
            location: JSON.parse(req.body.location),
            propertyDocs: Docs,
          };

          const insertToTheDB = new PropertyModel(DbData);
          const insertedProperty = await insertToTheDB.save();

          if (insertedProperty) {
            console.log("Inserted Property: ", insertedProperty);
            res.status(200).json({
              status: "success",
              message: "Property inserted successfully",
              data: insertedProperty,
            });
          } else {
            throw new Error("Property insertion failed.");
          }
        } catch (error) {
          // Handle any errors that occur during the file upload or property insertion
          if (error) {
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
          const { start, end } = req.params;
          const safeStart = Math.max(0, parseInt(start, 10));
          const safeEnd = Math.max(1, parseInt(end, 10));

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

          if (isNaN(safeStart) || isNaN(safeEnd)) {
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

          console.log(filterDialogData);
          // Keyword-based search across multiple fields
          if (safeSearch) {
            const searchRegex = new RegExp(safeSearch, "i");
            andFilters.push({
              $or: [
                { title: { $regex: searchRegex } },
                { type: { $regex: searchRegex } },
                { status: { $regex: searchRegex } },
                { "address.country": { $regex: searchRegex } },
              ],
            });
          }

          // Apply filters if available
          if (filterDialogData) {
            andFilters.push({
              price: {
                $gte: filterDialogData.minPrice,
                $lte: filterDialogData.maxPrice,
              },
            });

            if (filterDialogData.beds === "10+") {
              andFilters.push({ bedrooms: { $gte: 10 } });
            } else if (filterDialogData.beds) {
              andFilters.push({
                bedrooms: parseInt(filterDialogData.beds, 10),
              });
            }

            if (filterDialogData.bathrooms === "10+") {
              andFilters.push({ bathrooms: { $gte: 10 } });
            } else if (filterDialogData.bathrooms) {
              andFilters.push({
                bathrooms: parseInt(filterDialogData.bathrooms, 10),
              });
            }

            if (filterDialogData.type) {
              andFilters.push({ type: filterDialogData.type });
            }

            if (filterDialogData.status) {
              andFilters.push({ status: filterDialogData.status });
            }

            if (
              filterDialogData.amenities &&
              filterDialogData.amenities.length > 0
            ) {
              andFilters.push({
                featuresAndAmenities: { $all: filterDialogData.amenities },
              });
            }
          }

          const filterQuery = andFilters.length > 0 ? { $and: andFilters } : {};

          const properties = await PropertyModel.find(filterQuery)
            .skip(safeStart)
            .limit(safeEnd - safeStart)
            .sort({ createdAt: -1 });

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
        } catch (error) {
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
      async (req: Request<{ id: string }>, res: Response) => {
        try {
          const { id } = req.params;
          const safeID = id.trim();
          console.log(safeID);
          if (!safeID) {
            throw new Error("Property ID is required.");
          }
          const property = await PropertyModel.findOne({ id: safeID });
          if (!property) {
            throw new Error("Property not found.");
          }
          res.status(200).json({
            status: "success",
            message: "Property fetched successfully.",
            data: property,
          });
        } catch (error) {
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
}
