import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, newHost, publishedQuiz, launch, joinPlayer, connectHost, connectPlayer, ack, once, wait, request } from './helpers.js';

let app; let host; let admin; let models; let settings;
const A = (p) => `/api/admin${p}`;
beforeAll(async () => {
  app = await boot();
  models = await import('../src/models/index.js');
  settings = await import('../src/services/settings.js');
  const { seedStickers } = await import('../src/services/stickers.js');
  await seedStickers();
  host = await newHost(app, { fullName: 'Chat Host' });
  admin = await newHost(app, { fullName: 'Admin' });
  await models.User.updateOne({ email: admin.email }, { $set: { role: 'admin' } });
});
afterAll(async () => { await app.close(); });

const newRoom = async (n = 2) => { const q = await publishedQuiz(host, { n }); return launch(host, q.id); };
const J = async (code, nick, sticker) => { const r = await request(app.server).post(`/api/rooms/${code}/join`).send({ nickname: nick, ...(sticker ? { sticker } : {}) }); return r; };

describe('stickers and editable profiles', () => {
  it('exposes active sticker packs publicly', async () => {
    const c = (await request(app.server).get('/api/config')).body.data;
    expect(c.stickers.length).toBeGreaterThanOrEqual(4);
    expect(c.features).toMatchObject({ chat: true, stickers: true });
    expect(JSON.stringify(c)).not.toMatch(/secret|sk_test|gsk_|px_unit/);
  });
  it('gives joiners a sticker (random by default, or the one they pick) and rejects unknown ones', async () => {
    const g = await newRoom();
    const a = (await J(g.room.code, 'Auto')).body.data;
    expect(a.state.me.sticker).toBeTruthy();
    const b = await J(g.room.code, 'Picky', '🦊');
    expect(b.body.data.state.me.sticker).toBe('🦊');
    expect((await J(g.room.code, 'Bad', '💩💩💩')).status).toBe(400);
    expect((await J(g.room.code, 'Bad2', 'not-a-sticker')).body.error.code).toBe('BAD_STICKER');
  });
  it('lets players change nickname and sticker; keeps names unique; caps nickname changes', async () => {
    const g = await newRoom();
    const p = (await J(g.room.code, 'Original', '🐼')).body.data;
    await J(g.room.code, 'Taken');
    const patch = (body) => request(app.server).patch(`/api/rooms/${g.room.code}/me`).set('Authorization', `Bearer ${p.token}`).send(body);
    const ok1 = await patch({ nickname: 'Renamed', sticker: '🦁' });
    expect(ok1.status).toBe(200);
    expect(ok1.body.data.player).toMatchObject({ nickname: 'Renamed', sticker: '🦁' });
    expect((await patch({ nickname: 'taken' })).body.error.code).toBe('NICKNAME_TAKEN');
    expect((await patch({ nickname: 'Admin' })).status).toBe(400); // reserved
    expect((await patch({})).status).toBe(400);
    expect((await patch({ sticker: 'zzz' })).body.error.code).toBe('BAD_STICKER');
    expect((await patch({ role: 'host', nickname: 'x1' })).status).toBe(400); // strict
    for (let i = 0; i < 4; i++) expect((await patch({ nickname: `Name${i}` })).status).toBe(200);
    expect((await patch({ nickname: 'OneTooMany' })).body.error.code).toBe('NICK_LIMIT');
    expect((await patch({ sticker: '🐯' })).status).toBe(200); // stickers aren't capped
    const hv = (await host.get(`/api/rooms/${g.room.code}/host`)).body.data.state;
    expect(hv.players.find((x) => x.id === p.player.id)).toMatchObject({ nickname: 'Name3', sticker: '🐯' });
    // another room's token can't edit this profile
    const other = await newRoom();
    expect((await request(app.server).patch(`/api/rooms/${other.room.code}/me`).set('Authorization', `Bearer ${p.token}`).send({ nickname: 'Hax' })).status).toBe(403);
    expect((await request(app.server).patch(`/api/rooms/${g.room.code}/me`).send({ nickname: 'Anon' })).status).toBe(401);
  });
  it('hosts can pick a profile sticker', async () => {
    expect((await host.patch('/api/auth/me', { sticker: '🚀' })).body.data.user.sticker).toBe('🚀');
    expect((await host.patch('/api/auth/me', { sticker: 'nope' })).status).toBe(400);
    expect((await host.patch('/api/auth/me', { fullName: 'Chat Host' })).status).toBe(200);
  });
  it('admins manage the sticker list: disabled stickers can no longer be chosen', async () => {
    const add = await admin.post(A('/stickers'), { emoji: '🧪', label: 'Test tube', pack: 'Lab' });
    expect(add.status).toBe(201);
    expect((await admin.post(A('/stickers'), { emoji: '🧪' })).status).toBe(409);
    expect((await admin.post(A('/stickers'), { emoji: 'abc' })).status).toBe(400);
    const g = await newRoom();
    expect((await J(g.room.code, 'Chemist', '🧪')).status).toBe(201);
    await admin.patch(A(`/stickers/${add.body.data.id}`), { active: false });
    expect((await J(g.room.code, 'Chemist2', '🧪')).body.error.code).toBe('BAD_STICKER');
    expect((await request(app.server).get('/api/config')).body.data.stickers.flatMap((p) => p.items).some((i) => i.emoji === '🧪')).toBe(false);
    expect((await host.get(A('/stickers'))).status).toBe(403);
    expect((await admin.delete(A(`/stickers/${add.body.data.id}`))).status).toBe(200);
  });
  it('a global switch turns stickers off everywhere', async () => {
    await admin.put(A('/settings'), { features: { stickers: false } });
    settings.resetSettingsCache();
    const g = await newRoom();
    const p = (await J(g.room.code, 'Plain', '🦊')).body.data;
    expect(p.state.me.sticker).toBe('');
    expect(p.state.features.stickers).toBe(false);
    expect((await request(app.server).patch(`/api/rooms/${g.room.code}/me`).set('Authorization', `Bearer ${p.token}`).send({ sticker: '🦊' })).body.error.code).toBe('STICKERS_OFF');
    await admin.put(A('/settings'), { features: { stickers: true } });
  });
});

