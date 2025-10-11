// src/middleware/authMiddleware.ts
import {Request, Response, NextFunction, RequestHandler} from 'express';
import jwt from 'jsonwebtoken';
import {Role} from '../types/roles';

// (Optional) augment Express types so req.user is recognized everywhere
declare global {
    namespace Express {
        interface UserPayload {username: string; role: Role}
        interface Request {user?: UserPayload}
    }
}

// ✅ Explicitly type as RequestHandler and avoid returning a Response
export const authMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    try {
        // Prefer Authorization: Bearer <token>, fall back to cookie "token"
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ')
            ? header.slice(7).trim()
            : (req as any).cookies?.token; // requires cookie-parser if you want cookie auth

        if(!token) {
            res.status(401).json({message: 'Unauthorized'});
            return; // keep return type as void
        }

        const payload = jwt.verify(token, process.env.JWT_SECRET || 'defaultsecret') as {
            username: string;
            role: Role;
        };

        req.user = {username: payload.username, role: payload.role};
        next();
    } catch {
        res.status(401).json({message: 'Unauthorized'});
    }
};
