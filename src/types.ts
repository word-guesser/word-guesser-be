import { PlayerRole } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  googleId: string;
  email: string;
  displayName: string;
  avatar?: string | null;
}

export interface JwtPayload {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
}

export interface RoomPlayer {
  id: string;     // Player record id
  userId: string;
  displayName: string;
  avatar?: string | null;
  isActive: boolean;
  isHost: boolean;
  role?: PlayerRole | null;
}

export interface RoomState {
  id: string;
  code: string;
  hostId: string;
  status: string;
  maxPlayers: number;
  players: RoomPlayer[];
}

export interface GameState {
  roomId: string;
  roundNumber: number;
  phase: string;
  turnOrder: string[];    // Player IDs in order
  currentTurnIndex: number;
  clues: ClueRecord[];
  votes: Record<string, string>; // voterId -> targetId
  eliminatedPlayers: string[];
  wordPairId: string;
}

export interface ClueRecord {
  playerId: string;
  displayName: string;
  content: string;
  createdAt: Date;
}

// Socket data attached after auth middleware
export interface SocketData {
  user: AuthenticatedUser;
  roomId?: string;
  playerId?: string;
}
