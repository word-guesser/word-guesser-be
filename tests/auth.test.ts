/**
 * Auth API Integration Tests
 * Tests: GET /auth/me — valid token, missing token, invalid token
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  startTestServer, stopTestServer, getTestServerUrl,
  createTestUser, cleanupTestData,
  type TestUser,
} from './helpers';

let user: TestUser;

beforeAll(async () => {
  await startTestServer();
  user = await createTestUser('auth-1');
});

afterAll(async () => {
  await cleanupTestData([user.id]);
  await stopTestServer();
});

describe('GET /auth/me', () => {
  it('trả về thông tin user với token hợp lệ', async () => {
    const res = await request(getTestServerUrl())
      .get('/auth/me')
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    });
  });

  it('trả về 401 khi không có token', async () => {
    const res = await request(getTestServerUrl()).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.message).toBeTruthy();
  });

  it('trả về 401 khi token không hợp lệ', async () => {
    const res = await request(getTestServerUrl())
      .get('/auth/me')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.status).toBe(401);
  });

  it('GET /auth/google redirect đến Google OAuth URL', async () => {
    const res = await request(getTestServerUrl())
      .get('/auth/google')
      .redirects(0);
    // Should redirect (302) to accounts.google.com
    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('accounts.google.com');
  });
});
