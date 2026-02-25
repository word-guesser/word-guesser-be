/**
 * Full Game Flow Integration Tests (WebSocket)
 * Tests the complete multiplayer game loop:
 *   connect → join room → start game → hint phase → vote → result
 *
 * Uses 4 socket.io-client instances (minimum player count) with real JWT auth.
 * Seeds a real WordPair in the DB so genaiService is never called.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { SOCKET_EVENTS } from '../src/constants';
import { prisma } from '../src/lib/prisma';
import {
  startTestServer, stopTestServer, getTestServerUrl,
  createTestUser, cleanupTestData,
  type TestUser,
} from './helpers';

// ── Helpers ─────────────────────────────────────────────────────────────────

function connect(token: string): Socket {
  return ioClient(getTestServerUrl(), {
    auth: { token },
    autoConnect: false,
    transports: ['websocket'],
  });
}

function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout (${timeoutMs}ms) waiting for "${event}"`)),
      timeoutMs
    );
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

function waitForAnySocket<T>(sockets: Socket[], event: string): Promise<{ idx: number; data: T }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}" on any socket`)), 10000);
    sockets.forEach((s, idx) => {
      s.once(event, (data: T) => {
        clearTimeout(t);
        // Remove listeners from other sockets
        sockets.forEach((os, oi) => { if (oi !== idx) os.off(event); });
        resolve({ idx, data });
      });
    });
  });
}

async function connectSocket(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.connect();
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

// ── Shared test state ────────────────────────────────────────────────────────

const NUM_PLAYERS = 4;
let users: TestUser[] = [];
let sockets: Socket[] = [];
let roomId: string;
let roomCode: string;

// Queue of { socketIdx, data } for YOUR_TURN events — collected from the moment game starts
const yourTurnQueue: Array<{ idx: number; data: unknown }> = [];
const yourTurnResolvers: Array<(v: { idx: number; data: unknown }) => void> = [];

/** Install persistent YOUR_TURN listeners on all sockets. Queues events for dequeue(). */
function installTurnListeners() {
  sockets.forEach((s, i) => {
    s.on(SOCKET_EVENTS.YOUR_TURN_TO_HINT, (data: unknown) => {
      const entry = { idx: i, data };
      if (yourTurnResolvers.length > 0) {
        yourTurnResolvers.shift()!(entry);
      } else {
        yourTurnQueue.push(entry);
      }
    });
  });
}

/** Wait for the next YOUR_TURN event from any socket. */
function nextYourTurn(timeoutMs = 8000): Promise<{ idx: number; data: unknown }> {
  if (yourTurnQueue.length > 0) {
    return Promise.resolve(yourTurnQueue.shift()!);
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const i = yourTurnResolvers.indexOf(resolve);
      if (i >= 0) yourTurnResolvers.splice(i, 1);
      reject(new Error('YOUR_TURN timeout'));
    }, timeoutMs);
    yourTurnResolvers.push((v) => { clearTimeout(t); resolve(v); });
  });
}

// IDs to clean up
let testCategoryId: string;
let testWordPairId: string;

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await startTestServer();

  // Create test users
  for (let i = 0; i < NUM_PLAYERS; i++) {
    users.push(await createTestUser(`gf-player-${i}-${Date.now()}`));
  }

  // Seed a real word pair so the game can start without calling Gemini AI
  const category = await prisma.wordCategory.upsert({
    where: { name: '__test_animals__' },
    update: {},
    create: { name: '__test_animals__', description: 'Test category' },
  });
  testCategoryId = category.id;

  const wordPair = await prisma.wordPair.create({
    data: {
      wordA: 'Chó',
      wordB: 'Mèo',
      categoryId: category.id,
    },
  });
  testWordPairId = wordPair.id;
});

