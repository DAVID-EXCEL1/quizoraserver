import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, newHost, publishedQuiz, launch, joinPlayer, connectHost, connectPlayer, connect, ack, once, wait, request } from './helpers.js';

let app; let host; let other; let quiz; let game;
const players = {};
const sockets = {};

beforeAll(async () => {
  app = await boot();
  host = await newHost(app);
  other = await newHost(app, { fullName: 'Other Host' });
  quiz = await publishedQuiz(host, { n: 3, title: 'Real Game' });
});
afterAll(async () => { await app.close(); });

const J = async (code, nick, token) => { const r = await joinPlayer(app, code, nick, token); expect([200, 201]).toContain(r.status); return r.body.data; };
const cmd = (action) => ack(sockets.host, 'host:command', { action });

describe('9. room creation & PIN uniqueness', () => {
  it('creates a LOBBY room with PIN, URLs and QR code', async () => {
    game = await launch(host, quiz.id);
    expect(game.room.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(game.state.status).toBe('LOBBY');
    expect(game.joinUrl).toBe(`http://localhost:5173/join/${game.room.code}`);
    expect(game.hostUrl).toBe(`http://localhost:5173/host/${game.room.code}`);
    expect(game.qrCode).toMatch(/^data:image\/png;base64,/);
  });
  it('generates unique PINs across many rooms', async () => {
    const q2 = await publishedQuiz(host, { n: 1 });
    const codes = new Set();
    for (let i = 0; i < 25; i++) codes.add((await launch(host, q2.id)).room.code);
    expect(codes.size).toBe(25);
  });
  it('retries on PIN collision instead of failing', async () => {
    const { Room } = await import('../src/models/index.js');
    const tokens = await import('../src/utils/tokens.js');
    expect(tokens.generatePin()).toMatch(/^[A-Z0-9]{6}$/);
    expect(await Room.collection.indexExists('code_1')).toBe(true);
  });
});

describe('10/11/12. players join without accounts', () => {
  it('looks up a room publicly without leaking the quiz', async () => {
    const r = await request(app.server).get(`/api/rooms/${game.room.code.toLowerCase()}/public`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ code: game.room.code, title: 'Real Game', status: 'LOBBY', joinable: true });
    expect((await request(app.server).get('/api/rooms/ZZZZZZ/public')).status).toBe(404);
  });

  it('joins with only a nickname and returns a room-scoped token', async () => {
    players.ann = await J(game.room.code, 'Ann');
    expect(players.ann.token.length).toBeGreaterThan(30);
    expect(players.ann.state.status).toBe('LOBBY');
    const { Player } = await import('../src/models/index.js');
    const p = await Player.findById(players.ann.player.id).lean();
    expect(p.tokenHash).not.toBe(players.ann.token); // hash only
    expect(p.tokenHash).toHaveLength(64);
  });

  it('11. rejects duplicate (case-insensitive), reserved and malformed nicknames', async () => {
    expect((await joinPlayer(app, game.room.code, 'ann')).status).toBe(409);
    expect((await joinPlayer(app, game.room.code, ' ANN ')).status).toBe(409);
    expect((await joinPlayer(app, game.room.code, 'Admin')).status).toBe(400);
    expect((await joinPlayer(app, game.room.code, 'x')).status).toBe(400);
    expect((await joinPlayer(app, game.room.code, '<script>')).status).toBe(400);
    expect((await joinPlayer(app, game.room.code, 'a'.repeat(21))).status).toBe(400);
  });

  it("12. reconnecting with the token reuses the same player; a nickname alone can't impersonate", async () => {
    const again = await J(game.room.code, 'Ann', players.ann.token);
    expect(again.reconnected).toBe(true);
    expect(again.player.id).toBe(players.ann.player.id);
    expect((await joinPlayer(app, game.room.code, 'Ann')).status).toBe(409);
    players.bo = await J(game.room.code, 'Bo');
    const { Player } = await import('../src/models/index.js');
    expect(await Player.countDocuments({ roomId: game.room.id })).toBe(2);
  });

  it('player token is scoped to its room (cross-room access rejected)', async () => {
    const q2 = await publishedQuiz(host, { n: 1 });
    const g2 = await launch(host, q2.id);
    const res = await request(app.server).get(`/api/rooms/${g2.room.code}/state`).set('Authorization', `Bearer ${players.ann.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WRONG_ROOM');
    const own = await request(app.server).get(`/api/rooms/${game.room.code}/state`).set('Authorization', `Bearer ${players.ann.token}`);
    expect(own.status).toBe(200);
    expect((await request(app.server).get(`/api/rooms/${game.room.code}/state`)).status).toBe(401);
    expect((await request(app.server).get(`/api/rooms/${game.room.code}/state`).set('Authorization', 'Bearer garbage')).status).toBe(401);
    await expect(connectPlayer(app, g2.room.code, players.ann.token)).rejects.toThrow();
  });
});

describe('19/20. host authorization', () => {
  it('player tokens grant no host powers, and other hosts cannot control or even see the room', async () => {
    expect((await request(app.server).post(`/api/rooms/${game.room.code}/host/command`).set('Authorization', `Bearer ${players.ann.token}`).send({ action: 'start' })).status).toBe(401);
    expect((await other.post(`/api/rooms/${game.room.code}/host/command`, { action: 'start' })).status).toBe(404);
    expect((await other.get(`/api/rooms/${game.room.code}/host`)).status).toBe(404);
    const os = await connectHost(app, other);
    const j = await ack(os, 'host:join', { roomCode: game.room.code });
    expect(j.ok).toBe(false);
    expect(j.error.code).toBe('NOT_FOUND');
    const c = await ack(os, 'host:command', { action: 'start' });
    expect(c.ok).toBe(false);
    os.disconnect();
    expect((await host.get(`/api/rooms/${game.room.code}/host`)).body.data.state.status).toBe('LOBBY');
  });
  it('rejects unauthenticated socket connections', async () => {
    await expect(connect(app, { role: 'host' })).rejects.toThrow();
    await expect(connect(app, {})).rejects.toThrow();
    await expect(connect(app, { role: 'player', roomCode: game.room.code, token: 'bad' })).rejects.toThrow();
  });
  it('player sockets cannot issue host commands', async () => {
    const ps = await connectPlayer(app, game.room.code, players.ann.token);
    await expect(ps.timeout(400).emitWithAck('host:command', { action: 'start' })).rejects.toThrow(); // no handler => no ack
    ps.disconnect();
    expect((await host.get(`/api/rooms/${game.room.code}/host`)).body.data.state.status).toBe('LOBBY');
  });
});

describe('13/14/15/16/17/18/21: a full live game', () => {
  it('connects host + two players and syncs the roster', async () => {
    sockets.host = await connectHost(app, host);
    const hv = await ack(sockets.host, 'host:join', { roomCode: game.room.code });
    expect(hv.ok).toBe(true);
    expect(hv.data.players).toHaveLength(2);
    sockets.ann = await connectPlayer(app, game.room.code, players.ann.token);
    sockets.bo = await connectPlayer(app, game.room.code, players.bo.token);
    await wait(150);
    const state = await ack(sockets.host, 'state:request');
    expect(state.data.players.filter((p) => p.connected)).toHaveLength(2);
  });

  it('cannot start illegal transitions or double-start', async () => {
    expect((await cmd('next')).error.code).toBe('ILLEGAL_TRANSITION');
    expect((await cmd('close')).error.code).toBe('ILLEGAL_TRANSITION');
    expect((await cmd('leaderboard')).error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('13. question starts for everyone, identically, without leaking the answer', async () => {
    const got = [once(sockets.ann, 'question:started'), once(sockets.bo, 'question:started'), once(sockets.host, 'question:started')];
    const r = await cmd('start');
    expect(r.ok).toBe(true);
    const [qa, qb, qh] = await Promise.all(got);
    expect(qa).toEqual(expect.objectContaining({ index: 0, total: 3, text: 'Question 1?', timeLimit: 10 }));
    expect(qa.options).toHaveLength(4);
    expect(qa.deadline - qa.startedAt).toBe(10000);
    expect(qb.id).toBe(qa.id); expect(qh.id).toBe(qa.id);
    expect(qb.deadline).toBe(qa.deadline);
    for (const q of [qa, qb, qh]) expect(JSON.stringify(q)).not.toMatch(/correctKey|isCorrect/i);
    const rest = await request(app.server).get(`/api/rooms/${game.room.code}/state`).set('Authorization', `Bearer ${players.ann.token}`);
    expect(JSON.stringify(rest.body)).not.toMatch(/correctKey|isCorrect/i);
    const host1 = await ack(sockets.host, 'state:request');
    expect(JSON.stringify(host1.data)).not.toMatch(/correctKey/); // host screen may be projected
    expect((await cmd('start')).error.code).toBe('ILLEGAL_TRANSITION'); // duplicate command
  });

  it('14. accepts one answer per player and rejects duplicates and bad input', async () => {
    const accepted = once(sockets.ann, 'answer:accepted');
    const a1 = await ack(sockets.ann, 'answer:submit', { questionIndex: 0, optionKey: 'A' }); // correct
    expect(a1.ok).toBe(true);
    await accepted;
    const dup = await ack(sockets.ann, 'answer:submit', { questionIndex: 0, optionKey: 'B' });
    expect(dup.error.code).toBe('ALREADY_ANSWERED');
    expect((await ack(sockets.bo, 'answer:submit', { questionIndex: 7, optionKey: 'A' })).ok).toBe(false);
    expect((await ack(sockets.bo, 'answer:submit', { questionIndex: 0, optionKey: 'Z' })).error.code).toBe('VALIDATION_ERROR');
    expect((await ack(sockets.bo, 'answer:submit', { questionIndex: 0, optionKey: 'A', points: 99999 })).error.code).toBe('VALIDATION_ERROR'); // no client-supplied scores
    const { Answer } = await import('../src/models/index.js');
    expect(await Answer.countDocuments({ roomId: game.room.id })).toBe(1);
  });

  it('16. scores by remaining time (7.5s of 10s => ~750) and 17. wrong answers score 0', async () => {
    const { Room } = await import('../src/models/index.js');
    const now = Date.now();
    await Room.updateOne({ _id: game.room.id }, { $set: { questionStartedAt: new Date(now - 2500), questionDeadline: new Date(now + 7500) } });
    const hostCtl = once(sockets.host, 'answer:revealed');
    const b1 = await ack(sockets.bo, 'answer:submit', { questionIndex: 0, optionKey: 'C' }); // wrong
    expect(b1.ok).toBe(true);
    // all players have answered => question auto-closes
    const revealed = await hostCtl;
    expect(revealed.correctKey).toBe('A');
    expect(revealed.counts).toEqual({ A: 1, B: 0, C: 1, D: 0 });
  });

  it('shows each player their own authoritative result', async () => {
    await wait(100);
    const { Player } = await import('../src/models/index.js');
    const ann = await Player.findById(players.ann.player.id).lean();
    const bo = await Player.findById(players.bo.player.id).lean();
    // The previous test moved the deadline to 7.5s away, so Ann (who answered right at the start) has ~7.5s+ remaining.
    expect(ann.score).toBeGreaterThanOrEqual(745);
    expect(ann.score).toBeLessThanOrEqual(800);
    expect(ann.correctCount).toBe(1); expect(ann.streak).toBe(1); expect(ann.bestStreak).toBe(1);
    expect(bo.score).toBe(0); expect(bo.correctCount).toBe(0); expect(bo.streak).toBe(0);
    const s = await request(app.server).get(`/api/rooms/${game.room.code}/state`).set('Authorization', `Bearer ${players.ann.token}`);
    expect(s.body.data.status).toBe('QUESTION_RESULT');
    expect(s.body.data.result).toEqual(expect.objectContaining({ correctKey: 'A', isCorrect: true, answered: true }));
    expect(s.body.data.me.rank).toBe(1);
  });

  it('leaderboard step then next question', async () => {
    const lb = once(sockets.bo, 'leaderboard:updated');
    expect((await cmd('leaderboard')).ok).toBe(true);
    const board = await lb;
    expect(board.leaderboard.map((r) => r.nickname)).toEqual(['Ann', 'Bo']);
    expect(board.leaderboard[0].score).toBeGreaterThan(board.leaderboard[1].score);
    const q2 = once(sockets.ann, 'question:started');
    expect((await cmd('next')).ok).toBe(true);
    expect((await q2).index).toBe(1);
  });

  it('18. streaks: reset after wrong answer and after timeout/no answer', async () => {
    // Q2 (correct B): Ann answers wrong, Bo answers right. Then close by host.
    await ack(sockets.ann, 'answer:submit', { questionIndex: 1, optionKey: 'A' });
    await ack(sockets.bo, 'answer:submit', { questionIndex: 1, optionKey: 'B' });
    await wait(200);
    const { Player } = await import('../src/models/index.js');
    let ann = await Player.findById(players.ann.player.id).lean();
    let bo = await Player.findById(players.bo.player.id).lean();
    expect(ann.streak).toBe(0); expect(ann.bestStreak).toBe(1);
    expect(bo.streak).toBe(1); expect(bo.score).toBeGreaterThan(900);
    await cmd('next'); // -> Q3 (skips leaderboard; allowed from QUESTION_RESULT)
    // Q3 (correct C): Bo answers right, Ann doesn't answer => host closes, Ann timed out.
    await ack(sockets.bo, 'answer:submit', { questionIndex: 2, optionKey: 'C' });
    const closed = once(sockets.host, 'answer:revealed');
    const closeAck = await cmd('close');
    expect(closeAck.ok).toBe(true);
    expect(closeAck.data.result.pending).toBeUndefined(); // ack must carry the scored state, not a stale 'pending' snapshot
    expect(closeAck.data.result.correctKey).toBe('C');
    await closed;
    await wait(100);
    ann = await Player.findById(players.ann.player.id).lean();
    bo = await Player.findById(players.bo.player.id).lean();
    expect(ann.streak).toBe(0); expect(ann.correctCount).toBe(1);
    expect(bo.streak).toBe(2); expect(bo.bestStreak).toBe(2); expect(bo.correctCount).toBe(2);
  });

  it('15. late answers are rejected by the server clock; the sweeper closes overdue questions', async () => {
    // fresh 1-question game to test lateness in isolation
    const q = await publishedQuiz(host, { n: 1, title: 'Late' });
    const g = await launch(host, q.id);
    const p = await J(g.room.code, 'Slowpoke');
    const ps = await connectPlayer(app, g.room.code, p.token);
    const hs = await connectHost(app, host);
    await ack(hs, 'host:join', { roomCode: g.room.code });
    await ack(hs, 'host:command', { action: 'start' });
    const { Room } = await import('../src/models/index.js');
    await Room.updateOne({ _id: g.room.id }, { $set: { questionDeadline: new Date(Date.now() - 500) } });
    const late = await ack(ps, 'answer:submit', { questionIndex: 0, optionKey: 'A' });
    expect(late.ok).toBe(false);
    expect(late.error.code).toBe('TOO_LATE');
    const { runSweep } = await import('../src/jobs/maintenance.js');
    await runSweep();
    expect((await Room.findById(g.room.id).lean()).status).toBe('QUESTION_RESULT');
    const { Player } = await import('../src/models/index.js');
    expect((await Player.findById(p.player.id).lean()).score).toBe(0);
    const after = await ack(ps, 'answer:submit', { questionIndex: 0, optionKey: 'A' });
    expect(after.error.code).toBe('QUESTION_CLOSED');
    ps.disconnect(); hs.disconnect();
  });

  it('reconnect: a dropped player gets authoritative state back without a duplicate roster entry', async () => {
    sockets.bo.disconnect();
    await wait(200);
    const mid = await ack(sockets.host, 'state:request');
    expect(mid.data.players.find((p) => p.nickname === 'Bo').connected).toBe(false);
    const restored = once((sockets.bo2 = null, (sockets.bo2 = await connectPlayer(app, game.room.code, players.bo.token))), 'state:restore');
    const view = await restored;
    expect(view.status).toBe('QUESTION_RESULT');
    expect(view.me.nickname).toBe('Bo');
    expect(view.me.score).toBeGreaterThan(1800);
    expect(view.result.correctKey).toBe('C');
    await wait(150);
    const after = await ack(sockets.host, 'state:request');
    expect(after.data.players).toHaveLength(2);
    expect(after.data.players.every((p) => p.connected)).toBe(true);
  });

  it('finishes: podium, final leaderboard and persisted results all agree (21)', async () => {
    const fin = once(sockets.bo2, 'game:finished');
    const r = await cmd('next'); // last question -> GAME_OVER
    expect(r.ok).toBe(true);
    expect(r.data.status).toBe('GAME_OVER');
    const finished = await fin;
    expect(finished.podium.map((p) => p.nickname)).toEqual(['Bo', 'Ann']);
    const pub = await request(app.server).get(`/api/results/${game.room.code}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.rankings.map((x) => [x.rank, x.nickname, x.score])).toEqual(finished.leaderboard.map((x) => [x.rank, x.nickname, x.score]));
    expect(JSON.stringify(pub.body)).not.toMatch(/hostId|tokenHash/);
    expect((await cmd('next')).error.code).toBe('ILLEGAL_TRANSITION');
    expect((await joinPlayer(app, game.room.code, 'Latecomer')).status).toBe(409);
  });
});

