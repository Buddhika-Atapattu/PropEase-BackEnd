//src/services/mongo-capability.service.ts
import mongoose from 'mongoose';

export async function isChangeStreamCapable(): Promise<boolean> {
    // Wait until mongoose is connected
    if(mongoose.connection.readyState !== 1) {
        await mongoose.connection.asPromise(); // waits for connect
    }

    const db = mongoose.connection.db;
    if(!db) {
        console.warn('[mongo] No active DB connection yet');
        return false;
    }

    try {
        const admin = db.admin();
        // Try `hello` first (MongoDB 5+), fallback to legacy `isMaster`
        const info = await admin.command({hello: 1}).catch(() => admin.command({isMaster: 1}));
        return Boolean((info as any).setName) || (info as any).msg === 'isdbgrid';
    } catch(err) {
        console.warn('[mongo] Capability check failed:', (err as Error).message);
        return false;
    }
}
