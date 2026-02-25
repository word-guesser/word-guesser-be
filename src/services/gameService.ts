import { PlayerRole, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { GameState, RoomState, RoomPlayer } from '../types';
import { getRandomWordPair } from './genaiService';
import { GAME_CONFIG } from '../constants';

// ─────────────────────────────────────────────────────────────────────────────
// Redis Key Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ROOM_KEY = (roomId: string) => `room:${roomId}`;
const GAME_KEY = (roomId: string) => `game:${roomId}`;
const ACTIVE_ROOMS_SET = 'active_rooms'; // sorted set: roomId → createdAt timestamp

// ─────────────────────────────────────────────────────────────────────────────
// Serialization helpers
// ─────────────────────────────────────────────────────────────────────────────

function serializeRoom(state: RoomState): string {
  return JSON.stringify(state);
}

function deserializeRoom(raw: string): RoomState {
  return JSON.parse(raw) as RoomState;
}

function serializeGame(state: GameState): string {
  return JSON.stringify(state);
}

function deserializeGame(raw: string): GameState {
  const parsed = JSON.parse(raw) as GameState;
  // Date fields need to be revived
  parsed.clues = parsed.clues.map((c) => ({ ...c, createdAt: new Date(c.createdAt) }));
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Room State — stored in Redis
// ─────────────────────────────────────────────────────────────────────────────

export async function getRoomState(roomId: string): Promise<RoomState | null> {
  const raw = await redis.get(ROOM_KEY(roomId));
  if (raw) {
    return deserializeRoom(raw);
  }

  // Fall back to DB (may happen after cold restart if TTL is still valid but key gone)
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      players: {
        include: { user: true },
        orderBy: { joinedAt: 'asc' },
      },
    },
  });
  if (!room) return null;

  const state: RoomState = {
    id: room.id,
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    maxPlayers: room.maxPlayers,
    players: room.players.map(
      (p): RoomPlayer => ({
        id: p.id,
        userId: p.userId,
        displayName: p.user.displayName,
        avatar: p.user.avatar,
        isActive: p.isActive,
        isHost: p.userId === room.hostId,
        role: p.role,
      })
    ),
  };

  // Restore into Redis (warm cache)
  if (room.status !== 'FINISHED') {
    await redis.setex(ROOM_KEY(roomId), GAME_CONFIG.ROOM_STATE_TTL_SECONDS, serializeRoom(state));
  }

  return state;
}

/** Persist updated room state back to Redis + refresh TTL */
export async function setRoomState(state: RoomState): Promise<void> {
  await redis.setex(
    ROOM_KEY(state.id),
    GAME_CONFIG.ROOM_STATE_TTL_SECONDS,
    serializeRoom(state)
  );
}

/** Remove room from Redis and active-rooms set */
export async function deleteRoomState(roomId: string): Promise<void> {
  await redis.del(ROOM_KEY(roomId));
  await redis.zrem(ACTIVE_ROOMS_SET, roomId);
}

/** Look up a room ID by its 6-char join code from Redis */
export async function getRoomIdByCode(code: string): Promise<string | null> {
  return redis.get(`room_code:${code.toUpperCase()}`);
}

/** Register code → roomId mapping in Redis */
export async function setRoomCodeMapping(code: string, roomId: string): Promise<void> {
  await redis.setex(
    `room_code:${code.toUpperCase()}`,
    GAME_CONFIG.ROOM_STATE_TTL_SECONDS,
    roomId
  );
}

/** Delete code → roomId mapping */
export async function deleteRoomCodeMapping(code: string): Promise<void> {
  await redis.del(`room_code:${code.toUpperCase()}`);
}

/** Return total number of currently active (WAITING or IN_PROGRESS) rooms */
export async function getActiveRoomCount(): Promise<number> {
  return redis.zcard(ACTIVE_ROOMS_SET);
}

