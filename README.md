# 🎮 Word Guesser — Trò Chơi Đoán Từ Multiplayer

A Vietnamese multiplayer word-guessing game backend (inspired by Undercover/Mr. White).

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Realtime**: Socket.io (WebSocket)
- **Database**: PostgreSQL via Prisma ORM
- **Auth**: Google OAuth2 (Passport.js + JWT)
- **AI**: Google Gemini API (word pair generation)

## Quick Start

### 1. Prerequisites
- Node.js 18+
- PostgreSQL database
- Google OAuth credentials
- Gemini API key

### 2. Setup

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate

# Seed initial word pairs
npm run db:seed

# Start development server
npm run dev
```

## Environment Variables

See [`.env.example`](.env.example) for all required variables.

## Game Flow

### Roles
| Role | Tiếng Việt | Description |
|------|-----------|-------------|
| `CIVILIAN` | Dân | Knows word A |
| `BLACK_HAT` | Mũ Đen | Knows word B |
| `WHITE_HAT` | Mũ Trắng | Knows nothing (only when >5 players) |

### Turn Phases
1. **HINTING** — Each player gives a 60-second clue about their word
2. **VOTING** — Players vote to eliminate someone
3. **GUESSING** — If White Hat is eliminated, they guess Civilian's word
4. **RESULT** — Round ends, next round starts

### Win Conditions
- 🎉 **Mũ Trắng wins**: Correctly guesses Civilian's word after elimination
- 🖤 **Mũ Đen wins**: Only 2 players remain
- 👥 **Dân wins**: Both Black Hat and White Hat are eliminated

## API Documentation

### REST Endpoints

#### Auth
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/google` | Initiate Google OAuth |
| `GET` | `/auth/google/callback` | OAuth callback |
| `GET` | `/auth/me` | Get current user |

#### Rooms
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/rooms` | Create a room |
| `POST` | `/rooms/join` | Join room by code |
| `GET` | `/rooms/:id` | Get room info |
| `DELETE` | `/rooms/:id/leave` | Leave room |

#### Words
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/words` | List word pairs |
| `GET` | `/words/categories` | List categories |
| `POST` | `/words` | Add a word pair |
| `POST` | `/words/generate` | AI-generate a word pair |
| `DELETE` | `/words/:id` | Remove a word pair |

### WebSocket Events

#### Client → Server
```
room:join          { roomId }
room:leave         {}
game:start         { roomId }
game:submit_clue   { content }
game:submit_vote   { targetPlayerId }
game:submit_guess  { guess }
```

#### Server → Client
```
room:updated           { room }
game:started           { room }
round:started          { round, role, word, message }
round:your_turn        { message, timeLimit }
round:clue_submitted   { playerId, displayName, content }
round:voting_started   { message }
round:vote_update      { voterId, voteCount }
round:player_eliminated { playerId, displayName, role }
round:guessing_started  { message }
round:result           { message, ... }
game:over              { winner, message }
error                  { message }
```
