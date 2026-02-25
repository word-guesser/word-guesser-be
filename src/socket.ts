import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { verifyJwt } from './lib/jwt';
import { prisma } from './lib/prisma';
import { SOCKET_EVENTS, GAME_CONFIG } from './constants';
import {
  getRoomState,
  startGame,
  submitClue,
  submitVote,
  resolveVotes,
  submitWhiteHatGuess,
  getWordForPlayer,
  getGameState,
} from './services/gameService';
import { SocketData } from './types';
import { PlayerRole } from '@prisma/client';

export function setupSocketIO(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:5173',
      credentials: true,
    },
  });

  // ── Auth middleware for socket connections ──
  io.use(async (socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) return next(new Error('Bạn chưa đăng nhập.'));

    const payload = verifyJwt(token);
    if (!payload) return next(new Error('Token không hợp lệ.'));

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) return next(new Error('Người dùng không tồn tại.'));

    (socket.data as SocketData).user = user;
    next();
  });

  io.on('connection', (socket) => {
    const userData = (socket.data as SocketData).user;
    console.log(`[Socket] Kết nối: ${userData.displayName} (${userData.id})`);

    // ── JOIN ROOM ──────────────────────────────────────────────────
    socket.on(SOCKET_EVENTS.JOIN_ROOM, async (roomId: string) => {
      const roomState = await getRoomState(roomId);
      if (!roomState) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Phòng không tồn tại.' });
        return;
      }

      const player = roomState.players.find((p) => p.userId === userData.id);
      if (!player) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Bạn chưa tham gia phòng này qua API.' });
        return;
      }

      (socket.data as SocketData).roomId = roomId;
      (socket.data as SocketData).playerId = player.id;
      socket.join(roomId);

      // Notify all players in room
      io.to(roomId).emit(SOCKET_EVENTS.ROOM_UPDATED, { room: roomState });
      console.log(`[Socket] ${userData.displayName} joined room ${roomState.code}`);
    });

    // ── LEAVE ROOM ─────────────────────────────────────────────────
    socket.on(SOCKET_EVENTS.LEAVE_ROOM, async () => {
      await handleLeaveRoom(socket, io, userData.id);
    });

    socket.on('disconnect', async () => {
      console.log(`[Socket] Ngắt kết nối: ${userData.displayName}`);
      await handleLeaveRoom(socket, io, userData.id);
    });

    // ── START GAME ─────────────────────────────────────────────────
    socket.on(SOCKET_EVENTS.START_GAME, async (roomId: string) => {
      try {
        const result = await startGame(roomId, userData.id);
        if (!result.success) {
          socket.emit(SOCKET_EVENTS.ERROR, { message: result.message });
          return;
        }

        // Fetch all players with roles and send individual word
        const room = await prisma.room.findUnique({
          where: { id: roomId },
          include: { players: { include: { user: true } } },
        });

        if (!room || !result.wordPairId) {
          socket.emit(SOCKET_EVENTS.ERROR, { message: 'Không tìm thấy phòng sau khi bắt đầu.' });
          return;
        }

        // Emit game started to the room channel (public info)
        const roomState = await getRoomState(roomId);
        io.to(roomId).emit(SOCKET_EVENTS.GAME_STARTED, { room: roomState });

        // Send private role + word to each player
        const roomSockets = await io.in(roomId).fetchSockets();
        for (const s of roomSockets) {
          const sData = s.data as SocketData;
          if (!sData?.user) continue;
          const player = room.players.find(
            (p: { userId: string; id: string; role: PlayerRole | null }) => p.userId === sData.user.id
          );
          if (!player || !player.role) continue;

          const word = await getWordForPlayer(result.wordPairId, player.role);

          s.emit(SOCKET_EVENTS.ROUND_STARTED, {
            round: 1,
            role: player.role,
            word, // null for WHITE_HAT
            message:
              player.role === PlayerRole.WHITE_HAT
                ? 'Bạn là Mũ Trắng! Hãy nghe thật kỹ và đoán từ của Dân.'
                : player.role === PlayerRole.BLACK_HAT
                  ? 'Bạn là Mũ Đen! Hãy che giấu danh tính của mình.'
                  : 'Bạn là Dân! Hãy gợi ý từ của bạn mà không làm lộ danh tính.',
          });
        }

        // Notify first player's turn
        const state = await getGameState(roomId);
        if (state) {
          const firstPlayerId = state.turnOrder[0];
          await notifyTurn(io, roomId, firstPlayerId);
        }
      } catch (err) {
        console.error('[Socket] START_GAME error:', err);
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Lỗi khởi động game: ' + (err as Error).message });
      }
    });

    // ── SUBMIT CLUE ────────────────────────────────────────────────
    socket.on(SOCKET_EVENTS.SUBMIT_CLUE, async ({ content }: { content: string }) => {
      const sData = socket.data as SocketData;
      if (!sData.roomId || !sData.playerId) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Bạn chưa tham gia phòng.' });
        return;
      }

      if (!content?.trim()) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Gợi ý không được để trống.' });
        return;
      }

      const result = await submitClue(sData.roomId, sData.playerId, content.trim());
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: result.message });
        return;
      }

      const player = await prisma.player.findUnique({
        where: { id: sData.playerId },
        include: { user: true },
      });

      // Broadcast clue to room
      io.to(sData.roomId).emit(SOCKET_EVENTS.PLAYER_CLUE_SUBMITTED, {
        playerId: sData.playerId,
        displayName: player?.user.displayName,
        content: content.trim(),
      });

      if (result.votingStarted) {
        io.to(sData.roomId).emit(SOCKET_EVENTS.VOTING_PHASE_STARTED, {
          message: 'Tất cả đã đưa ra gợi ý! Bắt đầu bỏ phiếu.',
        });
      } else if (result.nextPlayerId) {
        await notifyTurn(io, sData.roomId, result.nextPlayerId);
      }
    });

    // ── SUBMIT VOTE ────────────────────────────────────────────────
    socket.on(SOCKET_EVENTS.SUBMIT_VOTE, async ({ targetPlayerId }: { targetPlayerId: string }) => {
      const sData = socket.data as SocketData;
      if (!sData.roomId || !sData.playerId) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Bạn chưa tham gia phòng.' });
        return;
      }

      const result = await submitVote(sData.roomId, sData.playerId, targetPlayerId);
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: result.message });
        return;
      }

      const state = await getGameState(sData.roomId);
      const voteCount = state ? Object.keys(state.votes).length : 0;

      io.to(sData.roomId).emit(SOCKET_EVENTS.VOTE_UPDATE, {
        voterId: sData.playerId,
        voteCount,
      });

      if (result.allVoted) {
        // Resolve votes
        const resolution = await resolveVotes(sData.roomId);

        if (resolution.eliminatedPlayerId) {
          const eliminated = await prisma.player.findUnique({
            where: { id: resolution.eliminatedPlayerId },
            include: { user: true },
          });

          io.to(sData.roomId).emit(SOCKET_EVENTS.PLAYER_ELIMINATED, {
            playerId: resolution.eliminatedPlayerId,
            displayName: eliminated?.user.displayName,
            role: resolution.eliminatedRole,
          });

          if (resolution.isWhiteHat) {
            // Tell the (now eliminated) white hat to guess
            const whiteHatSocket = await findSocketByPlayerId(io, sData.roomId, resolution.eliminatedPlayerId);
            whiteHatSocket?.emit(SOCKET_EVENTS.GUESSING_PHASE_STARTED, {
              message: 'Bạn đã bị loại! Hãy đoán từ của Dân để giành chiến thắng.',
            });
            io.to(sData.roomId).emit(SOCKET_EVENTS.GUESSING_PHASE_STARTED, {
              message: 'Mũ Trắng đang đoán từ...',
            });
            return;
          }
        } else {
          io.to(sData.roomId).emit(SOCKET_EVENTS.ROUND_RESULT, {
            message: 'Bỏ phiếu hòa! Không loại ai. Sang vòng tiếp theo.',
            eliminatedPlayerId: null,
          });
        }

        if (resolution.gameOver) {
          io.to(sData.roomId).emit(SOCKET_EVENTS.GAME_OVER, {
            winner: resolution.winner,
            message: getWinnerMessage(resolution.winner),
          });
        } else if (!resolution.isWhiteHat) {
          // Start new round
          await startNewRoundForRoom(io, sData.roomId);
        }
      }
    });

    // ── SUBMIT GUESS (White Hat after elimination) ─────────────────
    socket.on(SOCKET_EVENTS.SUBMIT_GUESS, async ({ guess }: { guess: string }) => {
      const sData = socket.data as SocketData;
      if (!sData.roomId || !sData.playerId) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Bạn chưa tham gia phòng.' });
        return;
      }

      if (!guess?.trim()) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Từ đoán không được để trống.' });
        return;
      }

      const result = await submitWhiteHatGuess(sData.roomId, sData.playerId, guess.trim());
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Không thể xử lý lượt đoán.' });
        return;
      }

      if (result.gameOver) {
        io.to(sData.roomId).emit(SOCKET_EVENTS.GAME_OVER, {
          winner: result.winner,
          message: getWinnerMessage(result.winner),
          whiteHatGuess: guess.trim(),
          correctWord: result.correctWord,
          correct: result.correct,
        });
      } else {
        io.to(sData.roomId).emit(SOCKET_EVENTS.ROUND_RESULT, {
          message: `Mũ Trắng đoán sai (đoán: "${guess}"). Từ đúng là "${result.correctWord}". Sang vòng tiếp theo.`,
          whiteHatGuess: guess.trim(),
          correctWord: result.correctWord,
        });
        await startNewRoundForRoom(io, sData.roomId);
      }
    });
  });

  return io;
}