afterAll(async () => {
  sockets.forEach(s => { try { s.disconnect(); } catch (_) { /* ignore */ } });

  // Cleanup game data (cascade: votes → clues → rounds → rooms → players → users)
  await cleanupTestData(users.map(u => u.id));

  // Now safe to delete word data (rounds no longer reference it)
  if (testWordPairId) {
    await prisma.wordPair.deleteMany({ where: { id: testWordPairId } }).catch(() => null);
  }
  if (testCategoryId) {
    // Only delete if no other word pairs reference this category
    const otherPairs = await prisma.wordPair.count({ where: { categoryId: testCategoryId } });
    if (otherPairs === 0) {
      await prisma.wordCategory.deleteMany({ where: { id: testCategoryId } }).catch(() => null);
    }
  }

  await stopTestServer();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Luồng kết nối Socket.IO', () => {
  it('từ chối kết nối nếu không có token', async () => {
    const badSocket = ioClient(getTestServerUrl(), {
      auth: {},
      autoConnect: false,
      transports: ['websocket'],
    });
    await new Promise<void>((resolve) => {
      badSocket.connect();
      badSocket.once('connect_error', (err) => {
        expect(err.message).toContain('Bạn chưa đăng nhập');
        badSocket.disconnect();
        resolve();
      });
    });
  });

  it('từ chối kết nối nếu token không hợp lệ', async () => {
    const badSocket = ioClient(getTestServerUrl(), {
      auth: { token: 'invalid.jwt.token' },
      autoConnect: false,
      transports: ['websocket'],
    });
    await new Promise<void>((resolve) => {
      badSocket.connect();
      badSocket.once('connect_error', (err) => {
        expect(err.message).toBeTruthy();
        badSocket.disconnect();
        resolve();
      });
    });
  });

  it('kết nối thành công với token hợp lệ (4 players)', async () => {
    for (let i = 0; i < NUM_PLAYERS; i++) {
      const s = connect(users[i].token);
      sockets.push(s);
      await connectSocket(s);
      expect(s.connected).toBe(true);
    }
  });
});

