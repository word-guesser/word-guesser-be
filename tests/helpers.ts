/**
 * Test helpers: create test server, seed test users, issue JWT tokens.
 */
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { prisma } from '../src/lib/prisma';
import { signJwt } from '../src/lib/jwt';
import { createApp } from '../src/app';
import { setupSocketIO } from '../src/socket';

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  token: string;
}

let _httpServer: ReturnType<typeof createServer> | null = null;
let _port = 0;

/** Start the HTTP + Socket.IO server on a random port. */
export async function startTestServer() {
  if (_httpServer) return { port: _port };

  const app = createApp();
  _httpServer = createServer(app);
  setupSocketIO(_httpServer);

  await new Promise<void>((resolve) => {
    _httpServer!.listen(0, '127.0.0.1', () => {
      _port = (_httpServer!.address() as AddressInfo).port;
      resolve();
    });
  });

  return { port: _port };
}

/** Close the test server. */
export async function stopTestServer() {
  await new Promise<void>((resolve, reject) => {
    if (!_httpServer) return resolve();
    _httpServer.close(err => (err ? reject(err) : resolve()));
    _httpServer = null;
    _port = 0;
  });
}

export function getTestServerUrl() {
  return `http://127.0.0.1:${_port}`;
}

/** Create a unique test user in the DB and return with JWT. */
export async function createTestUser(suffix: string): Promise<TestUser> {
  const user = await prisma.user.upsert({
    where: { googleId: `test-google-${suffix}` },
    update: { displayName: `TestUser ${suffix}` },
    create: {
      googleId: `test-google-${suffix}`,
      email: `test-${suffix}@example.com`,
      displayName: `TestUser ${suffix}`,
    },
  });
  const token = signJwt({ userId: user.id, email: user.email });
  return { id: user.id, email: user.email, displayName: user.displayName, token };
}

/** Delete test users and all associated game data. Handles FK cascade correctly. */
export async function cleanupTestData(userIds: string[]) {
  if (!userIds.length) return;

  // Find all rooms hosted by or participated in by these users
  const playerRecords = await prisma.player.findMany({
    where: { userId: { in: userIds } },
    select: { id: true, roomId: true },
  });
  const roomIds = [...new Set(playerRecords.map(p => p.roomId))];
  const playerIds = playerRecords.map(p => p.id);

  if (roomIds.length) {
    // Delete in FK-safe order: votes → clues → rounds → players → rooms
    await prisma.vote.deleteMany({ where: { round: { roomId: { in: roomIds } } } });
    await prisma.clue.deleteMany({ where: { round: { roomId: { in: roomIds } } } });
    await prisma.round.deleteMany({ where: { roomId: { in: roomIds } } });
    await prisma.player.deleteMany({ where: { id: { in: playerIds } } });
    await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  }

  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

/** Create a socket.io test client connected to the test server with auth. */
export function createSocketClient(token: string) {
  // Dynamic import at call time to avoid module circular deps
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { io } = require('socket.io-client') as typeof import('socket.io-client');
  return io(getTestServerUrl(), {
    auth: { token },
    autoConnect: false,
    transports: ['websocket'],
  });
}