// ── Helpers ────────────────────────────────────────────────────────

async function handleLeaveRoom(
  socket: { data: object; leave: (room: string) => void },
  io: SocketIOServer,
  userId: string,
) {
  const sData = socket.data as SocketData;
  if (!sData.roomId) return;

  const roomId = sData.roomId;
  sData.roomId = undefined;
  sData.playerId = undefined;
  (socket as unknown as { leave: (room: string) => void }).leave(roomId);

  const roomState = await getRoomState(roomId);
  if (roomState) {
    io.to(roomId).emit(SOCKET_EVENTS.ROOM_UPDATED, { room: roomState });
  }
}

async function notifyTurn(io: SocketIOServer, roomId: string, playerId: string) {
  const sockets = await io.in(roomId).fetchSockets();
  for (const s of sockets) {
    const sData = s.data as SocketData;
    if (sData.playerId === playerId) {
      s.emit(SOCKET_EVENTS.YOUR_TURN_TO_HINT, {
        message: 'Đến lượt bạn đưa ra gợi ý!',
        timeLimit: GAME_CONFIG.HINT_TIME_SECONDS,
      });
    }
  }
}

async function findSocketByPlayerId(io: SocketIOServer, roomId: string, playerId: string) {
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.find((s) => (s.data as SocketData).playerId === playerId) ?? null;
}

