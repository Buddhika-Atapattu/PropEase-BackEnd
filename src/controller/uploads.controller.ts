import {Request, Response} from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';

export class UploadsController {
    private readonly rootPublic: string;
    private readonly category: string = 'richtext';
    private readonly maxBytes: number = 5 * 1024 * 1024; // 5 MB
    private readonly allowedMime = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

    constructor (publicRootAbsPath: string) {
        this.rootPublic = publicRootAbsPath; // e.g., path.resolve(process.cwd(), 'public')
    }

    // POST /api/uploads/richtext
    public uploadRichTextImage = async (req: Request, res: Response): Promise<void> => {
        try {
            const file = (req as any).file as Express.Multer.File | undefined;
            if(!file) {
                res.status(400).json({success: false, message: 'No file uploaded'});
                return;
            }

            if(!this.allowedMime.has(file.mimetype)) {
                res.status(415).json({success: false, message: 'Unsupported image type'});
                return;
            }

            if(file.size > this.maxBytes) {
                res.status(413).json({success: false, message: 'Image too large (max 5MB)'});
                return;
            }

            // Build yyyy/mm path
            const now = new Date();
            const yyyy = String(now.getFullYear());
            const mm = String(now.getMonth() + 1).padStart(2, '0');

            const relDir = path.posix.join('uploads', this.category, yyyy, mm);
            const absDir = path.join(this.rootPublic, relDir);

            await fs.mkdir(absDir, {recursive: true});

            const safeBase = crypto.randomUUID().replace(/-/g, '');
            const outName = `${safeBase}.webp`;
            const absOut = path.join(absDir, outName);

            // Process with sharp: strip metadata, rotate, cap width, compress
            const MAX_WIDTH = 2560;
            await sharp(file.buffer)
                .rotate() // respect EXIF orientation then strip
                .resize({width: MAX_WIDTH, withoutEnlargement: true})
                .webp({quality: 82})
                .toFile(absOut);

            // Return a RELATIVE URL (no leading slash) for Electron friendliness
            const url = path.posix.join(relDir, outName);
            res.status(200).json({success: true, url});
            return;
        } catch(err: any) {
            res.status(500).json({success: false, message: err?.message || 'Upload failed'});
            return;
        }
    };
}
