import { Room, Player, Answer, ChatMessage } from '../models/index.js';
import { env } from '../config/env.js';
import { log } from '../utils/logger.js';
import { closeQuestion, scoreQuestion, ensureGameResult, clearRoomTimer } from '../services/gameService.js';
import { toGame, toHostCtl } from '../sockets/broadcast.js';

const LIVE = ['LOBBY', 'QUESTION_ACTIVE', 'QUESTION_RESULT', 'LEADERBOARD'];

/** Fast loop (~1s): DB-backed so it also recovers games after a server restart. */
export async function runSweep() {
  const now = Date.now();
  const overdue = await Room.find({ status: 'QUESTION_ACTIVE', questionDeadline: { $lt: new Date(now - env.deadlineGraceMs) } }).select('_id currentQuestionIndex').lean();
  for (const r of overdue) await closeQuestion(r._id, r.currentQuestionIndex).catch((e) => log.error('sweep close', e.message));

  const unscored = await Room.find({ scoringPending: true, questionClosedAt: { $lt: new Date(now - 2000) } }).select('_id currentQuestionIndex').lean();
  for (const r of unscored) await scoreQuestion(r._id, r.currentQuestionIndex).catch((e) => log.error('sweep score', e.message));

  const unfinished = await Room.find({ status: 'GAME_OVER', resultPending: true }).limit(20);
  for (const room of unfinished) await ensureGameResult(room).catch((e) => log.error('sweep result', e.message));
  return { closed: overdue.length, rescored: unscored.length, resultsRepaired: unfinished.length };
}

/** Slow loop (~1min): inactivity expiry, credential cleanup, and purging of old room data. */
export async function runExpiry() {
  const now = new Date();
  let expired = 0;
  for (;;) {
    // Atomic per room, so several workers can run this concurrently without double-handling.
    const room = await Room.findOneAndUpdate(
      { status: { $in: LIVE }, expiresAt: { $lte: now } },
      { $set: { status: 'EXPIRED', expiredAt: now, expiredReason: 'inactivity', purgeAt: new Date(now.getTime() + env.finishedRoomRetentionMs) } },
      { new: true },
    );
    if (!room) break;
    expired++;
    clearRoomTimer(room._id);
    await Player.updateMany({ roomId: room._id }, { $unset: { tokenHash: 1, tokenExpiresAt: 1 }, $set: { connected: false } });
    toGame(room._id, 'room:expired', { reason: 'inactivity' });
    toHostCtl(room._id, 'room:expired', { reason: 'inactivity' });
  }

  // Player credentials past their own expiry (e.g. 30 min after a game finished).
  const creds = await Player.updateMany({ tokenExpiresAt: { $lt: now } }, { $unset: { tokenHash: 1, tokenExpiresAt: 1 } });

  // Purge rooms past retention. TTL index is only a backstop; GameResult is never touched.
  const old = await Room.find({ purgeAt: { $lte: now } }).select('_id').limit(200).lean();
  if (old.length) {
    const ids = old.map((r) => r._id);
    await Answer.deleteMany({ roomId: { $in: ids } });
    await ChatMessage.deleteMany({ roomId: { $in: ids } });
    await Player.deleteMany({ roomId: { $in: ids } });
    await Room.deleteMany({ _id: { $in: ids } });
  }
  return { expired, credentialsCleared: creds.modifiedCount ?? 0, purged: old.length };
}

export function startJobs() {
  let sweeping = false; let cleaning = false;
  const a = setInterval(async () => {
    if (sweeping) return; sweeping = true;
    try { await runSweep(); } catch (e) { log.error('sweep', e.message); } finally { sweeping = false; }
  }, env.sweepIntervalMs);
  const b = setInterval(async () => {
    if (cleaning) return; cleaning = true;
    try { const r = await runExpiry(); if (r.expired || r.purged) log.info('cleanup', JSON.stringify(r)); } catch (e) { log.error('cleanup', e.message); } finally { cleaning = false; }
  }, env.cleanupIntervalMs);
  runExpiry().catch((e) => log.error('initial cleanup', e.message));
  return () => { clearInterval(a); clearInterval(b); };
}