describe('leaderboard rows carry what changed (for the animation)', () => {
  it('includes delta, prevScore and prevRank that reconcile with the new standings', async () => {
    const g = await newRoom(2);
    const ann = (await J(g.room.code, 'Ann')).body.data; const bo = (await J(g.room.code, 'Bo')).body.data;
    const hs = await connectHost(app, host); await ack(hs, 'host:join', { roomCode: g.room.code });
    const sa = await connectPlayer(app, g.room.code, ann.token); const sb = await connectPlayer(app, g.room.code, bo.token);
    const cmd = (action) => ack(hs, 'host:command', { action });
    await cmd('start');
    await ack(sa, 'answer:submit', { questionIndex: 0, optionKey: 'A' }); await ack(sb, 'answer:submit', { questionIndex: 0, optionKey: 'B' }); // Ann right (A), Bo wrong
    await wait(300);
    await cmd('leaderboard');
    await models.Player.updateOne({ _id: ann.player.id }, { $set: { score: 100 } }); // Ann leads narrowly going into Q2
    await cmd('next');
    await ack(sa, 'answer:submit', { questionIndex: 1, optionKey: 'A' }); await ack(sb, 'answer:submit', { questionIndex: 1, optionKey: 'B' }); // Q2 correct is B: Bo right, Ann wrong
    await wait(300);
    const lb = once(sb, 'leaderboard:updated');
    await cmd('leaderboard');
    const rows = (await lb).leaderboard;
    for (const r of rows) {
      expect(r.prevScore).toBe(r.score - r.delta);
      expect(r).toHaveProperty('prevRank');
      expect(r).toHaveProperty('sticker');
    }
    const a = rows.find((r) => r.nickname === 'Ann'); const b = rows.find((r) => r.nickname === 'Bo');
    expect(a.delta).toBe(0); expect(b.delta).toBeGreaterThan(900);
    expect(a.prevRank).toBe(1); expect(b.prevRank).toBe(2); // before Q2: Ann led
    expect(b.rank).toBe(1); expect(a.rank).toBe(2);        // after Q2: Bo overtook (the animation's whole point)
    expect(b.score).toBeGreaterThan(a.score);
    hs.disconnect(); sa.disconnect(); sb.disconnect();
  });
});

