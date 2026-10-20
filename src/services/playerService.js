import { Room, Player } from '../models/index.js';
import { AppError, notFound, unauthorized } from '../utils/errors.js';
import { randomToken, sha256 } from '../utils/tokens.js';
import { env } from '../config/env.js';
import { toGame } from '../sockets/broadcast.js';

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
  const ps = await Player.find({ roomId }).sort({ joinedAt: 1 }).select('nickname connected score').lean();
  return ps.map((p) => ({ id: String(p._id), nickname: p.nickname, connected: p.connected, score: p.score }));
};

export async function broadcastRoster(roomId) {
  const players = await roster(roomId);
  toGame(roomId, 'roster:updated', { players, count: players.length });
}

/** Create a player, or recognise a returning one by their room-scoped token (never by nickname). */
export async function joinRoom(code, nickname, existingToken) {
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

  if ((await Player.countDocuments({ roomId: room._id })) >= env.maxPlayersPerRoom) {
    throw new AppError(409, 'ROOM_FULL', 'This game is full');
  }
  const token = randomToken(32);
  let player;
  try {
    player = await Player.create({
      roomId: room._id, nickname, nicknameKey: nicknameKey(nickname),
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