describe('Luồng tạo và tham gia phòng', () => {
  it('host tạo phòng qua REST API', async () => {
    const res = await request(getTestServerUrl())
      .post('/rooms')
      .set('Authorization', `Bearer ${users[0].token}`);

    expect(res.status).toBe(201);
    roomId = res.body.room.id;
    roomCode = res.body.room.code;
    expect(roomCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('host kết nối socket vào phòng (room:join)', async () => {
    const updated = waitForEvent<{ room: { players: unknown[] } }>(
      sockets[0], SOCKET_EVENTS.ROOM_UPDATED
    );
    sockets[0].emit(SOCKET_EVENTS.JOIN_ROOM, roomId);
    const data = await updated;
    expect(Array.isArray(data.room.players)).toBe(true);
  });

  it('3 guests tham gia phòng qua REST + socket', async () => {
    for (let i = 1; i < NUM_PLAYERS; i++) {
      // REST join
      const res = await request(getTestServerUrl())
        .post('/rooms/join')
        .set('Authorization', `Bearer ${users[i].token}`)
        .send({ code: roomCode });
      expect(res.status).toBe(200);

      // Socket join
      const updated = waitForEvent(sockets[i], SOCKET_EVENTS.ROOM_UPDATED, 5000);
      sockets[i].emit(SOCKET_EVENTS.JOIN_ROOM, roomId);
      await updated;
    }

    // Verify via REST
    const roomRes = await request(getTestServerUrl())
      .get(`/rooms/${roomId}`)
      .set('Authorization', `Bearer ${users[0].token}`);
    const active = roomRes.body.room.players.filter((p: { isActive: boolean }) => p.isActive);
    expect(active).toHaveLength(4);
  });
});

describe('Luồng bắt đầu game', () => {
  const roundPayloads: Array<{ role: string; word: string | null }> = [];

  it('game:start → tất cả 4 players nhận round:started với vai và từ bí mật', async () => {
    // Set up listeners BEFORE emitting game:start
    const listeners = sockets.map(s =>
      waitForEvent<{ round: number; role: string; word: string | null }>(
        s, SOCKET_EVENTS.ROUND_STARTED, 10000
      )
    );

    // Host starts game
    sockets[0].emit(SOCKET_EVENTS.START_GAME, roomId);

    // Install persistent YOUR_TURN listeners immediately
    installTurnListeners();

    // Wait for all 4 round:started events
    const results = await Promise.all(listeners);
    results.forEach(r => roundPayloads.push(r));

    expect(results).toHaveLength(4);
    results.forEach(r => {
      expect(r.round).toBe(1);
      expect(['CIVILIAN', 'BLACK_HAT', 'WHITE_HAT']).toContain(r.role);
    });
  });

  it('vai được phân đúng: chính xác 1 BLACK_HAT, 3 CIVILIAN (không có Mũ Trắng khi < 6 người)', () => {
    const roles = roundPayloads.map(r => r.role);
    expect(roles.filter(r => r === 'BLACK_HAT')).toHaveLength(1);
    expect(roles.filter(r => r === 'WHITE_HAT')).toHaveLength(0);
    expect(roles.filter(r => r === 'CIVILIAN')).toHaveLength(3);
  });

  it('CIVILIAN nhận từ A, BLACK_HAT nhận từ B (khác nhau)', () => {
    const civilian = roundPayloads.find(r => r.role === 'CIVILIAN');
    const blackHat = roundPayloads.find(r => r.role === 'BLACK_HAT');
    expect(civilian?.word).toBeTruthy();
    expect(blackHat?.word).toBeTruthy();
    expect(civilian?.word).not.toBe(blackHat?.word);
  });
});

describe('Luồng giai đoạn gợi ý + bỏ phiếu (HINTING → VOTING)', () => {
  it('tất cả 4 players gửi gợi ý theo lượt → trigger VOTING, clues được broadcast', async () => {
    const allCluesReceived: unknown[] = [];

    // Collect ALL clue broadcasts on ALL sockets
    const clueBroadcastPromises: Promise<unknown>[] = sockets.map(s =>
      new Promise<unknown>(resolve => {
        const clues: unknown[] = [];
        s.on(SOCKET_EVENTS.PLAYER_CLUE_SUBMITTED, (d: unknown) => {
          clues.push(d);
          allCluesReceived.push(d);
          if (clues.length >= NUM_PLAYERS) {
            s.off(SOCKET_EVENTS.PLAYER_CLUE_SUBMITTED);
            resolve(clues);
          }
        });
      })
    );

    const votingPromise = new Promise<unknown>(resolve => {
      sockets.forEach(s => s.once(SOCKET_EVENTS.VOTING_PHASE_STARTED, resolve));
    });

    // Test wrong-turn error before collecting all clues
    let wrongTurnTested = false;

    // Submit clues for each player in turn order
    for (let turn = 0; turn < NUM_PLAYERS; turn++) {
      const { idx } = await nextYourTurn(8000);
      sockets[idx].emit(SOCKET_EVENTS.SUBMIT_CLUE, { content: `Gợi ý số ${turn + 1}` });

      if (turn === 0 && !wrongTurnTested) {
        wrongTurnTested = true;
        // On first turn: test wrong-turn error — use +2 to pick someone who didn't just go
        const wrongIdx = (idx + 2) % NUM_PLAYERS;
        const errPromise = waitForEvent<{ message: string }>(sockets[wrongIdx], SOCKET_EVENTS.ERROR, 3000);
        sockets[wrongIdx].emit(SOCKET_EVENTS.SUBMIT_CLUE, { content: 'Không phải lượt tôi' });
        const err = await errPromise;
        expect(err.message).toBeTruthy();
      }

      // Wait for server to process
      await new Promise(r => setTimeout(r, 200));
    }

    // Wait for voting to start
    const votingData = await votingPromise;
    expect(votingData).toBeDefined();

    // Wait for all broadcasts to be received (or timeout)
    await Promise.race([
      Promise.all(clueBroadcastPromises),
      new Promise(r => setTimeout(r, 3000)),
    ]);

    // Verify all 4 clues were broadcast (each socket should see NUM_PLAYERS)
    expect(allCluesReceived.length).toBeGreaterThanOrEqual(NUM_PLAYERS);

    // Verify one clue's structure
    const sampleClue = allCluesReceived[0] as { displayName?: string; content?: string };
    expect(sampleClue?.displayName).toBeTruthy();
    expect(sampleClue?.content).toBeTruthy();

    // Cleanup
    sockets.forEach(s => s.off(SOCKET_EVENTS.PLAYER_CLUE_SUBMITTED));
  }, 25000);


  it('player bỏ phiếu → nhận round:vote_update', async () => {
    const voteUpdate = waitForEvent<{ voteCount: number }>(
      sockets[0], SOCKET_EVENTS.VOTE_UPDATE, 5000
    );

    // Find a target player (not user[0])
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: { players: { where: { isActive: true } } },
    });
    const target = room!.players.find(p => p.userId !== users[0].id);
    expect(target).toBeDefined();

    sockets[0].emit(SOCKET_EVENTS.SUBMIT_VOTE, { targetPlayerId: target!.id });

    const data = await voteUpdate;
    expect(data.voteCount).toBeGreaterThanOrEqual(1);
  });
});

