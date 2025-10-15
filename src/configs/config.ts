// src/config/config.ts
export class Config {
    // App
    static readonly host = process.env.HOST ?? 'localhost';
    static readonly port = Number(process.env.PORT ?? 3000);
    static readonly frontendOrigin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:4200';

    // Auth
    static readonly jwtSecret = must('JWT_SECRET');

    // DB
    static readonly mongoUri = must('MONGO_URI');
    static readonly mongoDb = must('MONGO_DB');

    // SMTP (optional defaults)
    static readonly smtp = {
        user: must('SMTP_USER'),
        pass: must('SMTP_PASS'),
        host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: (process.env.SMTP_SECURE ?? 'false') === 'true',
    };

    // Twilio
    static readonly twilio = {
        sid: must('TWILIO_ACCOUNT_SID'),
        token: must('TWILIO_ACCOUNT_AUTH_TOKEN'),
        from: must('TWILIO_ACCOUNT_PHONE_NUMBER'),
        recoveryCode: process.env.TWILIO_ACCOUNT_RECOVERY_CODE ?? '',
    };

    // Google
    static readonly googleApiKey = must('GOOGLE_API_KEY');
}

function must(name: string): string {
    const v = process.env[name];
    if(!v || !v.trim()) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return v;
}
