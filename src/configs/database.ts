// src/configs/database.ts
import {MongoClient, Db, MongoClientOptions, ServerApiVersion} from 'mongodb';

type HandshakeInfo = {
  name: string;
  version: string;
  changeStreams: boolean;
};

export default class Database {
  private readonly uri: string;
  private readonly dbName: string;

  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connected = false; // track state explicitly (v5 has no .topology)

  constructor (
    uri: string = process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017',
    dbName: string = process.env.MONGO_DB ?? 'propease'
  ) {
    this.uri = uri;       // always a string (defaults provided)
    this.dbName = dbName; // always a string (defaults provided)
  }

  /** Build MongoClientOptions without assigning any undefined fields */
  private buildOptions(): MongoClientOptions {
    const useTls = process.env.MONGO_TLS === 'true' || process.env.MONGO_TLS === '1';
    const tlsCAFile = process.env.MONGO_TLS_CA_FILE;
    const tlsCertificateKeyFile = process.env.MONGO_TLS_CERT_KEY_FILE;

    const options: MongoClientOptions = {
      serverApi: ServerApiVersion.v1,
      // Sensible defaults
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 20_000,
      retryWrites: true,
      ...(useTls
        ? {
          tls: true,
          ...(tlsCAFile ? {tlsCAFile} : {}),
          ...(tlsCertificateKeyFile ? {tlsCertificateKeyFile} : {}),
        }
        : {}),
    };

    return options;
  }

  /** Connect and cache the Db reference */
  async connect(): Promise<void> {
    if(this.connected && this.client && this.db) return; // already connected
    const options = this.buildOptions();
    const client = new MongoClient(this.uri, options);
    this.client = await client.connect();
    this.db = this.client.db(this.dbName);
    this.connected = true;
    console.log(`[db] connected → ${this.uri}/${this.dbName}`);
  }

  /** Close connection if open */
  async close(): Promise<void> {
    if(!this.client) return;
    try {
      await this.client.close();
    } finally {
      this.client = null;
      this.db = null;
      this.connected = false;
      console.log('[db] connection closed');
    }
  }

  /** Is the client logically connected? */
  isConnected(): boolean {
    return this.connected;
  }

  /** Simple ping command */
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
   * Handshake: return useful capability info (e.g., changeStreams support).
   * Change streams require a replica set or sharded cluster with replica sets.
   */
  async handshake(name: string): Promise<HandshakeInfo> {
    const db = this.assertDb();
    const admin = db.admin();

    // buildInfo gives version; replSetGetStatus throws on standalone
    const [buildInfoRes, replStatusRes] = await Promise.allSettled([
      admin.command({buildInfo: 1}) as Promise<{version?: string}>,
      admin.command({replSetGetStatus: 1}) as Promise<{ok?: number}>,
    ]);

    const version =
      buildInfoRes.status === 'fulfilled' && buildInfoRes.value?.version
        ? String(buildInfoRes.value.version)
        : 'unknown';

    const changeStreams =
      replStatusRes.status === 'fulfilled' && replStatusRes.value?.ok === 1;

    console.log(`[db] handshake ${name}: version=${version} changeStreams=${changeStreams}`);
    return {name, version, changeStreams};
  }

  /** Ensure DB is available */
  private assertDb(): Db {
    if(!this.db) throw new Error('Database not connected. Call connect() first.');
    return this.db;
  }

  /** Expose the Db (read-only accessor) */
  get database(): Db {
    return this.assertDb();
  }

  /** Expose the MongoClient (read-only accessor) */
  get mongoClient(): MongoClient {
    if(!this.client) throw new Error('MongoClient not connected.');
    return this.client;
  }
}
