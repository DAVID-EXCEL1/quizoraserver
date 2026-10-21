import { Room, Player, ChatMessage } from '../models/index.js';
import { AppError, notFound } from '../utils/errors.js';
import { toGame, toPlayer, toHostCtl } from '../sockets/broadcast.js';
import { getSettings } from './settings.js';

const LIVE = ['LOBBY', 'QUESTION_ACTIVE', 'QUESTION_RESULT', 'LEADERBOARD'];
const MODES = ['on', 'between', 'off'];

export const messageView = (m) => ({
  id: String(m._id), authorType: m.authorType, authorId: m.authorId ? String(m.authorId) : null, nickname: m.nickname, sticker: m.sticker || '', text: m.text, at: m.createdAt,
});

export async function history(roomId, limit = 50) {
  const rows = await ChatMessage.find({ roomId, deleted: false }).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.reverse().map(messageView);
}

/** Replace blocked words (admin-managed list) with bullets rather than rejecting the whole message. */
function mask(text, words) {
  let out = text;
  for (const w of words) {
    if (!w) continue;
    const rx = new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(rx, (m) => '•'.repeat(m.length));
  }
  return out;
}

function cleanText(raw, max) {
  const text = String(raw ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) throw new AppError(400, 'EMPTY_MESSAGE', 'Type a message first');
  if ([...text].length > max) throw new AppError(400, 'MESSAGE_TOO_LONG', `Messages can be up to ${max} characters`);
  return text;
}

async function gate(roomId, { forHost }) {
  const room = await Room.findById(roomId).lean();
  if (!room) throw notFound('Game');
  const settings = await getSettings();
  if (!LIVE.includes(room.status) || +room.expiresAt <= Date.now()) throw new AppError(409, 'CHAT_CLOSED', 'Chat is closed for this game');
  if (!settings.features.chat || room.features?.chat === false) throw new AppError(403, 'CHAT_DISABLED', 'Chat is turned off');
  if (room.chatMode === 'off') throw new AppError(403, 'CHAT_OFF', 'The host turned chat off');
  // The host can always speak; players are paused during live questions in "between" mode to stop answer sharing.
  if (!forHost && room.chatMode === 'between' && room.status === 'QUESTION_ACTIVE') throw new AppError(409, 'CHAT_PAUSED', 'Chat is paused while a question is live');
  return { room, settings };
}

export async function postFromPlayer(player, text) {
  const { room, settings } = await gate(player.roomId, { forHost: false });
  const fresh = await Player.findById(player._id).select('muted nickname sticker').lean();
  if (!fresh) throw notFound('Player');
  if (fresh.muted) throw new AppError(403, 'MUTED', 'The host muted you in this game');
  const body = mask(cleanText(text, settings.chat.maxLength), settings.chat.blockedWords);
  // Atomic per-player cooldown so several sockets can't bypass the rate limit.
  const now = new Date();
  const ok = await Player.findOneAndUpdate(
    { _id: player._id, $or: [{ lastChatAt: null }, { lastChatAt: { $lt: new Date(+now - settings.chat.cooldownMs) } }] },
    { $set: { lastChatAt: now } },
  );
  if (!ok) throw new AppError(429, 'CHAT_COOLDOWN', 'Slow down a little');
  const m = await ChatMessage.create({ roomId: room._id, authorType: 'player', authorId: player._id, nickname: fresh.nickname, sticker: room.features?.stickers === false ? '' : fresh.sticker, text: body });
  const view = messageView(m);
  toGame(room._id, 'chat:message', view);
  return view;
}

export async function postFromHost(room, user, text) {
  const { settings } = await gate(room._id, { forHost: true });
  const body = mask(cleanText(text, settings.chat.maxLength), settings.chat.blockedWords);
  const m = await ChatMessage.create({ roomId: room._id, authorType: 'host', authorId: user._id, nickname: user.fullName, sticker: user.sticker || '', text: body });
  const view = messageView(m);
  toGame(room._id, 'chat:message', view);
  return view;
}

export async function deleteMessage(roomId, messageId, by) {
  const m = await ChatMessage.findOneAndUpdate({ _id: messageId, roomId, deleted: false }, { $set: { deleted: true, deletedBy: by } });
  if (!m) throw notFound('Message');
  toGame(roomId, 'chat:deleted', { id: String(messageId) });
}

export async function setMuted(roomId, playerId, muted) {
  const r = await Player.findOneAndUpdate({ _id: playerId, roomId }, { $set: { muted } });
  if (!r) throw notFound('Player');
  toPlayer(playerId, 'chat:muted', { muted });
  toHostCtl(roomId, 'player:muted', { id: String(playerId), muted });
  return r;
}

export async function setMode(roomId, mode) {
  if (!MODES.includes(mode)) throw new AppError(400, 'BAD_MODE', 'Unknown chat mode');
  const settings = await getSettings();
  const room = await Room.findOneAndUpdate({ _id: roomId, status: { $in: LIVE }, 'features.chat': { $ne: false } }, { $set: { chatMode: mode } }, { new: true });
  if (!room) throw new AppError(409, 'CHAT_UNAVAILABLE', 'Chat isn’t available for this game');
  const paused = mode === 'between' && room.status === 'QUESTION_ACTIVE';
  toGame(roomId, 'chat:mode', { mode, paused, enabled: mode !== 'off' && settings.features.chat });
  return room;
}
