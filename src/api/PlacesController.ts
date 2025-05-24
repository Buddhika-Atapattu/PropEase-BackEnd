import express, { Request, Response, Router } from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

export class PlacesController {
  public router: Router;

  constructor() {
    this.router = express.Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.router.get("/autocomplete", this.getAutocompleteSuggestions);
  }

  private async getAutocompleteSuggestions(
    req: Request,
    res: Response
  ): Promise<void> {
    const input = req.query.input as string;
    const key = process.env.GOOGLE_API_KEY;

    if (!input || !key) {
      res.status(400).json({ error: "Missing input or API key" });
      return;
    }

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
      input
    )}&key=${key}`;

    // &types=geocode&components=country:lk

    try {
      const response = await axios.get(url);
      res.json(response.data);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Server Error" });
    }
  }
}
