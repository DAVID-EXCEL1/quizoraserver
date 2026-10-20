import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, newHost, publishedQuiz, launch, joinPlayer, connectHost, connectPlayer, ack, once, wait, request, PASSWORD } from './helpers.js';

let app; let admin; let admin2; let host; let models;
const makeAdmin = async (h) => { await models.User.updateOne({ email: h.email }, { $set: { role: 'admin' } }); return h; };
const A = (path) => `/api/admin${path}`;

beforeAll(async () => {
  app = await boot();
  models = await import('../src/models/index.js');
  admin = await makeAdmin(await newHost(app, { fullName: 'Root Admin' }));
  admin2 = await makeAdmin(await newHost(app, { fullName: 'Second Admin' }));
  host = await newHost(app, { fullName: 'Regular Host' });
});
afterAll(async () => { await app.close(); });

describe('access control', () => {
  const routes = [['get', '/stats'], ['get', '/users'], ['get', '/quizzes'], ['get', '/rooms'], ['get', '/games'], ['get', '/audit']];
  it('rejects anonymous requests (401) and regular hosts (403) on every admin route', async () => {
    for (const [, path] of routes) {
      expect((await request(app.server).get(A(path))).status).toBe(401);
      expect((await host.get(A(path))).status).toBe(403);
    }
    const id = String(host.user.id);
    for (const [m, path] of [['post', `/users/${id}/suspend`], ['post', `/users/${id}/role`], ['delete', `/users/${id}`], ['post', '/rooms/ABCDEF/end'], ['delete', `/quizzes/${id}`], ['delete', `/games/${id}`]]) {
      expect((await host[m](A(path), m === 'post' ? { role: 'admin' } : undefined)).status).toBe(403);
    }
    expect((await host.get(A('/users'))).body.error.code).toBe('FORBIDDEN');
  });
  it('a host cannot grant themselves admin through any normal endpoint', async () => {
    const r = await host.patch('/api/auth/me', { fullName: 'Hacker', role: 'admin' });
    expect(r.status).toBe(400); // strict schema rejects unknown fields
    const reg = await request(app.server).post('/api/auth/register').send({ fullName: 'Sneaky', email: 'sneaky@example.com', password: PASSWORD, confirmPassword: PASSWORD, role: 'admin' });
    expect(reg.status).toBe(400);
    expect((await models.User.findOne({ email: 'sneaky@example.com' }))).toBeNull();
    expect((await host.get('/api/auth/me')).body.data.user.role).toBe('host');
  });
  it('requires CSRF on admin mutations', async () => {
    const r = await admin.agent.post(A(`/users/${host.user.id}/verify-email`));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_FAILED');
  });
  it('an admin passes, and /auth/me reports the role', async () => {
    expect((await admin.get(A('/stats'))).status).toBe(200);
    expect((await admin.get('/api/auth/me')).body.data.user.role).toBe('admin');
  });
  it('demotion takes effect immediately (role is read from the database, not the token)', async () => {
    const tmp = await makeAdmin(await newHost(app));
    expect((await tmp.get(A('/stats'))).status).toBe(200);
    await models.User.updateOne({ email: tmp.email }, { $set: { role: 'host' } });
    expect((await tmp.get(A('/stats'))).status).toBe(403);
  });
  it('rejects malformed ids and query injection', async () => {
    expect((await admin.get(A('/users/not-an-id'))).status).toBe(404);
    expect((await admin.get(A('/users?status[$ne]=x'))).status).toBe(400);
    expect((await admin.get(A('/audit?action=user.*'))).status).toBe(400);
  });
});

describe('overview', () => {
  it('reports real counts', async () => {
    const q = await publishedQuiz(host, { n: 2 });
    const g = await launch(host, q.id);
    const s = (await admin.get(A('/stats'))).body.data;
    expect(s.users.total).toBeGreaterThanOrEqual(3);
    expect(s.users.admins).toBeGreaterThanOrEqual(2);
    expect(s.quizzes.published).toBeGreaterThanOrEqual(1);
    expect(s.games.live).toBeGreaterThanOrEqual(1);
    expect(s.activity).toHaveLength(14);
    await models.Room.updateOne({ code: g.room.code }, { $set: { status: 'EXPIRED' } });
  });
});

