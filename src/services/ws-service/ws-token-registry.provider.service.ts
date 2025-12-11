// Path: src/services/ws-service/ws-token-registry.provider.service.ts

import type { RedisClientType } from 'redis';
import { RedisClientHelper } from '../../utils/redis-client.helper';
import { WsTokenRegistryRedis } from './ws-token-registry.redis.service';

export class WsTokenRegistryProvider {
  private static instance: WsTokenRegistryRedis | null = null;

  /**
   * Get or create the singleton WsTokenRegistryRedis.
   * Uses the shared RedisClientHelper under the hood.
   */
  public static async getInstance(): Promise<WsTokenRegistryRedis> {
    if (!WsTokenRegistryProvider.instance) {
      const helper: RedisClientHelper = await RedisClientHelper.getInstance();
      const client: RedisClientType = helper.getClient();
      WsTokenRegistryProvider.instance = new WsTokenRegistryRedis(client);
    }

    return WsTokenRegistryProvider.instance as WsTokenRegistryRedis;
  }
}