/** Track a room as active in the sorted set */
async function trackActiveRoom(roomId: string): Promise<void> {
  await redis.zadd(ACTIVE_ROOMS_SET, Date.now(), roomId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Game State — stored in Redis
// ─────────────────────────────────────────────────────────────────────────────

export async function getGameState(roomId: string): Promise<GameState | null> {
  const raw = await redis.get(GAME_KEY(roomId));
  if (!raw) return null;
  return deserializeGame(raw);
}

async function setGameState(state: GameState): Promise<void> {
  await redis.setex(GAME_KEY(state.roomId), GAME_CONFIG.ROOM_STATE_TTL_SECONDS, serializeGame(state));
}

async function deleteGameState(roomId: string): Promise<void> {
  await redis.del(GAME_KEY(roomId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Role Assignment
// ─────────────────────────────────────────────────────────────────────────────

function assignRoles(playerCount: number): PlayerRole[] {
  const roles: PlayerRole[] = [];
  const hasWhiteHat = playerCount > GAME_CONFIG.WHITE_HAT_MIN_PLAYERS - 1;

  roles.push(PlayerRole.BLACK_HAT);
  if (hasWhiteHat) roles.push(PlayerRole.WHITE_HAT);

  const civilianCount = playerCount - roles.length;
  for (let i = 0; i < civilianCount; i++) roles.push(PlayerRole.CIVILIAN);

  // Shuffle
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return roles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Game Start
// ─────────────────────────────────────────────────────────────────────────────

export async function startGame(
  roomId: string,
  hostUserId: string,
): Promise<{ success: boolean; message?: string; wordPairId?: string }> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: { where: { isActive: true } } },
  });

  if (!room) return { success: false, message: 'Phòng không tồn tại.' };
  if (room.hostId !== hostUserId) return { success: false, message: 'Chỉ chủ phòng mới có thể bắt đầu.' };
  if (room.status !== 'WAITING') return { success: false, message: 'Trò chơi đã bắt đầu.' };

  const activePlayers = room.players;
  if (activePlayers.length < GAME_CONFIG.MIN_PLAYERS) {
    return { success: false, message: `Cần ít nhất ${GAME_CONFIG.MIN_PLAYERS} người chơi.` };
  }

  const wordPair = await getRandomWordPair();
  if (!wordPair) {
    return { success: false, message: 'Không tìm thấy cặp từ. Vui lòng thêm từ vào hệ thống.' };
  }

  const roles = assignRoles(activePlayers.length);

  // ── DB: update room status + assign roles + create first round (match history) ──
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.room.update({ where: { id: roomId }, data: { status: 'IN_PROGRESS' } });
    for (let i = 0; i < activePlayers.length; i++) {
      await tx.player.update({ where: { id: activePlayers[i].id }, data: { role: roles[i] } });
    }
    await tx.round.create({
      data: { roomId, roundNumber: 1, wordPairId: wordPair.id, phase: 'HINTING' },
    });
  });

  // ── Redis: initialize GameState ──
  const shuffledPlayers = [...activePlayers].sort(() => Math.random() - 0.5);
  const gameState: GameState = {
    roomId,
    roundNumber: 1,
    phase: 'HINTING',
    turnOrder: shuffledPlayers.map((p) => p.id),
    currentTurnIndex: 0,
    clues: [],
    votes: {},
    eliminatedPlayers: [],
    wordPairId: wordPair.id,
  };
  await setGameState(gameState);

  // ── Redis: update RoomState status field ──
  const roomState = await getRoomState(roomId);
  if (roomState) {
    await setRoomState({ ...roomState, status: 'IN_PROGRESS' });
  }

  return { success: true, wordPairId: wordPair.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clue Submission
// ─────────────────────────────────────────────────────────────────────────────

export async function submitClue(
  roomId: string,
  playerId: string,
  content: string,
): Promise<{ success: boolean; message?: string; nextPlayerId?: string | null; votingStarted?: boolean }> {
  const state = await getGameState(roomId);
  if (!state) return { success: false, message: 'Trò chơi chưa bắt đầu.' };
  if (state.phase !== 'HINTING') return { success: false, message: 'Không phải lúc để đưa ra gợi ý.' };

  const expectedPlayerId = state.turnOrder[state.currentTurnIndex];
  if (expectedPlayerId !== playerId) return { success: false, message: 'Chưa đến lượt của bạn.' };

  const round = await prisma.round.findFirst({ where: { roomId, roundNumber: state.roundNumber } });
  if (!round) return { success: false, message: 'Vòng chơi không hợp lệ.' };

  const player = await prisma.player.findUnique({ where: { id: playerId }, include: { user: true } });
  if (!player) return { success: false, message: 'Người chơi không hợp lệ.' };

  // ── DB: persist clue for match history ──
  await prisma.clue.create({ data: { roundId: round.id, playerId, content } });

  // ── Redis: update game state ──
  state.clues.push({ playerId, displayName: player.user.displayName, content, createdAt: new Date() });
  state.currentTurnIndex++;

  // Skip eliminated players
  while (
    state.currentTurnIndex < state.turnOrder.length &&
    state.eliminatedPlayers.includes(state.turnOrder[state.currentTurnIndex])
  ) {
    state.currentTurnIndex++;
  }

  if (state.currentTurnIndex >= state.turnOrder.length) {
    state.phase = 'VOTING';
    await prisma.round.update({ where: { id: round.id }, data: { phase: 'VOTING' } });
    await setGameState(state);
    return { success: true, votingStarted: true };
  }

  await setGameState(state);
  return { success: true, nextPlayerId: state.turnOrder[state.currentTurnIndex] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────────────────────

export async function submitVote(
  roomId: string,
  voterId: string,
  targetId: string,
): Promise<{ success: boolean; message?: string; allVoted?: boolean }> {
  const state = await getGameState(roomId);
  if (!state) return { success: false, message: 'Trò chơi chưa bắt đầu.' };
  if (state.phase !== 'VOTING') return { success: false, message: 'Không phải lúc bỏ phiếu.' };
  if (state.eliminatedPlayers.includes(voterId))
    return { success: false, message: 'Bạn đã bị loại, không thể bỏ phiếu.' };
  if (state.votes[voterId]) return { success: false, message: 'Bạn đã bỏ phiếu rồi.' };

  const round = await prisma.round.findFirst({ where: { roomId, roundNumber: state.roundNumber } });
  if (!round) return { success: false, message: 'Vòng chơi không hợp lệ.' };

  // ── DB: persist vote for match history ──
  await prisma.vote.create({ data: { roundId: round.id, voterId, targetId } });

  // ── Redis: update votes map ──
  state.votes[voterId] = targetId;

  const activePlayers = state.turnOrder.filter((id) => !state.eliminatedPlayers.includes(id));
  const allVoted = activePlayers.every((id) => state.votes[id]);

  await setGameState(state);
  return { success: true, allVoted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tally Votes and Resolve Round
// ─────────────────────────────────────────────────────────────────────────────

export interface RoundResolution {
  eliminatedPlayerId: string | null;
  eliminatedRole?: PlayerRole | null;
  isWhiteHat: boolean;
  gameOver: boolean;
  winner?: 'CIVILIAN' | 'BLACK_HAT' | 'WHITE_HAT';
}

export async function resolveVotes(roomId: string): Promise<RoundResolution> {
  const state = await getGameState(roomId);
  if (!state) throw new Error('Game state not found');

  const voteCounts: Record<string, number> = {};
  for (const targetId of Object.values(state.votes)) {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  }

  const maxVotes = Math.max(0, ...Object.values(voteCounts));
  const topTargets = Object.entries(voteCounts)
    .filter(([, count]) => count === maxVotes)
    .map(([id]) => id);

  if (topTargets.length > 1) {
    await startNextRound(roomId, state);
    return { eliminatedPlayerId: null, isWhiteHat: false, gameOver: false };
  }

  const eliminatedPlayerId = topTargets[0];
  const eliminatedPlayer = await prisma.player.findUnique({ where: { id: eliminatedPlayerId } });
  if (!eliminatedPlayer) throw new Error('Eliminated player not found');

  // ── DB: mark player eliminated ──
  await prisma.player.update({ where: { id: eliminatedPlayerId }, data: { isActive: false } });

  // ── Redis: update eliminated list ──
  state.eliminatedPlayers.push(eliminatedPlayerId);

  const isWhiteHat = eliminatedPlayer.role === PlayerRole.WHITE_HAT;

  if (isWhiteHat) {
    state.phase = 'GUESSING';
    const round = await prisma.round.findFirst({ where: { roomId, roundNumber: state.roundNumber } });
    if (round) {
      await prisma.round.update({ where: { id: round.id }, data: { phase: 'GUESSING' } });
    }
    await setGameState(state);
    return { eliminatedPlayerId, eliminatedRole: eliminatedPlayer.role, isWhiteHat: true, gameOver: false };
  }

  const winResult = await checkWinConditions(roomId, state);
  if (winResult.gameOver) {
    await endGame(roomId, state, winResult.winner!);
    return { eliminatedPlayerId, eliminatedRole: eliminatedPlayer.role, isWhiteHat: false, ...winResult };
  }

  await startNextRound(roomId, state);
  return { eliminatedPlayerId, eliminatedRole: eliminatedPlayer.role, isWhiteHat: false, gameOver: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// White Hat Guessing Phase
// ─────────────────────────────────────────────────────────────────────────────

export async function submitWhiteHatGuess(
  roomId: string,
  whiteHatPlayerId: string,
  guess: string,
): Promise<{ success: boolean; correct: boolean; correctWord?: string; gameOver?: boolean; winner?: 'CIVILIAN' | 'BLACK_HAT' | 'WHITE_HAT' }> {
  const state = await getGameState(roomId);
  if (!state || state.phase !== 'GUESSING') return { success: false, correct: false };

  const wordPair = await prisma.wordPair.findUnique({ where: { id: state.wordPairId } });
  if (!wordPair) return { success: false, correct: false };

  const correct = guess.trim().toLowerCase() === wordPair.wordA.trim().toLowerCase();

  if (correct) {
    await endGame(roomId, state, 'WHITE_HAT');
    return { success: true, correct: true, gameOver: true, winner: 'WHITE_HAT' };
  }

  const winResult = await checkWinConditions(roomId, state);
  if (winResult.gameOver) {
    await endGame(roomId, state, winResult.winner!);
    return { success: true, correct: false, correctWord: wordPair.wordA, gameOver: true, winner: winResult.winner };
  }

  await startNextRound(roomId, state);
  return { success: true, correct: false, correctWord: wordPair.wordA, gameOver: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Win Condition Check
// ─────────────────────────────────────────────────────────────────────────────

export async function checkWinConditions(
  roomId: string,
  state?: GameState,
): Promise<{ gameOver: boolean; winner?: 'CIVILIAN' | 'BLACK_HAT' | 'WHITE_HAT' }> {
  const gs = state ?? (await getGameState(roomId));
  if (!gs) return { gameOver: false };

  const activePlayers = await prisma.player.findMany({ where: { roomId, isActive: true } });

  const hasBlackHat = activePlayers.some((p) => p.role === PlayerRole.BLACK_HAT);
  const hasWhiteHat = activePlayers.some((p) => p.role === PlayerRole.WHITE_HAT);
  const activeCount = activePlayers.length;

  if (activeCount <= 2 && hasBlackHat) return { gameOver: true, winner: 'BLACK_HAT' };
  if (!hasBlackHat) return { gameOver: true, winner: 'CIVILIAN' };
  if (!hasBlackHat && !hasWhiteHat) return { gameOver: true, winner: 'CIVILIAN' };

  return { gameOver: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Next Round
// ─────────────────────────────────────────────────────────────────────────────

async function startNextRound(roomId: string, state: GameState) {
  const wordPair = await getRandomWordPair();
  if (!wordPair) return;

  state.roundNumber++;
  state.phase = 'HINTING';
  state.clues = [];
  state.votes = {};
  state.wordPairId = wordPair.id;

  const activePlayers = await prisma.player.findMany({
    where: { roomId, isActive: true },
    orderBy: { joinedAt: 'asc' },
  });

  state.turnOrder = activePlayers.sort(() => Math.random() - 0.5).map((p) => p.id);
  state.currentTurnIndex = 0;

  // ── DB: record new round for match history ──
  await prisma.round.create({
    data: { roomId, roundNumber: state.roundNumber, wordPairId: wordPair.id, phase: 'HINTING' },
  });

  await setGameState(state);
}

// ─────────────────────────────────────────────────────────────────────────────
// End Game — finalize in DB, clean up Redis
// ─────────────────────────────────────────────────────────────────────────────

async function endGame(roomId: string, state: GameState, _winner: string) {
  // ── DB: finalize match history ──
  await prisma.room.update({ where: { id: roomId }, data: { status: 'FINISHED' } });

  const round = await prisma.round.findFirst({ where: { roomId }, orderBy: { roundNumber: 'desc' } });
  if (round) {
    await prisma.round.update({ where: { id: round.id }, data: { phase: 'RESULT', endedAt: new Date() } });
  }

  // ── Redis: clean up active room data ──
  await deleteGameState(roomId);
  await deleteRoomState(roomId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Word for Player Role (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export async function getWordForPlayer(wordPairId: string, role: PlayerRole): Promise<string | null> {
  const wordPair = await prisma.wordPair.findUnique({ where: { id: wordPairId } });
  if (!wordPair) return null;

  if (role === PlayerRole.CIVILIAN) return wordPair.wordA;
  if (role === PlayerRole.BLACK_HAT) return wordPair.wordB;
  return null; // WHITE_HAT gets no word
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported for tests / socket layer
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Legacy export — use getGameState() instead */
export const gameStates = {
  get: (roomId: string) => getGameState(roomId),
};

export { trackActiveRoom };