describe('host question visibility', () => {
  it('hides only the prompt and image from players while preserving choices and answers', async () => {
    const g = await newRoom(1);
    const player = (await J(g.room.code, 'Question Player')).body.data;
    await models.Room.updateOne({ _id: g.room.id }, { $set: { 'snapshot.questions.0.imageUrl': 'https://example.test/question.png' } });
    const hs = await connectHost(app, host);
    await ack(hs, 'host:join', { roomCode: g.room.code });
    const ps = await connectPlayer(app, g.room.code, player.token);
    const restored = (await request(app.server).get(`/api/rooms/${g.room.code}/state`).set('X-Player-Token', player.token)).body.data;
    expect(restored.showQuestionsToPlayers).toBe(true);

    const hidden = await ack(hs, 'host:question-visibility', { showQuestionsToPlayers: false });
    expect(hidden.ok).toBe(true);
    expect(hidden.data.showQuestionsToPlayers).toBe(false);
    expect((await ack(hs, 'chat:mode', { mode: 'off' })).ok).toBe(true);
    const chatOff = (await request(app.server).get(`/api/rooms/${g.room.code}/state`).set('X-Player-Token', player.token)).body.data;
    expect(chatOff.showQuestionsToPlayers).toBe(false);
    expect(chatOff.chat).toMatchObject({ available: true, enabled: false, mode: 'off' });
    expect((await ack(hs, 'chat:mode', { mode: 'between' })).ok).toBe(true);

    const started = once(ps, 'question:started');
    expect((await ack(hs, 'host:command', { action: 'start' })).ok).toBe(true);
    const question = await started;
    expect(question).toMatchObject({ text: '', imageUrl: null, showQuestionsToPlayers: false });
    expect(question.options).toHaveLength(4);
    expect((await ack(ps, 'answer:submit', { questionIndex: 0, optionKey: 'A' })).ok).toBe(true);

    const playerState = (await request(app.server).get(`/api/rooms/${g.room.code}/state`).set('X-Player-Token', player.token)).body.data;
    expect(playerState.question).toMatchObject({ text: '', imageUrl: null });
    expect(playerState.question.options).toHaveLength(4);
    expect((await ack(hs, 'host:question-visibility', { showQuestionsToPlayers: true })).error.code).toBe('ILLEGAL_TRANSITION');
    expect((await ack(hs, 'host:question-visibility', { showQuestionsToPlayers: 'true' })).ok).toBe(false);
    hs.disconnect();
    ps.disconnect();
  });
});

