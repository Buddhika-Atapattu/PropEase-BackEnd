// Path: src/dev-scripts/redis-connection-tester.ts

import 'dotenv/config'; // loads .env at startup
import { RedisClientHelper } from '../utils/redis-client.helper';

class RedisConnectionTester {
  public async run(): Promise<void> {
    try {
      console.info('[Test] Initializing RedisClientHelper...');

      const helper: RedisClientHelper = await RedisClientHelper.getInstance();
      const client = helper.getClient();

      // Write a key
      const testKey: string = 'propease:redis:test';
      const testValue: string = `hello-redis-${Date.now()}`;

      console.info(`[Test] SET ${testKey} = ${testValue}`);
      await client.set(testKey, testValue);

      // Read it back
      const value: string | null = await client.get(testKey);
      console.info(`[Test] GET ${testKey} ->`, value);

      if (value === testValue) {
        console.info('[Test] ✅ Redis round-trip OK (set/get matched)');
      } else {
        console.warn('[Test] ⚠ Redis round-trip mismatch');
      }

      // Optional: clean close
      await helper.close();
    } catch (error) {
      console.error('[Test] ❌ RedisConnectionTester error:', error);
    } finally {
      // For a one-off dev script, we exit explicitly
      process.exit(0);
    }
  }
}

// Kick off the test
void new RedisConnectionTester().run();
