///src/middleware/guards.ts
import {Request, Response, NextFunction, RequestHandler} from "express";
import {Role} from "../types/roles";

export default class Guards {
    public static requireRole(role: Role): RequestHandler {
        return (req: Request, res: Response, next: NextFunction): void => {
            // skip CORS preflight
            if(req.method === "OPTIONS") {next(); return;}

            const user = req.user; // <- from your declare global augmentation
            if(user?.role === role) {
                next();
                return;
            }
            // IMPORTANT: end the response, don't return the Response object
            res.status(403).json({status: "error", message: "Forbidden"});
        };
    }
}