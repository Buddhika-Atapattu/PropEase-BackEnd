//Path: src/api/uploads.router.ts
import { Router } from 'express';
import multer, { FileFilterCallback } from 'multer';
import path from 'node:path';
import { UploadsController } from '../controllers/uploads.controller';
import rateLimit from 'express-rate-limit';



export default class UploadsRoutes {
    public readonly router: Router = Router();
    private readonly ctrl: UploadsController;
    private readonly richtextLimiter = rateLimit( {
        windowMs: 15 * 60 * 1000, // 15 min
        max: 50,                  // 50 uploads per 15 min per token/IP
        standardHeaders: true,
        legacyHeaders: false,
    } );

    constructor () {
        const publicRoot = path.resolve( process.cwd(), 'public' );
        this.ctrl = new UploadsController( publicRoot );

        const upload = multer( {
            storage: multer.memoryStorage(),
            limits: { fileSize: 5 * 1024 * 1024, files: 1 },
            fileFilter: ( _req, file, cb: FileFilterCallback ) => {
                const ok = /^(image\/jpeg|image\/png|image\/webp|image\/gif)$/.test( file.mimetype );
                if ( ok ) { cb( null, true ); return; }
                // Pass an Error object to signal unsupported type (multer behavior)
                cb( new Error( 'Unsupported image type' ) );
            },
        } );

        this.router.post( '/uploads/richtext',
            this.richtextLimiter,
            upload.single( 'file' ),
            this.ctrl.uploadRichTextImage.bind( this.ctrl ) );
    }
}
