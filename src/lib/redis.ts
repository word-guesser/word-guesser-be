import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Singleton Redis client
let _client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_client) {
    _client = new Redis(REDIS_URL, {
      // Reconnect strategy: exponential backoff up to 3 s
      retryStrategy: (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      enableReadyCheck: true,
    });

    _client.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    _client.on('connect', () => {
      console.log('[Redis] Connected to', REDIS_URL);
    });
  }
  return _client;
}

/** Only used in tests to reset the singleton */
export function _resetRedisClient() {
  _client = null;
}

export const redis = getRedisClient();
