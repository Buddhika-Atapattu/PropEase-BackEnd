// src/api/placesController.ts
// ============================================================================
// PlacesController
// ----------------------------------------------------------------------------
// PURPOSE:
//   This controller handles requests for Google Places Autocomplete suggestions.
//   It receives a text input (partial address or place name) from the frontend,
//   calls the Google Maps API, and returns location predictions.
//
// DEPENDENCIES:
//   - express : for routing and HTTP handling
//   - axios   : for making HTTP requests to the external Google API
//   - dotenv  : for loading environment variables (API key)
// ============================================================================

import express, {Request, Response, Router} from "express"; // Import Express and its types
import axios from "axios"; // For sending HTTP requests to the Google API
import dotenv from "dotenv"; // Loads environment variables from .env file

dotenv.config(); // Initialize dotenv (ensures process.env.GOOGLE_API_KEY is available)

// ============================================================================
// Main Controller Class
// ============================================================================
export class PlacesController {
  // The Express Router instance — used to define the HTTP routes for this controller.
  public router: Router;

  // ------------------------------ CONSTRUCTOR ------------------------------
  constructor () {
    // Create a new Router object for this controller.
    this.router = express.Router();

    // Call the method that sets up all endpoint routes.
    this.registerRoutes();
  }

  // -------------------------- REGISTER ROUTES ------------------------------
  /**
   * Define all available API routes for this controller.
   * Each route is mapped to a handler method.
   */
  private registerRoutes(): void {
    // Example route:
    // GET /places/autocomplete?input=colombo
    //
    // The handler method `getAutocompleteSuggestions` will process this request.
    this.router.get("/autocomplete", this.getAutocompleteSuggestions);
  }

  // -------------------------- AUTOCOMPLETE HANDLER --------------------------
  /**
   * Handles GET /places/autocomplete
   * - Reads the user's input from the query string.
   * - Calls the Google Places Autocomplete API.
   * - Returns the JSON response from Google to the frontend.
   */
  private async getAutocompleteSuggestions(req: Request, res: Response): Promise<void> {
    // Extract the text input from the URL query parameters
    // Example: /places/autocomplete?input=colombo
    const input = req.query.input as string;

    // Retrieve your Google API key from environment variables
    // (Stored securely in your .env file as GOOGLE_API_KEY)
    const key = process.env.GOOGLE_API_KEY;

    // Validate input and key before proceeding
    if(!input || !key) {
      res.status(400).json({error: "Missing input or API key"});
      return;
    }

    // Construct the Google Maps Places Autocomplete API URL.
    // The API expects:
    //   input → the text query entered by the user
    //   key   → your Google API key
    //
    // NOTE:
    // - encodeURIComponent() is used to safely encode special characters.
    // - You can also add parameters like `components=country:lk`
    //   to limit results to Sri Lanka.
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
      input
    )}&key=${key}`;

    // Example final URL:
    // https://maps.googleapis.com/maps/api/place/autocomplete/json?input=colombo&key=XYZ123

    try {
      // Send a GET request to the Google API.
      // axios.get() returns a promise that resolves with the API response.
      const response = await axios.get(url);

      // Forward the response data directly to the frontend.
      // This includes predictions[] and status from Google.
      res.json(response.data);
    } catch(error: any) {
      // If the Google API request fails or times out,
      // return an HTTP 500 error with the error message.
      res.status(500).json({error: error.message || "Server Error"});
    }
  }
}

// ============================================================================
// USAGE EXAMPLE:
// ----------------------------------------------------------------------------
// In your main Express app (e.g., app.ts):
//
//   import { PlacesController } from "./api/places.controller";
//
//   const placesController = new PlacesController();
//   app.use("/places", placesController.router);
//
// Then you can call:
//   GET http://localhost:3000/places/autocomplete?input=kandy
//
// ============================================================================
//
// OPTIONAL ENHANCEMENTS:
// ----------------------------------------------------------------------------
// • Add a `components=country:lk` parameter to restrict results to Sri Lanka.
// • Add `sessiontoken` to group multiple autocomplete calls for billing efficiency.
// • Cache results to reduce API costs and latency.
// • Add error handling for specific Google response codes (e.g., OVER_QUERY_LIMIT).
// ============================================================================
