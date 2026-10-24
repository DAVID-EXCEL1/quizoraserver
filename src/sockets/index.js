import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { log } from '../utils/logger.js';
import { setIo, toGame, toHostCtl } from './broadcast.js';
import { socketAllow } from '../middleware/rateLimit.js';
import { toErrorBody } from '../middleware/errorHandler.js';
import { AppError, unauthorized } from '../utils/errors.js';
import { normalizePin } from '../utils/tokens.js';
import { verifyAccessToken, userFromAccessPayload, familyActive } from '../services/authService.js';
import { authenticatePlayerToken, markConnection, broadcastRoster } from '../services/playerService.js';
import { getOwnedRoom } from '../services/roomService.js';
import { hostView, playerView } from '../services/views.js';
import * as game from '../services/gameService.js';
import { User } from '../models/index.js';
import { answerSchema, hostActionSchema, questionVisibilitySchema } from '../validators/game.js';
import * as chat from '../services/chatService.js';
import { z } from 'zod';
import { objectId } from '../validators/common.js';

const chatText = z.object({ text: z.string().max(1000) }).strict();
import { pin } from '../validators/common.js';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
  }
  return out;
}

/** Wrap a handler so it always answers its ack with {ok,data} or {ok:false,error}. */
const handle = (fn) => async (...args) => {
  const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
  try {
    ack({ ok: true, data: await fn(...args) });
  } catch (err) {
    const mapped = toErrorBody(err);
    if (!mapped) log.error('socket handler', err?.message);
    ack({ ok: false, error: mapped ? mapped.body : { code: 'INTERNAL', message: 'Something went wrong' } });
  }
};

async function attachRedisAdapter(io) {
  if (!env.redisUrl) return;
  try {
    const [{ createAdapter }, { createClient }] = await Promise.all([import('@socket.io/redis-adapter'), import('redis')]);
    const pub = createClient({ url: env.redisUrl });
    const sub = pub.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    log.info('Socket.IO Redis adapter enabled');
  } catch (err) {
    log.error('REDIS_URL is set but the adapter could not start (npm i @socket.io/redis-adapter redis):', err.message);
  }
}

export function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.allowedOrigins, credentials: true },
    allowRequest: (req, cb) => {
      const o = req.headers.origin;
      cb(null, !o || env.allowedOrigins.includes(o.replace(/\/+$/, '')));
    },
    maxHttpBufferSize: 10_000,
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });
  setIo(io);
  attachRedisAdapter(io);

  // Authentication happens at the handshake. A socket id or room PIN proves nothing.
  io.use(async (socket, next) => {
    try {
      const { role, token, roomCode } = socket.handshake.auth || {};
      if (role === 'host') {
        const at = parseCookies(socket.handshake.headers.cookie).qz_at;
        if (!at) throw unauthorized();
        let payload;
        try { payload = verifyAccessToken(at); } catch { throw unauthorized('Session expired', 'TOKEN_EXPIRED'); }
        const user = await userFromAccessPayload(payload);
        socket.data = { role: 'host', userId: String(user._id), familyId: payload.fid, rl: {} };
        return next();
      }
      if (role === 'player' && typeof token === 'string') {
        const { player, room } = await authenticatePlayerToken(token, normalizePin(roomCode));
        socket.data = { role: 'player', playerId: String(player._id), roomId: String(room._id), roomCode: room.code, rl: {} };
        return next();
      }
      throw unauthorized();
    } catch (err) {
      const e = new Error(err.code || 'UNAUTHENTICATED');
      e.data = { code: err.code || 'UNAUTHENTICATED' };
      next(e);
    }
  });

  io.on('connection', (socket) => {
    socket.on('clock:sync', handle(async () => ({ serverNow: Date.now() })));
    if (socket.data.role === 'host') return wireHost(io, socket);
    return wirePlayer(io, socket);
  });

  return io;
}

