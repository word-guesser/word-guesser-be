/**
 * Rooms API Integration Tests
 * Tests: POST /rooms, POST /rooms/join, GET /rooms/:id, DELETE /rooms/:id/leave
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  startTestServer, stopTestServer, getTestServerUrl,
  createTestUser, cleanupTestData,
  type TestUser,
} from './helpers';

let host: TestUser;
let guest: TestUser;
const userIds: string[] = [];

beforeAll(async () => {
  await startTestServer();
  host = await createTestUser('room-host');
  guest = await createTestUser('room-guest');
  userIds.push(host.id, guest.id);
});

afterAll(async () => {
  await cleanupTestData(userIds);
  await stopTestServer();
});

describe('POST /rooms — Tạo phòng', () => {
  it('tạo phòng mới thành công với token hợp lệ', async () => {
    const res = await request(getTestServerUrl())
      .post('/rooms')
      .set('Authorization', `Bearer ${host.token}`);

    expect(res.status).toBe(201);
    expect(res.body.room).toMatchObject({
      code: expect.stringMatching(/^[A-Z0-9]{6}$/),
      hostId: host.id,
      status: 'WAITING',
      maxPlayers: 8,
    });
    expect(res.body.room.players).toHaveLength(1);
    expect(res.body.room.players[0].userId).toBe(host.id);
  });

  it('trả về 401 khi không có token', async () => {
    const res = await request(getTestServerUrl()).post('/rooms');
    expect(res.status).toBe(401);
  });
});

describe('POST /rooms/join — Tham gia phòng', () => {
  let roomCode: string;
  let roomId: string;

  beforeAll(async () => {
    const res = await request(getTestServerUrl())
      .post('/rooms')
      .set('Authorization', `Bearer ${host.token}`);
    roomCode = res.body.room.code;
    roomId = res.body.room.id;
  });

  it('tham gia phòng thành công với mã hợp lệ', async () => {
    const res = await request(getTestServerUrl())
      .post('/rooms/join')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ code: roomCode });

    expect(res.status).toBe(200);
    expect(res.body.room.players).toHaveLength(2);
  });

  it('trả về 404 với mã phòng không tồn tại', async () => {
    const res = await request(getTestServerUrl())
      .post('/rooms/join')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ code: 'XXXXXX' });

    expect(res.status).toBe(404);
  });

  it('trả về 400 khi không gửi mã phòng', async () => {
    const res = await request(getTestServerUrl())
      .post('/rooms/join')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('host tham gia lại phòng của mình không tạo thêm player record', async () => {
    const res = await request(getTestServerUrl())
      .post('/rooms/join')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ code: roomCode });

    // Should succeed (idempotent) but still only 2 players
    expect(res.status).toBe(200);
    const activePlayers = res.body.room.players.filter((p: { isActive: boolean }) => p.isActive);
    expect(activePlayers.length).toBeLessThanOrEqual(2);
  });

  describe('GET /rooms/:id', () => {
    it('trả về thông tin phòng với ID hợp lệ', async () => {
      const res = await request(getTestServerUrl())
        .get(`/rooms/${roomId}`)
        .set('Authorization', `Bearer ${host.token}`);

      expect(res.status).toBe(200);
      expect(res.body.room.id).toBe(roomId);
      expect(res.body.room.code).toBe(roomCode);
    });

    it('trả về 404 với ID phòng không tồn tại', async () => {
      const res = await request(getTestServerUrl())
        .get('/rooms/non-existent-room-id')
        .set('Authorization', `Bearer ${host.token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /rooms/:id/leave', () => {
    it('guest rời phòng thành công', async () => {
      const res = await request(getTestServerUrl())
        .delete(`/rooms/${roomId}/leave`)
        .set('Authorization', `Bearer ${guest.token}`);

      expect(res.status).toBe(200);
    });

    it('host rời phòng khi không còn player → phòng đóng', async () => {
      const res = await request(getTestServerUrl())
        .delete(`/rooms/${roomId}/leave`)
        .set('Authorization', `Bearer ${host.token}`);

      expect(res.status).toBe(200);

      // Room should now be FINISHED
      const checkRes = await request(getTestServerUrl())
        .get(`/rooms/${roomId}`)
        .set('Authorization', `Bearer ${host.token}`);

      // Either 404 (no room) or FINISHED status
      if (checkRes.status === 200) {
        expect(checkRes.body.room.status).toBe('FINISHED');
      } else {
        expect(checkRes.status).toBe(404);
      }
    });
  });
});