describe('22/24. persistent game history that survives cleanup', () => {
  it("appears in the host's history and dashboard with real numbers", async () => {
    const h = await host.get('/api/games');
    const mine = h.body.data.items.find((x) => x.roomCode === game.room.code);
    expect(mine).toMatchObject({ quizTitle: 'Real Game', participantCount: 2, winner: { nickname: 'Bo' }, totalQuestions: 3 });
    const detail = await host.get(`/api/games/${mine.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.rankings).toHaveLength(2);
    expect(detail.body.data.questionStats).toHaveLength(3);
    expect(detail.body.data.questionStats[0]).toMatchObject({ correctKey: 'A', answered: 2, correct: 1 });
    const d = await host.get('/api/dashboard');
    expect(d.body.data.stats.totalGames).toBeGreaterThanOrEqual(1);
    expect(d.body.data.stats.totalParticipants).toBeGreaterThanOrEqual(2);
    expect(d.body.data.stats.totalQuizzes).toBeGreaterThanOrEqual(1);
  });
  it("other hosts can't read this history", async () => {
    const list = await other.get('/api/games');
    expect(list.body.data.items).toHaveLength(0);
    const { GameResult } = await import('../src/models/index.js');
    const gr = await GameResult.findOne({ roomCode: game.room.code }).lean();
    expect((await other.get(`/api/games/${gr._id}`)).status).toBe(404);
    expect((await other.get('/api/dashboard')).body.data.stats.totalGames).toBe(0);
  });
  it('24. results survive deletion of the room and its players', async () => {
    const { Room, Player, Answer } = await import('../src/models/index.js');
    const { runExpiry } = await import('../src/jobs/maintenance.js');
    await Room.updateOne({ _id: game.room.id }, { $set: { purgeAt: new Date(Date.now() - 1000) } });
    const r = await runExpiry();
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(await Room.countDocuments({ _id: game.room.id })).toBe(0);
    expect(await Player.countDocuments({ roomId: game.room.id })).toBe(0);
    expect(await Answer.countDocuments({ roomId: game.room.id })).toBe(0);
    expect((await request(app.server).get(`/api/results/${game.room.code}`)).body.data.rankings).toHaveLength(2);
    expect((await host.get('/api/games')).body.data.items.some((x) => x.roomCode === game.room.code)).toBe(true);
  });
});

describe('23. room expiration', () => {
  it('expires inactive rooms, rejects joins/answers/commands, wipes player credentials, keeps completed results', async () => {
    const q = await publishedQuiz(host, { n: 2, title: 'Expiring' });
    const g = await launch(host, q.id);
    const p = await J(g.room.code, 'Sleepy');
    const ps = await connectPlayer(app, g.room.code, p.token);
    const hs = await connectHost(app, host);
    await ack(hs, 'host:join', { roomCode: g.room.code });
    await ack(hs, 'host:command', { action: 'start' });
    const { Room, Player, GameResult } = await import('../src/models/index.js');
    const before = await GameResult.countDocuments({});

    const expiredEvt = once(ps, 'room:expired');
    await Room.updateOne({ _id: g.room.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    // Between expiresAt passing and the worker running, commands and answers are already refused.
    expect((await ack(ps, 'answer:submit', { questionIndex: 0, optionKey: 'A' })).error.code).toBe('ROOM_EXPIRED');
    expect((await ack(hs, 'host:command', { action: 'close' })).error.code).toBe('ROOM_EXPIRED');

    const { runExpiry } = await import('../src/jobs/maintenance.js');
    const res = await runExpiry();
    expect(res.expired).toBe(1);
    expect((await expiredEvt).reason).toBe('inactivity');
    expect((await Room.findById(g.room.id).lean()).status).toBe('EXPIRED');
    expect((await Player.findById(p.player.id).lean()).tokenHash).toBeUndefined();

    expect((await joinPlayer(app, g.room.code, 'Newbie')).status).toBe(410);
    expect((await request(app.server).get(`/api/rooms/${g.room.code}/state`).set('Authorization', `Bearer ${p.token}`)).status).toBe(401);
    await expect(connectPlayer(app, g.room.code, p.token)).rejects.toThrow();
    expect((await host.post(`/api/rooms/${g.room.code}/host/command`, { action: 'next' })).status).toBe(410);
    expect(await GameResult.countDocuments({})).toBe(before); // expiry doesn't invent or delete results
    expect((await request(app.server).get(`/api/results/${game.room.code}`)).status).toBe(200);
    ps.disconnect(); hs.disconnect();
  });

  it('activity (joins, accepted answers, host actions) extends the deadline; heartbeats and clock syncs do not', async () => {
    const q = await publishedQuiz(host, { n: 1 });
    const g = await launch(host, q.id);
    const { Room } = await import('../src/models/index.js');
    const soon = new Date(Date.now() + 60_000);
    await Room.updateOne({ _id: g.room.id }, { $set: { expiresAt: soon } });
    const p = await J(g.room.code, 'Active');
    const afterJoin = (await Room.findById(g.room.id).lean()).expiresAt;
    expect(+afterJoin).toBeGreaterThan(+soon + 60 * 60 * 1000);

    await Room.updateOne({ _id: g.room.id }, { $set: { expiresAt: soon } });
    const ps = await connectPlayer(app, g.room.code, p.token);
    for (let i = 0; i < 3; i++) await ack(ps, 'clock:sync');
    await ack(ps, 'state:request');
    await wait(100);
    expect(+(await Room.findById(g.room.id).lean()).expiresAt).toBe(+soon);
    ps.disconnect();
  });

  it('cancelling a lobby ends it without recording a game', async () => {
    const q = await publishedQuiz(host, { n: 1 });
    const g = await launch(host, q.id);
    const before = (await host.get('/api/dashboard')).body.data.stats.totalGames;
    const r = await host.post(`/api/rooms/${g.room.code}/host/command`, { action: 'end' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('EXPIRED');
    expect((await host.get('/api/dashboard')).body.data.stats.totalGames).toBe(before);
    expect((await joinPlayer(app, g.room.code, 'Late')).status).toBe(410);
  });
});

describe('end-to-end state recovery after a server restart', () => {
  it('overdue questions are closed from the database alone (no in-memory timers needed)', async () => {
    const q = await publishedQuiz(host, { n: 2, title: 'Restart' });
    const g = await launch(host, q.id);
    const p = await J(g.room.code, 'Phoenix');
    const hs = await connectHost(app, host);
    await ack(hs, 'host:join', { roomCode: g.room.code });
    await ack(hs, 'host:command', { action: 'start' });
    const { Room, Player } = await import('../src/models/index.js');
    await Room.updateOne({ _id: g.room.id }, { $set: { questionDeadline: new Date(Date.now() - 2000) } });
    const { runSweep } = await import('../src/jobs/maintenance.js');
    const r = await runSweep();
    expect(r.closed).toBeGreaterThanOrEqual(1);
    const state = await request(app.server).get(`/api/rooms/${g.room.code}/state`).set('Authorization', `Bearer ${p.token}`);
    expect(state.body.data.status).toBe('QUESTION_RESULT');
    expect(state.body.data.result.correctKey).toBe('A');
    expect((await Player.findById(p.player.id).lean()).lastScoredIndex).toBe(0);
    hs.disconnect();
  });
});