async function startNewRoundForRoom(io: SocketIOServer, roomId: string) {
  const state = await getGameState(roomId);
  if (!state) return;

  // Send new round info to each player
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: { where: { isActive: true }, include: { user: true } } },
  });
  if (!room) return;

  const sockets = await io.in(roomId).fetchSockets();
  for (const s of sockets) {
    const sData = s.data as SocketData;
    const player = room.players.find((p: { id: string; role: PlayerRole | null }) => p.id === sData.playerId);
    if (!player || !player.role) continue;

    const word = await getWordForPlayer(state.wordPairId, player.role);
    s.emit(SOCKET_EVENTS.ROUND_STARTED, {
      round: state.roundNumber,
      role: player.role,
      word,
      message: `Vòng ${state.roundNumber} bắt đầu!`,
    });
  }

  if (state.turnOrder.length > 0) {
    await notifyTurn(io, roomId, state.turnOrder[0]);
  }
}

function getWinnerMessage(winner?: string) {
  if (winner === 'WHITE_HAT') return '🎉 Mũ Trắng thắng! Đã đoán đúng từ của Dân.';
  if (winner === 'BLACK_HAT') return '🖤 Mũ Đen thắng! Chỉ còn 2 người chơi.';
  if (winner === 'CIVILIAN') return '👥 Dân thắng! Đã loại bỏ tất cả kẻ xâm nhập.';
  return 'Trò chơi kết thúc.';
}
