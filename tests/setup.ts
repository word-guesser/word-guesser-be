/**
 * Global test setup — runs once before all test files.
 * Sets TEST env var so server binds to a random port, uses test DB.
 */
import { vi } from 'vitest';

// Ensure we use a test env / don't pollute dev DB
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = 'redis://localhost:6379'; // overridden by mock below

// ── Mock Redis so tests use in-memory ioredis-mock ──────────────────────────
vi.mock('../src/lib/redis', async () => {
  // ioredis-mock is a drop-in replacement for ioredis
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RedisMock = (await import('ioredis-mock')).default;
  const instance = new RedisMock();
  return {
    redis: instance,
    getRedisClient: () => instance,
    _resetRedisClient: vi.fn(),
  };
});

// ── Mock Gemini AI so tests don't make real API calls ───────────────────────
vi.mock('../src/services/genaiService', () => ({
  generateWordPair: vi.fn().mockResolvedValue({
    wordA: 'Chó',
    wordB: 'Mèo',
    categoryName: '__test_animals__',
  }),
  // This is the function actually called by gameService.startGame()
  getRandomWordPair: vi.fn().mockImplementation(async () => {
    // Query the real DB for any active word pair (seeded in game-flow.test.ts beforeAll)
    const { prisma } = await import('../src/lib/prisma');
    return prisma.wordPair.findFirst({ where: { isActive: true } });
  }),
  saveGeneratedWordPair: vi.fn().mockResolvedValue(null),
}));
