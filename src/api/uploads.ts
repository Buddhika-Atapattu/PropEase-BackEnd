import {Router} from 'express';
import multer, {FileFilterCallback} from 'multer';
import path from 'node:path';
import {UploadsController} from '../controller/uploads.controller';

export class UploadsRoutes {
    public readonly router: Router = Router();
    private readonly ctrl: UploadsController;

    constructor () {
        const publicRoot = path.resolve(process.cwd(), 'public');
        this.ctrl = new UploadsController(publicRoot);

        const upload = multer({
            storage: multer.memoryStorage(),
            limits: {fileSize: 5 * 1024 * 1024, files: 1},
            fileFilter: (_req, file, cb: FileFilterCallback) => {
                const ok = /^(image\/jpeg|image\/png|image\/webp|image\/gif)$/.test(file.mimetype);
                if(ok) {cb(null, true); return;}
                // Pass an Error object to signal unsupported type (multer behavior)
                cb(new Error('Unsupported image type'));
            },
        });

        this.router.post('/uploads/richtext', upload.single('file'), this.ctrl.uploadRichTextImage);
    }
}
