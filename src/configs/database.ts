// src/configs/database.ts
import mongoose from 'mongoose';

type HandshakeInfo = {
  name: string;
  version: string;
  changeStreams: boolean;
};

export default class Database {
  private readonly uri: string;
  private readonly dbName: string | undefined;

  constructor (
    uri: string = process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017',
    dbName: string = process.env.MONGO_DB ?? 'propease'
  ) {
    this.uri = uri.trim();
    // If URI already specifies a DB (e.g. mongodb://.../propease), don't also pass dbName.
    // That avoids weird double-db logs like ".../propease/propease".
    this.dbName = this.uriHasDb(this.uri) ? undefined : dbName.trim();
  }

  /** Detect if the Mongo URI already includes a database path */
  private uriHasDb(u: string): boolean {
    // quick check: after the first single slash following the authority, is there a non-empty path?
    // examples with DB: mongodb://host:27017/propease
    // examples without DB: mongodb://host:27017, mongodb://host:27017/?replicaSet=rs0
    const after = u.replace(/^mongodb(\+srv)?:\/\/[^/]+\/?/, '');
    // if after starts with '?' or empty string, there is no db segment
    return !!after && !after.startsWith('?');
  }

  /** Build Mongoose options (no undefined fields, works with exactOptionalPropertyTypes) */
  private buildOptions(): mongoose.ConnectOptions {
    const opts: mongoose.ConnectOptions = {
      // timeouts
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 20_000,
      maxPoolSize: 10,
      minPoolSize: 0,
      // modern parser/topology are defaults in v6+
      // only set dbName if the URI does NOT already include one
      ...(this.dbName ? {dbName: this.dbName} : {}),
    };

    // Optional TLS (Atlas / SSL self-hosted)
    const useTls = process.env.MONGO_TLS === 'true' || process.env.MONGO_TLS === '1';
    if(useTls) {
      const tlsCAFile = process.env.MONGO_TLS_CA_FILE;
      const tlsCertificateKeyFile = process.env.MONGO_TLS_CERT_KEY_FILE;
      Object.assign(opts, {
        tls: true,
        ...(tlsCAFile ? {tlsCAFile} : {}),
        ...(tlsCertificateKeyFile ? {tlsCertificateKeyFile} : {}),
      });
    }

    return opts;
  }

  /** Connect Mongoose (single connection for the whole app) */
  async connect(): Promise<void> {
    if(this.isConnected()) return;

    // helpful runtime setting (optional)
    mongoose.set('strictQuery', true);

    const opts = this.buildOptions();
    await mongoose.connect(this.uri, opts);

    const dbNameShown =
      this.uriHasDb(this.uri)
        ? (mongoose.connection.db?.databaseName ?? '(unknown)')
        : (this.dbName ?? '(unknown)');

    console.log(`[db] connected → ${this.uri}${this.uriHasDb(this.uri) ? '' : '/' + dbNameShown}`);
  }

  /** Close the Mongoose connection */
  async close(): Promise<void> {
    if(!this.isConnected()) return;
    try {
      await mongoose.disconnect();
    } finally {
      console.log('[db] connection closed');
    }
  }

  /** Is Mongoose connected? */
  isConnected(): boolean {
    // 1 = connected, 2 = connecting, 0 = disconnected, 3 = disconnecting
    return mongoose.connection.readyState === 1;
  }

  /** Simple ping using the current DB */
  async ping(): Promise<boolean> {
    try {
      const db = this.assertDb();
      const res = await db.command({ping: 1});
      return res?.ok === 1;
    } catch {
      return false;
    }
  }

  /**
   * Handshake: get server version + whether change streams are supported
   * (requires a replica set or sharded cluster with replica sets).
   */
  async handshake(name: string): Promise<HandshakeInfo> {
    const db = this.assertDb();
    const admin = db.admin();

    let version = 'unknown';
    let changeStreams = false;

    try {
      const build = await admin.command({buildInfo: 1}) as {version?: string};
      if(build?.version) version = String(build.version);
    } catch {
      // ignore
    }

    try {
      const repl = await admin.command({replSetGetStatus: 1}) as {ok?: number};
      changeStreams = repl?.ok === 1;
    } catch {
      changeStreams = false; // standalone server
    }

    console.log(`[db] handshake ${name}: version=${version} changeStreams=${changeStreams}`);
    return {name, version, changeStreams};
  }

  /** Internal: ensure we have a db handle */
  private assertDb(): mongoose.mongo.Db {
    const db = mongoose.connection.db;
    if(!db) throw new Error('Database not connected. Call connect() first.');
    return db;
  }

  /** Expose underlying Mongoose connection if needed elsewhere */
  get connection(): mongoose.Connection {
    return mongoose.connection;
  }
}