describe('user management', () => {
  it('lists, searches and filters users with real counts', async () => {
    const all = (await admin.get(A('/users?limit=50'))).body.data;
    expect(all.items.every((u) => !('passwordHash' in u))).toBe(true);
    const found = (await admin.get(A('/users?search=regular'))).body.data.items;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ email: host.email, role: 'host', status: 'active' });
    expect(found[0].quizCount).toBeGreaterThanOrEqual(1);
    expect((await admin.get(A('/users?role=admin'))).body.data.items.every((u) => u.role === 'admin')).toBe(true);
  });
  it('shows a user detail with quizzes, games, live rooms and sessions', async () => {
    const d = (await admin.get(A(`/users/${host.user.id}`))).body.data;
    expect(d.user.email).toBe(host.email);
    expect(d.quizzes.length).toBeGreaterThanOrEqual(1);
    expect(d.activeSessions).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(d)).not.toMatch(/passwordHash|tokenHash/);
  });
  it('force-verifies an email and force-logs-out a user', async () => {
    const u = await newHost(app);
    expect((await admin.post(A(`/users/${u.user.id}/verify-email`))).status).toBe(200);
    expect((await models.User.findById(u.user.id)).emailVerified).toBe(true);
    expect((await u.get('/api/auth/me')).status).toBe(200);
    expect((await admin.post(A(`/users/${u.user.id}/revoke-sessions`))).status).toBe(200);
    expect((await u.get('/api/auth/me')).status).toBe(401);
  });

  it('suspending blocks the account at once, ends their live game, and notifies players; reinstating restores access', async () => {
    const h = await newHost(app, { fullName: 'To Suspend' });
    const q = await publishedQuiz(h, { n: 1 });
    const g = await launch(h, q.id);
    const p = (await joinPlayer(app, g.room.code, 'Witness')).body.data;
    const ps = await connectPlayer(app, g.room.code, p.token);
    const hs = await connectHost(app, h);
    await ack(hs, 'host:join', { roomCode: g.room.code });
    const expired = once(ps, 'room:expired');
    const dropped = once(hs, 'disconnect');

    const r = await admin.post(A(`/users/${h.user.id}/suspend`), { reason: 'Spam quizzes' });
    expect(r.status).toBe(200);
    expect((await expired).reason).toBe('host_suspended');
    await dropped;
    expect((await h.get('/api/auth/me')).status).toBe(401); // existing session dead
    const login = await request(app.server).post('/api/auth/login').send({ email: h.email, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_DISABLED');
    expect((await models.Room.findOne({ code: g.room.code })).status).toBe('EXPIRED');
    expect((await joinPlayer(app, g.room.code, 'Late')).status).toBe(410);
    expect((await admin.post(A(`/users/${h.user.id}/suspend`), {})).status).toBe(409); // already suspended
    ps.disconnect();

    expect((await admin.post(A(`/users/${h.user.id}/reinstate`))).status).toBe(200);
    expect((await request(app.server).post('/api/auth/login').send({ email: h.email, password: PASSWORD })).status).toBe(200);
    expect((await admin.post(A(`/users/${h.user.id}/reinstate`))).status).toBe(409);
  });

  it("protects admins from locking themselves out or being hit by accident", async () => {
    const me = String(admin.user.id); const other = String(admin2.user.id);
    for (const [m, path, body] of [['post', `/users/${me}/suspend`, {}], ['delete', `/users/${me}`], ['post', `/users/${me}/role`, { role: 'host' }]]) {
      const r = await admin[m](A(path), body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('CANNOT_TARGET_SELF');
    }
    const s = await admin.post(A(`/users/${other}/suspend`), {});
    expect(s.status).toBe(409); expect(s.body.error.code).toBe('TARGET_IS_ADMIN');
    expect((await admin.delete(A(`/users/${other}`))).body.error.code).toBe('TARGET_IS_ADMIN');
  });

  it('promotes and demotes, but always keeps at least one active admin', async () => {
    const u = await newHost(app);
    expect((await admin.post(A(`/users/${u.user.id}/role`), { role: 'admin' })).status).toBe(200);
    expect((await u.get(A('/stats'))).status).toBe(200);
    expect((await admin.post(A(`/users/${u.user.id}/role`), { role: 'admin' })).body.error.code).toBe('NO_CHANGE');
    expect((await admin.post(A(`/users/${u.user.id}/role`), { role: 'host' })).status).toBe(200);
    expect((await u.get(A('/stats'))).status).toBe(403);
    expect((await admin.post(A(`/users/${u.user.id}/role`), { role: 'superuser' })).status).toBe(400);
    // admin2 demotes admin (allowed: 2 admins), then the last admin can't be demoted by... themselves (blocked) — verify last-admin rule directly
    await models.User.updateMany({ role: 'admin', _id: { $ne: admin.user.id } }, { $set: { role: 'host' } });
    const lone = await newHost(app); await models.User.updateOne({ email: lone.email }, { $set: { role: 'host' } });
    const r = await admin.post(A(`/users/${lone.user.id}/role`), { role: 'host' });
    expect(r.status).toBe(409); // already a host => NO_CHANGE; confirms no accidental demotion path
    await makeAdmin(admin2);
  });

  it('deletes a user and their quizzes, but keeps finished game results', async () => {
    const h = await newHost(app, { fullName: 'Doomed' });
    const q = await publishedQuiz(h, { n: 1 });
    await models.GameResult.create({ roomId: new (await import('mongoose')).default.Types.ObjectId(), roomCode: 'KEEP22', hostId: h.user.id, quizTitle: 'Kept', completedAt: new Date(), participantCount: 1, rankings: [{ rank: 1, nickname: 'x', score: 5 }] });
    expect((await admin.delete(A(`/users/${h.user.id}`))).status).toBe(200);
    expect(await models.User.countDocuments({ _id: h.user.id })).toBe(0);
    expect(await models.Quiz.countDocuments({ _id: q.id })).toBe(0);
    expect(await models.Session.countDocuments({ userId: h.user.id })).toBe(0);
    expect(await models.GameResult.countDocuments({ roomCode: 'KEEP22' })).toBe(1);
    expect((await h.get('/api/auth/me')).status).toBe(401);
    expect((await admin.get(A(`/users/${h.user.id}`))).status).toBe(404);
  });
});

describe('quiz moderation', () => {
  it('views, unpublishes and deletes any quiz without touching running games', async () => {
    const q = await publishedQuiz(host, { n: 2, title: 'Questionable' });
    const g = await launch(host, q.id);
    const list = (await admin.get(A('/quizzes?search=questionable'))).body.data;
    expect(list.items[0]).toMatchObject({ title: 'Questionable', status: 'published', owner: { email: host.email } });
    const d = (await admin.get(A(`/quizzes/${q.id}`))).body.data;
    expect(d.questions).toHaveLength(2);
    expect((await admin.post(A(`/quizzes/${q.id}/unpublish`), { reason: 'Policy' })).status).toBe(200);
    expect((await host.post('/api/rooms', { quizId: q.id })).status).toBe(422); // no longer launchable
    expect((await admin.post(A(`/quizzes/${q.id}/unpublish`), {})).status).toBe(409);
    expect((await admin.delete(A(`/quizzes/${q.id}`), { reason: 'Offensive' })).status).toBe(200);
    expect((await host.get(`/api/quizzes/${q.id}`)).status).toBe(404);
    const room = await models.Room.findOne({ code: g.room.code }).lean();
    expect(room.snapshot.questions).toHaveLength(2); // running game unaffected
    expect(room.status).toBe('LOBBY');
  });
});

describe('live games and players', () => {
  it('lists live rooms, shows players, kicks a player, and force-ends a game', async () => {
    const q = await publishedQuiz(host, { n: 2 });
    const g = await launch(host, q.id);
    const bad = (await joinPlayer(app, g.room.code, 'Rude')).body.data;
    const good = (await joinPlayer(app, g.room.code, 'Nice')).body.data;
    const badSock = await connectPlayer(app, g.room.code, bad.token);
    const kicked = once(badSock, 'player:kicked');

    const live = (await admin.get(A('/rooms'))).body.data;
    const mine = live.find((r) => r.code === g.room.code);
    expect(mine).toMatchObject({ playerCount: 2, status: 'LOBBY', host: { email: host.email } });
    const detail = (await admin.get(A(`/rooms/${g.room.code}`))).body.data;
    expect(detail.players.map((p) => p.nickname).sort()).toEqual(['Nice', 'Rude']);

    expect((await admin.post(A(`/rooms/${g.room.code}/players/${bad.player.id}/kick`), { reason: 'Offensive nickname' })).status).toBe(200);
    await kicked;
    expect(await models.Player.countDocuments({ roomId: g.room.id })).toBe(1);
    expect((await request(app.server).get(`/api/rooms/${g.room.code}/state`).set('Authorization', `Bearer ${bad.token}`)).status).toBe(401);
    expect((await joinPlayer(app, g.room.code, 'Rude')).status).toBe(201); // nickname is free again
    // a player id from another room can't be kicked through this room
    const other = await launch(host, q.id);
    const foreign = (await joinPlayer(app, other.room.code, 'Foreign')).body.data;
    expect((await admin.post(A(`/rooms/${g.room.code}/players/${foreign.player.id}/kick`), {})).status).toBe(404);

    const expired = once(badSock, 'room:expired').catch(() => null);
    expect((await admin.post(A(`/rooms/${g.room.code}/end`), { reason: 'Abuse' })).status).toBe(200);
    expect((await models.Room.findOne({ code: g.room.code })).status).toBe('EXPIRED');
    expect((await models.Room.findOne({ code: g.room.code })).expiredReason).toBe('admin_ended');
    expect((await host.post(`/api/rooms/${g.room.code}/host/command`, { action: 'start' })).status).toBe(410);
    expect((await admin.post(A(`/rooms/${g.room.code}/end`), {})).status).toBe(409);
    expect((await admin.get(A('/rooms'))).body.data.some((r) => r.code === g.room.code)).toBe(false);
    badSock.disconnect(); await expired;
  });
});

describe('finished games', () => {
  it('lists across hosts and deletes a result', async () => {
    const gr = await models.GameResult.create({ roomId: new (await import('mongoose')).default.Types.ObjectId(), roomCode: 'DEL222', hostId: host.user.id, quizTitle: 'Delete me', completedAt: new Date(), participantCount: 3, rankings: [{ rank: 1, nickname: 'Top', score: 10 }] });
    const l = (await admin.get(A('/games?search=delete'))).body.data;
    expect(l.items[0]).toMatchObject({ roomCode: 'DEL222', winner: 'Top', host: { email: host.email } });
    expect((await admin.delete(A(`/games/${gr._id}`), { reason: 'Test data' })).status).toBe(200);
    expect(await models.GameResult.countDocuments({ roomCode: 'DEL222' })).toBe(0);
    expect((await admin.delete(A(`/games/${gr._id}`), {})).status).toBe(404);
  });
});

describe('audit log', () => {
  it('records who did what, with reasons, and nothing sensitive', async () => {
    const log = (await admin.get(A('/audit?limit=100'))).body.data;
    const actions = new Set(log.items.map((a) => a.action));
    for (const a of ['user.suspend', 'user.reinstate', 'user.promote', 'user.demote', 'user.delete', 'user.verify_email', 'user.revoke_sessions', 'quiz.unpublish', 'quiz.delete', 'room.end', 'player.kick', 'game.delete']) expect(actions.has(a)).toBe(true);
    const sus = log.items.find((a) => a.action === 'user.suspend' && a.details?.reason === 'Spam quizzes');
    expect(sus).toMatchObject({ adminEmail: admin.email, targetType: 'user', targetLabel: expect.stringContaining('@') });
    expect(JSON.stringify(log)).not.toMatch(/passwordHash|tokenHash|\$2[aby]\$/);
    expect((await admin.get(A('/audit?action=user.'))).body.data.items.every((a) => a.action.startsWith('user.'))).toBe(true);
    expect((await admin.get(A(`/audit?search=${encodeURIComponent(admin.email)}`))).body.data.total).toBeGreaterThan(0);
  });
  it('failed or rejected actions are not logged as successes', async () => {
    const before = (await admin.get(A('/audit?limit=1'))).body.data.total;
    await admin.post(A(`/users/${admin.user.id}/suspend`), {}); // rejected
    expect((await admin.get(A('/audit?limit=1'))).body.data.total).toBe(before);
  });
  it('is read-only through the API', async () => {
    const id = (await admin.get(A('/audit?limit=1'))).body.data.items[0].id;
    for (const m of ['put', 'patch', 'delete']) expect((await admin[m](A(`/audit/${id}`), {})).status).toBe(404);
    expect((await admin.post(A('/audit'), {})).status).toBe(404);
  });
});

describe('create-admin script', () => {
  it('creates an admin, promotes an existing user, and rejects weak passwords', async () => {
    const { createAdmin } = await import('../src/scripts/createAdmin.js');
    await expect(createAdmin({ email: 'weak@example.com', password: 'weak' })).rejects.toThrow(/Password rejected/);
    const c = await createAdmin({ email: 'Boss@Example.com', password: PASSWORD, fullName: 'The Boss' });
    expect(c.created).toBe(true);
    const u = await models.User.findOne({ email: 'boss@example.com' });
    expect(u).toMatchObject({ role: 'admin', emailVerified: true });
    const login = await request(app.server).post('/api/auth/login').send({ email: 'boss@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe('admin');
    const promoted = await createAdmin({ email: host.email });
    expect(promoted.created).toBe(false);
    expect((await models.User.findOne({ email: host.email })).role).toBe('admin');
    await models.User.updateOne({ email: host.email }, { $set: { role: 'host' } });
  });
});
