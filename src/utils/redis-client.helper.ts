// Path: src/utils/redis-client.helper.ts

import {REDIS_URL} from '../configs/env.config';
import { createClient, type RedisClientType } from 'redis';


export class RedisClientHelper {
  // Static singleton instance (one per process)
  private static instance: RedisClientHelper | null = null;

  // Underlying Redis client from node-redis
  private readonly client: RedisClientType;

  private constructor() {
    // Use env var when available, fallback to localhost
    const url: string = REDIS_URL ?? 'redis://127.0.0.1:6379';

    this.client = createClient({ url });

    this.client.on('error', (error: unknown) => {
      // Later you can replace with proper logger
      console.error('[Redis:] Client error:', error, '\n');
    });
  }

  /**
   * Get or create the singleton helper.
   * Ensures the client is connected before returning.
   */
  public static async getInstance(): Promise<RedisClientHelper> {
    if (!RedisClientHelper.instance) {
      const helper: RedisClientHelper = new RedisClientHelper();
      await helper.connectIfNeeded();
      RedisClientHelper.instance = helper;
    }

    return RedisClientHelper.instance as RedisClientHelper;
  }

  /**
   * Ensure low-level client is connected.
   * Called once on first use.
   */
  private async connectIfNeeded(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
      console.info('[Redis:] Connected', '\n');
    }
  }

  /**
   * Expose the raw client for services (e.g. WsTokenRegistryRedis).
   */
  public getClient(): RedisClientType {
    return this.client;
  }

  /**
   * Optional: clean shutdown hook if you ever want to close manually.
   */
  public async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
      console.info('[Redis:] Connection closed', '\n');
    }
  }
}
