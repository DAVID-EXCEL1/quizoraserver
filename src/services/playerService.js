import { Room, Player } from '../models/index.js';
import { AppError, notFound, unauthorized } from '../utils/errors.js';
import { randomToken, sha256 } from '../utils/tokens.js';
import { env } from '../config/env.js';
import { toGame } from '../sockets/broadcast.js';
import { getSettings } from './settings.js';
import { assertValidSticker, randomSticker } from './stickers.js';

// Add this Map at the top of server/src/services/playerService.js (below imports)
const rosterTimeouts = new Map();

// Replace your existing broadcastRoster function with this:
export async function broadcastRoster(roomId) {
  const key = String(roomId);
  if (rosterTimeouts.has(key)) return; // Already queued within the current window
  
  rosterTimeouts.set(key, setTimeout(async () => {
    rosterTimeouts.delete(key);
    try {
      const players = await roster(roomId);
      toGame(roomId, 'roster:updated', { players, count: players.length });
    } catch (err) {
      log.error('broadcastRoster debounce error', err.message);
    }
  }, 500)); // Batches updates into a single broadcast every 0.5 seconds
}

const LIVE = ['LOBBY', 'QUESTION_ACTIVE', 'QUESTION_RESULT', 'LEADERBOARD'];
export const nicknameKey = (n) => n.normalize('NFKC').toLowerCase();

export async function findRoomByCode(code) {
  return Room.findOne({ code });
}

export async function publicRoomInfo(code) {
  const room = await Room.findOne({ code }).select('code status expiresAt snapshot.title').lean();
  if (!room) throw notFound('Game');
  const expired = room.status === 'EXPIRED' || (room.status !== 'GAME_OVER' && room.expiresAt <= new Date());
  return { code: room.code, title: room.snapshot.title, status: expired ? 'EXPIRED' : room.status, joinable: !expired && LIVE.includes(room.status) };
}

export const roster = async (roomId) => {
  const ps = await Player.find({ roomId }).sort({ joinedAt: 1 }).select('nickname sticker connected score muted').lean();
  return ps.map((p) => ({ id: String(p._id), nickname: p.nickname, sticker: p.sticker || '', connected: p.connected, score: p.score, muted: !!p.muted }));
};

export async function broadcastRoster(roomId) {
  const players = await roster(roomId);
  toGame(roomId, 'roster:updated', { players, count: players.length });
}

/** Create a player, or recognise a returning one by their room-scoped token (never by nickname). */
export async function joinRoom(code, nickname, existingToken, stickerPref) {
  const room = await Room.findOne({ code });
  if (!room) throw notFound('Game');
  const now = new Date();
  if (room.status === 'EXPIRED' || (room.status !== 'GAME_OVER' && room.expiresAt <= now)) {
    throw new AppError(410, 'ROOM_EXPIRED', 'This game has expired');
  }
  if (room.status === 'GAME_OVER') throw new AppError(409, 'GAME_FINISHED', 'This game has already finished');

  if (existingToken) {
    const existing = await Player.findOne({ roomId: room._id, tokenHash: sha256(existingToken), tokenExpiresAt: { $gt: now } });
    if (existing) return { player: existing, room, token: existingToken, reconnected: true };
  }

  const cap = room.maxPlayers || env.maxPlayersPerRoom;
  if ((await Player.countDocuments({ roomId: room._id })) >= cap) {
    throw new AppError(409, 'ROOM_FULL', `This game is full (${cap} players)`);
  }
  const settings = await getSettings();
  const stickersOn = room.features?.stickers !== false && settings.features.stickers;
  const sticker = stickersOn ? (stickerPref ? await assertValidSticker(stickerPref) : await randomSticker()) : '';
  const token = randomToken(32);
  let player;
  try {
    player = await Player.create({
      roomId: room._id, nickname, sticker, nicknameKey: nicknameKey(nickname),
      tokenHash: sha256(token), tokenExpiresAt: new Date(Date.now() + env.roomInactivityMs),
    });
  } catch (err) {
    if (err.code === 11000) throw new AppError(409, 'NICKNAME_TAKEN', 'That nickname is already taken in this game', { nickname: 'Nickname already taken' });
    throw err;
  }
  // A successful join counts as meaningful activity.
  await Room.updateOne({ _id: room._id, status: { $in: LIVE } }, { $set: { lastActivityAt: now, expiresAt: new Date(now.getTime() + env.roomInactivityMs) } });
  return { player, room, token, reconnected: false };
}

/** Verify a player token and (optionally) that it belongs to the expected room. */
export async function authenticatePlayerToken(token, expectedCode) {
  const player = await Player.findOne({ tokenHash: sha256(token) });
  if (!player || !player.tokenExpiresAt || player.tokenExpiresAt <= new Date()) {
    throw unauthorized('Player session expired', 'PLAYER_SESSION_INVALID');
  }
  const room = await Room.findById(player.roomId);
  if (!room) throw unauthorized('Player session expired', 'PLAYER_SESSION_INVALID');
  if (expectedCode && room.code !== expectedCode) {
    throw new AppError(403, 'WRONG_ROOM', 'This session does not belong to that game');
  }
  return { player, room };
}

export async function markConnection(playerId, connected) {
  await Player.updateOne({ _id: playerId }, { $set: { connected, lastSeenAt: new Date() } });
}

/** Players may rename themselves and change sticker while a game is live (nickname changes are capped). */
export async function updateProfile(player, room, { nickname, sticker }) {
  if (room.status === 'EXPIRED' || room.status === 'GAME_OVER') throw new AppError(409, 'GAME_ENDED', 'This game has ended');
  const set = {}; const inc = {};
  if (nickname !== undefined && nickname !== player.nickname) {
    if ((player.nickChanges || 0) >= 5) throw new AppError(429, 'NICK_LIMIT', 'You can change your nickname up to 5 times per game');
    set.nickname = nickname; set.nicknameKey = nicknameKey(nickname); inc.nickChanges = 1;
    if (await Player.exists({ roomId: player.roomId, nicknameKey: set.nicknameKey, _id: { $ne: player._id } })) {
      throw new AppError(409, 'NICKNAME_TAKEN', 'That nickname is already taken in this game', { nickname: 'Nickname already taken' });
    }
  }
  if (sticker !== undefined) {
    const settings = await getSettings();
    if (room.features?.stickers === false || !settings.features.stickers) throw new AppError(403, 'STICKERS_OFF', 'Stickers are turned off for this game');
    set.sticker = await assertValidSticker(sticker);
  }
  if (!Object.keys(set).length) return player;
  try {
    await Player.updateOne({ _id: player._id }, { $set: set, ...(inc.nickChanges ? { $inc: inc } : {}) });
  } catch (err) {
    if (err.code === 11000 || /UNIQUE|duplicate/i.test(err.message)) throw new AppError(409, 'NICKNAME_TAKEN', 'That nickname is already taken in this game', { nickname: 'Nickname already taken' });
    throw err;
  }
  return Player.findById(player._id);
}
