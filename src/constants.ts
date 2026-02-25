export const GAME_CONFIG = {
  MIN_PLAYERS: 4,
  MAX_PLAYERS: 8,
  WHITE_HAT_MIN_PLAYERS: 6, // White Hat only appears when > 5 players
  HINT_TIME_SECONDS: 60,    // Time per player to give a clue
  VOTE_TIME_SECONDS: 60,    // Time for voting phase
  ROOM_CODE_LENGTH: 6,
  MAX_ACTIVE_ROOMS: 100,         // Hard cap on simultaneously active rooms in Redis
  ROOM_STATE_TTL_SECONDS: 86400, // Rooms expire after 24h of inactivity
} as const;

export const SOCKET_EVENTS = {
  // Client -> Server
  CREATE_ROOM: 'room:create',
  JOIN_ROOM: 'room:join',
  LEAVE_ROOM: 'room:leave',
  START_GAME: 'game:start',
  SUBMIT_CLUE: 'game:submit_clue',
  SUBMIT_VOTE: 'game:submit_vote',
  SUBMIT_GUESS: 'game:submit_guess', // White hat's final guess

  // Server -> Client
  ROOM_UPDATED: 'room:updated',
  GAME_STARTED: 'game:started',
  ROUND_STARTED: 'round:started',
  PLAYER_CLUE_SUBMITTED: 'round:clue_submitted',
  YOUR_TURN_TO_HINT: 'round:your_turn',
  VOTING_PHASE_STARTED: 'round:voting_started',
  VOTE_UPDATE: 'round:vote_update',
  PLAYER_ELIMINATED: 'round:player_eliminated',
  GUESSING_PHASE_STARTED: 'round:guessing_started',
  ROUND_RESULT: 'round:result',
  GAME_OVER: 'game:over',
  ERROR: 'error',
} as const;