describe('chat', () => {
  let g; let p1; let p2; let hs; let s1; let s2;
  const send = (s, text) => ack(s, 'chat:send', { text });

  it('opens in the lobby: host and players talk, everyone receives it, late joiners get history', async () => {
    g = await newRoom(2);
    p1 = (await J(g.room.code, 'Alice')).body.data; p2 = (await J(g.room.code, 'Bob')).body.data;
    hs = await connectHost(app, host);
    const hist = once(hs, 'chat:history');
    await ack(hs, 'host:join', { roomCode: g.room.code });
    expect(await hist).toEqual([]);
    s1 = await connectPlayer(app, g.room.code, p1.token); s2 = await connectPlayer(app, g.room.code, p2.token);
    const got = [once(hs, 'chat:message'), once(s2, 'chat:message'), once(s1, 'chat:message')];
    const r = await send(s1, 'Hello everyone!');
    expect(r.ok).toBe(true);
    const [m1, m2] = await Promise.all(got);
    expect(m1).toMatchObject({ text: 'Hello everyone!', nickname: 'Alice', authorType: 'player' });
    expect(m2.id).toBe(m1.id);
    await wait(800);
    const hostMsg = once(s2, 'chat:message');
    expect((await send(hs, 'Welcome, quiz starts soon')).ok).toBe(true);
    expect((await hostMsg)).toMatchObject({ authorType: 'host', nickname: 'Chat Host' });
    const late = (await J(g.room.code, 'Carol')).body.data;
    const h2 = once((await connectPlayer(app, g.room.code, late.token)), 'chat:history').catch(() => null);
    expect((await h2).map((m) => m.text)).toEqual(['Hello everyone!', 'Welcome, quiz starts soon']);
    expect(await models.ChatMessage.countDocuments({ roomId: g.room.id })).toBe(2); // persisted
  });
  it('validates and sanitises messages, masks blocked words, and rate-limits', async () => {
    await wait(800);
    expect((await send(s1, '   ')).error.code).toBe('EMPTY_MESSAGE');
    expect((await send(s1, 'x'.repeat(201))).error.code).toBe('MESSAGE_TOO_LONG');
    expect((await ack(s1, 'chat:send', { text: 'hi', extra: 1 })).error.code).toBe('VALIDATION_ERROR');
    await admin.put(A('/settings'), { chat: { blockedWords: ['badword'] } }); settings.resetSettingsCache();
    const echoed = once(s2, 'chat:message');
    await send(s1, 'you BadWord person\u202e<b>hi</b>');
    const m = await echoed;
    expect(m.text).toBe('you ••••••• person<b>hi</b>'); // masked; bidi override stripped; React escapes the tags on render
    const quick = await send(s1, 'too fast');
    expect(quick.error.code).toBe('CHAT_COOLDOWN');
    await admin.put(A('/settings'), { chat: { blockedWords: [] } });
  });
  it('lets the host mute a player, delete a message and change the mode; players cannot', async () => {
    await wait(800);
    await expect(s1.timeout(400).emitWithAck('chat:mute', { playerId: p2.player.id, muted: true })).rejects.toThrow(); // no handler for players
    const muted = once(s2, 'chat:muted');
    expect((await ack(hs, 'chat:mute', { playerId: p2.player.id, muted: true })).ok).toBe(true);
    expect((await muted).muted).toBe(true);
    expect((await send(s2, 'can you hear me')).error.code).toBe('MUTED');
    await ack(hs, 'chat:mute', { playerId: p2.player.id, muted: false });
    await wait(800);
    const msg = once(s1, 'chat:message'); await send(s2, 'delete me soon'); const m = await msg;
    const del = once(s1, 'chat:deleted');
    expect((await ack(hs, 'chat:delete', { id: m.id })).ok).toBe(true);
    expect((await del).id).toBe(m.id);
    expect((await models.ChatMessage.findById(m.id)).deleted).toBe(true);
    expect((await ack(hs, 'chat:delete', { id: m.id })).error.code).toBe('NOT_FOUND');
    expect((await ack(hs, 'chat:mode', { mode: 'banana' })).ok).toBe(false);
  });
  it('pauses player chat while a question is live ("between" mode) but never silences the host', async () => {
    await wait(800);
    expect((await ack(hs, 'host:command', { action: 'start' })).ok).toBe(true);
    expect((await send(s1, 'the answer is B')).error.code).toBe('CHAT_PAUSED');
    await wait(800);
    expect((await send(hs, 'Ten seconds left!')).ok).toBe(true);
    const view = (await request(app.server).get(`/api/rooms/${g.room.code}/state`).set('Authorization', `Bearer ${p1.token}`)).body.data;
    expect(view.chat).toMatchObject({ enabled: true, mode: 'between', paused: true });
    // switch to "on": players can chat during questions
    expect((await ack(hs, 'chat:mode', { mode: 'on' })).ok).toBe(true);
    await wait(800);
    expect((await send(s1, 'chat is open')).ok).toBe(true);
    // off
    const modeEvt = once(s1, 'chat:mode');
    await ack(hs, 'chat:mode', { mode: 'off' });
    expect((await modeEvt).enabled).toBe(false);
    await wait(800);
    expect((await send(s1, 'hello?')).error.code).toBe('CHAT_OFF');
    expect((await send(hs, 'hello?')).error.code).toBe('CHAT_OFF');
  });
  it('a global switch disables chat; other hosts and other rooms are isolated', async () => {
    const other = await newHost(app);
    const os = await connectHost(app, other);
    expect((await ack(os, 'host:join', { roomCode: g.room.code })).ok).toBe(false);
    expect((await ack(os, 'chat:send', { text: 'hi' })).error.code).toBe('NOT_JOINED'); // never joined, can't speak in someone else's room
    expect((await ack(os, 'chat:mode', { mode: 'on' })).ok).toBe(false);
    os.disconnect();
    await ack(hs, 'chat:mode', { mode: 'on' });
    await admin.put(A('/settings'), { features: { chat: false } }); settings.resetSettingsCache();
    await wait(800);
    expect((await send(s1, 'still there?')).error.code).toBe('CHAT_DISABLED');
    const g2 = await newRoom();
    expect((await models.Room.findOne({ code: g2.room.code })).chatMode).toBe('off');
    await admin.put(A('/settings'), { features: { chat: true } }); settings.resetSettingsCache();
  });
  it('admins can read a room’s chat log, delete messages and mute players, all audited', async () => {
    const log = (await admin.get(A(`/rooms/${g.room.code}/chat`))).body.data;
    expect(log.length).toBeGreaterThanOrEqual(4);
    expect(log.some((m) => m.deleted)).toBe(true);
    const target = log.find((m) => !m.deleted && m.authorType === 'player');
    expect((await admin.delete(A(`/rooms/${g.room.code}/chat/${target.id}`))).status).toBe(200);
    expect((await admin.post(A(`/rooms/${g.room.code}/players/${p1.player.id}/mute`), { muted: true })).status).toBe(200);
    expect((await models.Player.findById(p1.player.id)).muted).toBe(true);
    expect((await host.get(A(`/rooms/${g.room.code}/chat`))).status).toBe(403);
    const audit = (await admin.get(A('/audit?limit=50'))).body.data.items.map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['chat.delete', 'player.mute', 'settings.update', 'sticker.add']));
  });
  it('chat closes when the game ends', async () => {
    await admin.post(A(`/rooms/${g.room.code}/end`), { reason: 'done' });
    await wait(800);
    expect(['CHAT_CLOSED', 'PLAYER_SESSION_INVALID']).toContain((await send(s2, 'bye')).error.code); // players' sessions are wiped when a game is ended
    expect((await send(hs, 'bye')).error.code).toBe('CHAT_CLOSED');
    for (const s of [hs, s1, s2]) s.disconnect();
  });
});