function wireHost(io, socket) {
  const { userId } = socket.data;
  socket.join(`host:${userId}`);

  // Sockets outlive access tokens, so re-check the session and account on every command.
  async function stillAuthorized() {
    const user = await User.findById(userId).select('status').lean();
    if (!user || user.status !== 'active' || !(await familyActive(socket.data.familyId))) {
      socket.disconnect(true);
      throw unauthorized('Session expired', 'SESSION_EXPIRED');
    }
  }

  socket.on('host:join', handle(async (payload) => {
    await stillAuthorized();
    const code = pin.parse(payload?.roomCode);
    const room = await getOwnedRoom(code, userId); // ownership check; PIN alone is not enough
    for (const r of [...socket.rooms]) if (r.startsWith('game:') || r.startsWith('hostctl:')) socket.leave(r);
    socket.join(`game:${room._id}`);
    socket.join(`hostctl:${room._id}`);
    socket.data.roomCode = room.code;
    socket.emit('chat:history', await chat.history(room._id));
    return hostView(room);
  }));

  // ---- chat (host): speak, delete messages, mute players, change mode ----
  const ownedRoom = async () => { if (!socket.data.roomCode) throw new AppError(409, 'NOT_JOINED', 'Join a room first'); return getOwnedRoom(socket.data.roomCode, userId); };
  socket.on('chat:send', handle(async (payload) => {
    if (!socketAllow(socket, 'chat', 8, 10_000)) throw new AppError(429, 'RATE_LIMITED', 'Slow down');
    await stillAuthorized();
    const { text } = chatText.parse(payload);
    const user = await User.findById(userId).select('fullName sticker').lean();
    return chat.postFromHost(await ownedRoom(), user, text);
  }));
  socket.on('chat:delete', handle(async (payload) => { await stillAuthorized(); const room = await ownedRoom(); await chat.deleteMessage(room._id, objectId.parse(payload?.id), 'host'); return { deleted: true }; }));
  socket.on('chat:mute', handle(async (payload) => {
    await stillAuthorized(); const room = await ownedRoom();
    await chat.setMuted(room._id, objectId.parse(payload?.playerId), !!payload?.muted);
    await broadcastRoster(room._id);
    return { muted: !!payload?.muted };
  }));
  socket.on('chat:mode', handle(async (payload) => { await stillAuthorized(); const room = await ownedRoom(); await chat.setMode(room._id, payload?.mode); await game.pushHostState(room._id); return { mode: payload.mode }; }));

  socket.on('host:question-visibility', handle(async (payload) => {
    if (!socketAllow(socket, 'cmd', 20, 10_000)) throw new AppError(429, 'RATE_LIMITED', 'Slow down');
    await stillAuthorized();
    const { showQuestionsToPlayers } = questionVisibilitySchema.parse(payload);
    if (!socket.data.roomCode) throw new AppError(409, 'NOT_JOINED', 'Join a room first');
    return hostView(await game.setQuestionVisibility(socket.data.roomCode, userId, showQuestionsToPlayers));
  }));

  socket.on('host:command', handle(async (payload) => {
    if (!socketAllow(socket, 'cmd', 20, 10_000)) throw new AppError(429, 'RATE_LIMITED', 'Slow down');
    await stillAuthorized();
    const { action } = hostActionSchema.parse(payload);
    if (!socket.data.roomCode) throw new AppError(409, 'NOT_JOINED', 'Join a room first');
    const room = await game.runHostAction(socket.data.roomCode, userId, action);
    return hostView(room);
  }));

  socket.on('state:request', handle(async () => {
    await stillAuthorized();
    if (!socket.data.roomCode) throw new AppError(409, 'NOT_JOINED', 'Join a room first');
    return hostView(await getOwnedRoom(socket.data.roomCode, userId));
  }));
}

function wirePlayer(io, socket) {
  const { playerId, roomId } = socket.data;
  socket.join(`game:${roomId}`);
  socket.join(`player:${playerId}`);

  (async () => {
    await markConnection(playerId, true);
    await broadcastRoster(roomId);
    toHostCtl(roomId, 'player:reconnected', { id: playerId });
    const { player, room } = await authenticatePlayerToken(socket.handshake.auth.token, socket.data.roomCode).catch(() => ({}));
    if (player) {
      socket.emit('state:restore', await playerView(room, player)); // authoritative state after any (re)connect
      socket.emit('chat:history', await chat.history(room._id));
    }
  })().catch((e) => log.error('player connect', e.message));

  socket.on('answer:submit', handle(async (payload) => {
    if (!socketAllow(socket, 'answer', 6, 5_000)) throw new AppError(429, 'RATE_LIMITED', 'Slow down');
    const body = answerSchema.parse(payload);
    // Re-validate the token each time so a cleaned-up session can't keep answering.
    const { player } = await authenticatePlayerToken(socket.handshake.auth.token, socket.data.roomCode);
    try {
      const r = await game.submitAnswer(player, body);
      socket.emit('answer:accepted', r);
      return r;
    } catch (err) {
      const m = toErrorBody(err);
      if (m) socket.emit('answer:rejected', { code: m.body.code, message: m.body.message });
      throw err;
    }
  }));

  socket.on('chat:send', handle(async (payload) => {
    if (!socketAllow(socket, 'chat', 6, 10_000)) throw new AppError(429, 'RATE_LIMITED', 'Slow down');
    const { text } = chatText.parse(payload);
    const { player } = await authenticatePlayerToken(socket.handshake.auth.token, socket.data.roomCode);
    return chat.postFromPlayer(player, text);
  }));

  socket.on('state:request', handle(async () => {
    const { player, room } = await authenticatePlayerToken(socket.handshake.auth.token, socket.data.roomCode);
    return playerView(room, player);
  }));

  socket.on('disconnect', async () => {
    try {
      const remaining = await io.in(`player:${playerId}`).fetchSockets();
      if (remaining.length) return; // another tab/connection is still live
      await markConnection(playerId, false);
      await broadcastRoster(roomId);
      toHostCtl(roomId, 'player:disconnected', { id: playerId });
    } catch (e) { log.error('player disconnect', e.message); }
  });
}
