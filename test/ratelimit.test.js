import { describe, it, expect, beforeAll, afterAll } from 'vitest';

process.env.RATE_LIMIT_DISABLED = 'false'; // this file exercises the real limiters
const { boot, newHost, publishedQuiz, launch, request, joinPlayer } = await import('./helpers.js');

let app;
beforeAll(async () => { app = await boot(); });
afterAll(async () => { await app.close(); });

describe('rate limiting', () => {
  it('limits PIN lookups (brute-force of room PINs)', async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await request(app.server).get('/api/rooms/AAAAAA/public');
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
  it('limits join attempts', async () => {
    const host = await newHost(app);
    const q = await publishedQuiz(host, { n: 1 });
    const g = await launch(host, q.id);
    const codes = [];
    for (let i = 0; i < 25; i++) codes.push((await joinPlayer(app, g.room.code, `Player${i}`)).status);
    expect(codes).toContain(429);
  });
  it('limits login attempts per IP', async () => {
    const codes = [];
    for (let i = 0; i < 35; i++) codes.push((await request(app.server).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'x' })).status);
    expect(codes).toContain(429);
  });
});
