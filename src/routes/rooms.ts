import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware } from '../middleware/auth';
import {
  getRoomState,
  setRoomState,
  deleteRoomState,
  deleteRoomCodeMapping,
  setRoomCodeMapping,
  getActiveRoomCount,
  trackActiveRoom,
} from '../services/gameService';
import { GAME_CONFIG } from '../constants';

const router = Router();

router.use(authMiddleware);

/** Generate a random uppercase room code */
function generateRoomCode(length = GAME_CONFIG.ROOM_CODE_LENGTH): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// POST /rooms — Create a new room
router.post('/', async (req: Request, res: Response) => {
  const user = req.currentUser!;

  // ── Guard: room quantity limit ──
  const activeCount = await getActiveRoomCount();
  if (activeCount >= GAME_CONFIG.MAX_ACTIVE_ROOMS) {
    res.status(503).json({ message: 'Hệ thống đang có quá nhiều phòng. Vui lòng thử lại sau.' });
    return;
  }

  // Generate unique 6-char code
  let code: string;
  let attempts = 0;
  do {
    code = generateRoomCode();
    attempts++;
    const existing = await prisma.room.findUnique({ where: { code } });
    if (!existing) break;
  } while (attempts < 10);

  // ── DB: create room + host player (for match history reference) ──
  const room = await prisma.room.create({
    data: { code: code!, hostId: user.id, status: 'WAITING', maxPlayers: GAME_CONFIG.MAX_PLAYERS },
  });

  const player = await prisma.player.create({ data: { userId: user.id, roomId: room.id } });

  // ── Redis: cache room state + register code mapping + track in set ──
  const roomState = {
    id: room.id,
    code: room.code,
    hostId: room.hostId,
    status: 'WAITING' as const,
    maxPlayers: room.maxPlayers,
    players: [
      {
        id: player.id,
        userId: user.id,
        displayName: user.displayName,
        avatar: user.avatar ?? null,
        isActive: true,
        isHost: true,
        role: null,
      },
    ],
  };

  await setRoomState(roomState);
  await setRoomCodeMapping(room.code, room.id);
  await trackActiveRoom(room.id);

  res.status(201).json({ message: 'Tạo phòng thành công.', room: roomState });
});

// POST /rooms/join — Join a room by code
router.post('/join', async (req: Request, res: Response) => {
  const { code } = req.body as { code: string };
  const user = req.currentUser!;

  if (!code) {
    res.status(400).json({ message: 'Vui lòng nhập mã phòng.' });
    return;
  }

  // ── DB: look up room by code + active players ──
  const room = await prisma.room.findUnique({
    where: { code: code.toUpperCase() },
    include: { players: { where: { isActive: true } } },
  });

  if (!room) {
    res.status(404).json({ message: 'Phòng không tồn tại.' });
    return;
  }
  if (room.status !== 'WAITING') {
    res.status(400).json({ message: 'Phòng đang chơi, không thể tham gia.' });
    return;
  }
  if (room.players.length >= room.maxPlayers) {
    res.status(400).json({ message: 'Phòng đã đầy.' });
    return;
  }

  // Check if already in room (DB is source of truth for player records)
  const existing = await prisma.player.findUnique({
    where: { userId_roomId: { userId: user.id, roomId: room.id } },
  });

  let playerId: string;
  if (existing) {
    if (!existing.isActive) {
      await prisma.player.update({ where: { id: existing.id }, data: { isActive: true } });
    }
    playerId = existing.id;
  } else {
    const player = await prisma.player.create({ data: { userId: user.id, roomId: room.id } });
    playerId = player.id;
  }

  // ── Redis: update user in cached room state ──
  const roomState = await getRoomState(room.id);
  if (roomState) {
    const alreadyIn = roomState.players.find((p) => p.userId === user.id);
    if (!alreadyIn) {
      roomState.players.push({
        id: playerId,
        userId: user.id,
        displayName: user.displayName,
        avatar: user.avatar ?? null,
        isActive: true,
        isHost: false,
        role: null,
      });
    } else {
      alreadyIn.isActive = true;
    }
    await setRoomState(roomState);
  }

  const state = await getRoomState(room.id);
  res.json({ message: 'Tham gia phòng thành công.', room: state });
});

// GET /rooms/:id — Get room info
router.get('/:id', async (req: Request, res: Response) => {
  const roomState = await getRoomState(req.params.id);
  if (!roomState) {
    res.status(404).json({ message: 'Phòng không tồn tại.' });
    return;
  }
  res.json({ room: roomState });
});

// DELETE /rooms/:id/leave — Leave a room
router.delete('/:id/leave', async (req: Request, res: Response) => {
  const user = req.currentUser!;

  const room = await prisma.room.findUnique({ where: { id: req.params.id } });
  if (!room) {
    res.status(404).json({ message: 'Phòng không tồn tại.' });
    return;
  }

  const player = await prisma.player.findUnique({
    where: { userId_roomId: { userId: user.id, roomId: room.id } },
  });
  if (!player) {
    res.status(400).json({ message: 'Bạn không ở trong phòng này.' });
    return;
  }

  // ── DB: mark player inactive ──
  await prisma.player.update({ where: { id: player.id }, data: { isActive: false } });

  // ── Redis: remove player from room state ──
  const roomState = await getRoomState(room.id);
  if (roomState) {
    const p = roomState.players.find((pl) => pl.userId === user.id);
    if (p) p.isActive = false;
  }

  // If host leaves during WAITING → reassign or close
  if (room.hostId === user.id && room.status === 'WAITING') {
    const nextPlayer = await prisma.player.findFirst({
      where: { roomId: room.id, isActive: true, userId: { not: user.id } },
      orderBy: { joinedAt: 'asc' },
    });

    if (nextPlayer) {
      await prisma.room.update({ where: { id: room.id }, data: { hostId: nextPlayer.userId } });
      // ── Redis: reflect new host in room state ──
      if (roomState) {
        roomState.hostId = nextPlayer.userId;
        roomState.players.forEach((p) => { p.isHost = p.userId === nextPlayer.userId; });
        await setRoomState(roomState);
      }
    } else {
      // Last person left → close room
      await prisma.room.update({ where: { id: room.id }, data: { status: 'FINISHED' } });
      await deleteRoomState(room.id);
      await deleteRoomCodeMapping(room.code);
    }
  } else if (roomState) {
    await setRoomState(roomState);
  }

  res.json({ message: 'Rời phòng thành công.' });
});

export default router;
