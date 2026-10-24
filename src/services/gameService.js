import { Room, Player, Answer, GameResult } from '../models/index.js';
import { env } from '../config/env.js';
import { AppError, notFound } from '../utils/errors.js';
import { clamp, sleep } from '../utils/misc.js';
import { log } from '../utils/logger.js';
import { toGame, toHostCtl, toPlayer } from '../sockets/broadcast.js';
import { computePoints, rankPlayers } from './scoring.js';
import { getOwnedRoom } from './roomService.js';
import { publicQuestion, playerQuestion, hostView, leaderboard, lbRow, boardRows } from './views.js';

const LIVE = ['LOBBY', 'QUESTION_ACTIVE', 'QUESTION_RESULT', 'LEADERBOARD'];
const bump = (now = new Date()) => ({ lastActivityAt: now, expiresAt: new Date(now.getTime() + env.roomInactivityMs) });

/* ------------------------------------------------------------------ helpers */

async function explainFailure(roomId, hostId) {
  const room = await Room.findOne({ _id: roomId, ...(hostId ? { hostId } : {}) }).select('status expiresAt').lean();
  if (!room) throw notFound('Game');
  if (room.status === 'EXPIRED' || (room.status !== 'GAME_OVER' && +room.expiresAt <= Date.now())) {
    throw new AppError(410, 'ROOM_EXPIRED', 'This game has expired');
  }
  throw new AppError(409, 'ILLEGAL_TRANSITION', `That action isn't available while the game is in ${room.status}`);
}

/** Atomic compare-and-set on status/index; this is what makes duplicate or racing commands safe. */
async function transition({ roomId, hostId, from, index, set, activity = true }) {
  const now = new Date();
  const filter = { _id: roomId, status: { $in: [].concat(from) }, expiresAt: { $gt: now } };
  if (hostId) filter.hostId = hostId;
  if (index !== undefined) filter.currentQuestionIndex = index;
  return Room.findOneAndUpdate(filter, { $set: { ...set, ...(activity ? bump(now) : {}) } }, { new: true });
}

const timers = new Map();
function scheduleClose(room) {
  const key = String(room._id);
  clearTimeout(timers.get(key));
  const idx = room.currentQuestionIndex;
  const delay = Math.max(0, +room.questionDeadline - Date.now()) + env.deadlineGraceMs;
  const t = setTimeout(() => {
    timers.delete(key);
    closeQuestion(room._id, idx).catch((e) => log.error('auto-close failed', e.message));
  }, delay);
  t.unref?.();
  timers.set(key, t);
}
export const clearRoomTimer = (id) => { clearTimeout(timers.get(String(id))); timers.delete(String(id)); };

export async function pushHostState(roomOrId) {
  const room = roomOrId?.snapshot ? roomOrId : await Room.findById(roomOrId);
  if (!room) return;
  toHostCtl(room._id, 'state:update', await hostView(room));
}

/* -------------------------------------------------------------- transitions */

async function activate(room, from, expectedIdx, nextIdx) {
  const q = room.snapshot.questions[nextIdx];
  const now = new Date();
  const updated = await transition({
    roomId: room._id, hostId: room.hostId, from, index: expectedIdx,
    set: {
      status: 'QUESTION_ACTIVE', currentQuestionIndex: nextIdx, questionStartedAt: now,
      questionDeadline: new Date(now.getTime() + q.timeLimit * 1000), questionClosedAt: null,
      startedAt: room.startedAt || now,
    },
  });
  if (!updated) return explainFailure(room._id, room.hostId);
  scheduleClose(updated);
  const payload = { ...playerQuestion(updated), showQuestionsToPlayers: updated.showQuestionsToPlayers !== false, serverNow: Date.now() };
  toGame(updated._id, 'game:started', { questionIndex: nextIdx });
  toGame(updated._id, 'question:started', payload);
  await pushHostState(updated);
  return updated;
}

export async function startGame(code, hostId) {
  const room = await getOwnedRoom(code, hostId);
  if (!room.snapshot.questions.length) throw new AppError(422, 'QUIZ_INCOMPLETE', 'This game has no questions');
  if (room.status === 'LOBBY' && (await Player.countDocuments({ roomId: room._id })) === 0) {
    throw new AppError(409, 'NO_PLAYERS', 'Wait for at least one player to join');
  }
  return activate(room, 'LOBBY', -1, 0);
}

export async function setQuestionVisibility(code, hostId, showQuestionsToPlayers) {
  const room = await getOwnedRoom(code, hostId);
  if (room.status !== 'LOBBY') return explainFailure(room._id, hostId);
  const now = new Date();
  const updated = await Room.findOneAndUpdate(
    { _id: room._id, hostId, status: 'LOBBY', expiresAt: { $gt: now } },
    { $set: { showQuestionsToPlayers, ...bump(now) } },
    { new: true },
  );
  if (!updated) return explainFailure(room._id, hostId);
  await pushHostState(updated);
  return updated;
}

export async function nextQuestion(code, hostId) {
  const room = await getOwnedRoom(code, hostId);
  if (!['QUESTION_RESULT', 'LEADERBOARD'].includes(room.status)) return explainFailure(room._id, hostId);
  await scoreQuestion(room._id, room.currentQuestionIndex);
  const nextIdx = room.currentQuestionIndex + 1;
  if (nextIdx >= room.snapshot.questions.length) return completeGame(room._id, hostId);
  return activate(room, ['QUESTION_RESULT', 'LEADERBOARD'], room.currentQuestionIndex, nextIdx);
}

export async function showLeaderboard(code, hostId) {
  const room = await getOwnedRoom(code, hostId);
  if (room.status !== 'QUESTION_RESULT') return explainFailure(room._id, hostId);
  await scoreQuestion(room._id, room.currentQuestionIndex);
  const updated = await transition({ roomId: room._id, hostId, from: 'QUESTION_RESULT', index: room.currentQuestionIndex, set: { status: 'LEADERBOARD' } });
  if (!updated) return explainFailure(room._id, hostId);
  const ranked = await leaderboard(updated._id);
  toGame(updated._id, 'leaderboard:updated', { leaderboard: await boardRows(updated, ranked, 10), questionIndex: updated.currentQuestionIndex });
  for (const p of ranked) toPlayer(p._id, 'player:rank', { rank: p.rank, score: p.score, streak: p.streak });
  await pushHostState(updated);
  return updated;
}

export async function closeQuestionByHost(code, hostId) {
  const room = await getOwnedRoom(code, hostId);
  if (room.status !== 'QUESTION_ACTIVE') return explainFailure(room._id, hostId);
  return closeQuestion(room._id, room.currentQuestionIndex, { hostId });
}

/** Idempotent: only the caller that wins the ACTIVE -> RESULT swap does the work. */
export async function closeQuestion(roomId, expectedIdx, { hostId } = {}) {
  const now = new Date();
  const filter = { _id: roomId, status: 'QUESTION_ACTIVE', currentQuestionIndex: expectedIdx };
  if (hostId) { filter.hostId = hostId; filter.expiresAt = { $gt: now }; }
  const updated = await Room.findOneAndUpdate(
    filter,
    { $set: { status: 'QUESTION_RESULT', questionClosedAt: now, scoringPending: true, ...(hostId ? bump(now) : {}) } },
    { new: true },
  );
  if (!updated) {
    if (hostId) return explainFailure(roomId, hostId);
    return null;
  }
  clearRoomTimer(roomId);
  // Let in-flight answers (received before closedAt) finish committing, then score once.
  await sleep(env.scoringDelayMs);
  await scoreQuestion(roomId, expectedIdx);
  await announceClosed(roomId);
  return updated;
}

async function announceClosed(roomId) {
  const room = await Room.findById(roomId);
  if (!room || !['QUESTION_RESULT', 'LEADERBOARD'].includes(room.status)) return;
  const q = room.snapshot.questions[room.currentQuestionIndex];
  const [answers, ranked] = await Promise.all([Answer.find({ roomId, qid: q.qid }).lean(), leaderboard(roomId)]);
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  const byPlayer = new Map();
  for (const a of answers) { counts[a.optionKey]++; byPlayer.set(String(a.playerId), a); }
  toGame(roomId, 'question:closed', { questionIndex: room.currentQuestionIndex });
  toGame(roomId, 'answer:revealed', { questionIndex: room.currentQuestionIndex, correctKey: q.correctKey, counts, answered: answers.length });
  for (const p of ranked) {
    const a = byPlayer.get(String(p._id));
    toPlayer(p._id, 'answer:result', {
      questionIndex: room.currentQuestionIndex, correctKey: q.correctKey, answered: !!a, optionKey: a?.optionKey ?? null,
      isCorrect: !!a?.isCorrect, points: a?.points ?? 0, score: p.score, rank: p.rank, streak: p.streak,
    });
  }
  await pushHostState(room);
}

export async function endGame(code, hostId) {
  const room = await getOwnedRoom(code, hostId);
  if (!LIVE.includes(room.status)) return explainFailure(room._id, hostId);
  if (room.status === 'LOBBY') {
    const now = new Date();
    const cancelled = await transition({
      roomId: room._id, hostId, from: 'LOBBY',
      set: { status: 'EXPIRED', expiredAt: now, expiredReason: 'cancelled', purgeAt: new Date(now.getTime() + env.finishedRoomRetentionMs) },
    });
    if (!cancelled) return explainFailure(room._id, hostId);
    await Player.updateMany({ roomId: room._id }, { $unset: { tokenHash: 1, tokenExpiresAt: 1 } });
    toGame(room._id, 'room:expired', { reason: 'cancelled' });
    await pushHostState(cancelled);
    return cancelled;
  }
  if (room.status === 'QUESTION_ACTIVE') await closeQuestion(room._id, room.currentQuestionIndex, { hostId }).catch((e) => { if (e.code !== 'ILLEGAL_TRANSITION') throw e; });
  return completeGame(room._id, hostId);
}

async function completeGame(roomId, hostId) {
  const cur = await Room.findById(roomId).select('currentQuestionIndex').lean();
  if (cur && cur.currentQuestionIndex >= 0) await scoreQuestion(roomId, cur.currentQuestionIndex);
  const now = new Date();
  const updated = await transition({
    roomId, hostId, from: ['QUESTION_RESULT', 'LEADERBOARD'],
    set: { status: 'GAME_OVER', completedAt: now, resultPending: true, purgeAt: new Date(now.getTime() + env.finishedRoomRetentionMs) },
  });
  if (!updated) return explainFailure(roomId, hostId);
  clearRoomTimer(roomId);
  await ensureGameResult(updated);
  await Player.updateMany({ roomId, tokenHash: { $exists: true } }, { $set: { tokenExpiresAt: new Date(now.getTime() + env.finishedPlayerTokenMs) } });
  const ranked = await leaderboard(roomId);
  toGame(roomId, 'game:finished', { code: updated.code, podium: ranked.slice(0, 3).map(lbRow), leaderboard: await boardRows(updated, ranked, 10) });
  await pushHostState(updated);
  return updated;
}

/** Idempotent: unique roomId means a repeat (or the repair sweep) can never double-record. */
export async function ensureGameResult(room) {
  const [players, answers] = await Promise.all([Player.find({ roomId: room._id }).lean(), Answer.find({ roomId: room._id }).lean()]);
  const ranked = rankPlayers(players);
  const qs = room.snapshot.questions;
  const lastIdx = Math.max(room.currentQuestionIndex, -1);
  const questionStats = qs.slice(0, lastIdx + 1).map((q, index) => {
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    let answered = 0; let correct = 0;
    for (const a of answers) if (a.qid === q.qid) { counts[a.optionKey]++; answered++; if (a.isCorrect) correct++; }
    return { index, text: q.text, correctKey: q.correctKey, answered, correct, counts };
  });
  await GameResult.updateOne({ roomId: room._id }, {
    $setOnInsert: {
      roomId: room._id, roomCode: room.code, hostId: room.hostId, quizId: room.quizId, quizTitle: room.snapshot.title,
      totalQuestions: qs.length, completedAt: room.completedAt || new Date(), participantCount: ranked.length,
      rankings: ranked.map((p) => ({
        rank: p.rank, nickname: p.nickname, sticker: p.sticker || '', score: p.score, correctCount: p.correctCount, answeredCount: p.answeredCount, bestStreak: p.bestStreak,
        avgResponseMs: p.answeredCount ? Math.round(p.totalResponseMs / p.answeredCount) : null,
      })),
      questionStats,
    },
  }, { upsert: true });
  await Room.updateOne({ _id: room._id }, { $set: { resultPending: false } });
}

/* ------------------------------------------------------------------ scoring */

/**
 * Score a closed question exactly once. Safe to call repeatedly or from several processes:
 * each player update is guarded by lastScoredIndex, and answer updates are deterministic.
 */
export async function scoreQuestion(roomId, idx) {
  const room = await Room.findById(roomId).lean();
  if (!room || idx < 0 || room.scoredQuestionIndex >= idx) return false;
  const q = room.snapshot.questions[idx];
  if (!q || !room.questionClosedAt) return false;
  const [players, answers] = await Promise.all([Player.find({ roomId }).lean(), Answer.find({ roomId, qid: q.qid }).lean()]);
  const byPlayer = new Map(answers.map((a) => [String(a.playerId), a]));
  const startedAt = +room.questionStartedAt;
  const deadline = +room.questionDeadline;
  const closedAt = +room.questionClosedAt;
  const limitMs = q.timeLimit * 1000;
  const playerOps = [];
  const answerOps = [];
  const scoredAt = new Date();

  for (const p of players) {
    if ((p.lastScoredIndex ?? -1) >= idx) continue;
    const a = byPlayer.get(String(p._id));
    const valid = !!a && +a.receivedAt <= deadline && +a.receivedAt <= closedAt;
    let correct = false; let points = 0; let responseMs = null;
    if (valid) {
      responseMs = clamp(+a.receivedAt - startedAt, 0, limitMs);
      correct = a.optionKey === q.correctKey;
      if (correct) points = computePoints({ basePoints: q.basePoints, timeLimitMs: limitMs, deadlineMs: deadline, receivedAtMs: +a.receivedAt });
    }
    if (a) answerOps.push({ updateOne: { filter: { _id: a._id }, update: { $set: { isCorrect: correct, points, responseMs, scoredAt } } } });
    const streak = correct ? p.streak + 1 : 0; // wrong, late or missing answers reset the streak
    playerOps.push({
      updateOne: {
        filter: { _id: p._id, lastScoredIndex: { $lt: idx } },
        update: { $set: {
          score: p.score + points, correctCount: p.correctCount + (correct ? 1 : 0), answeredCount: p.answeredCount + (valid ? 1 : 0),
          streak, bestStreak: Math.max(p.bestStreak, streak), totalResponseMs: p.totalResponseMs + (responseMs ?? 0), lastScoredIndex: idx,
        } },
      },
    });
  }
  if (answerOps.length) await Answer.bulkWrite(answerOps, { ordered: false });
  if (playerOps.length) await Player.bulkWrite(playerOps, { ordered: false });
  await Room.updateOne({ _id: roomId, scoredQuestionIndex: { $lt: idx } }, { $set: { scoredQuestionIndex: idx, scoringPending: false } });
  return true;
}

/* ------------------------------------------------------------------ answers */

export async function submitAnswer(player, { questionIndex, optionKey }) {
  const now = Date.now();
  const room = await Room.findById(player.roomId).lean();
  if (!room) throw notFound('Game');
  if (room.status === 'EXPIRED' || (room.status !== 'GAME_OVER' && +room.expiresAt <= now)) throw new AppError(410, 'ROOM_EXPIRED', 'This game has expired');
  if (room.status !== 'QUESTION_ACTIVE') throw new AppError(409, 'QUESTION_CLOSED', 'This question is closed');
  if (room.currentQuestionIndex !== questionIndex) throw new AppError(409, 'WRONG_QUESTION', 'That question is no longer active');
  if (now > +room.questionDeadline) throw new AppError(409, 'TOO_LATE', 'Time is up');

  const q = room.snapshot.questions[questionIndex];
  try {
    await Answer.create({ roomId: room._id, playerId: player._id, qid: q.qid, questionIndex, optionKey, receivedAt: new Date(now) });
  } catch (err) {
    if (err.code === 11000) throw new AppError(409, 'ALREADY_ANSWERED', 'You already answered this question');
    throw err;
  }
  await Room.updateOne({ _id: room._id, status: 'QUESTION_ACTIVE' }, { $set: bump() }); // accepted answer = meaningful activity

  const [answered, total] = await Promise.all([Answer.countDocuments({ roomId: room._id, qid: q.qid }), Player.countDocuments({ roomId: room._id })]);
  toHostCtl(room._id, 'answer:received', { answeredCount: answered, total, questionIndex });
  if (env.autoCloseWhenAllAnswered && answered >= total) {
    closeQuestion(room._id, questionIndex).catch((e) => log.error('auto-close failed', e.message));
  }
  return { accepted: true, questionIndex };
}

/** Always answers with a freshly read room: the transition's own return value can predate scoring. */
export async function runHostAction(code, hostId, action) {
  const room = await dispatchHostAction(code, hostId, action);
  return (room?._id && await Room.findById(room._id)) || room;
}

async function dispatchHostAction(code, hostId, action) {
  switch (action) {
    case 'start': return startGame(code, hostId);
    case 'close': return closeQuestionByHost(code, hostId);
    case 'leaderboard': return showLeaderboard(code, hostId);
    case 'next': return nextQuestion(code, hostId);
    case 'end': return endGame(code, hostId);
    default: throw new AppError(400, 'BAD_ACTION', 'Unknown action');
  }
}

/** Admin/system-initiated shutdown of a live room. Atomic, so concurrent calls are harmless. */
export async function forceExpireRoom(roomId, reason) {
  const now = new Date();
  const room = await Room.findOneAndUpdate(
    { _id: roomId, status: { $in: LIVE } },
    { $set: { status: 'EXPIRED', expiredAt: now, expiredReason: reason, purgeAt: new Date(now.getTime() + env.finishedRoomRetentionMs) } },
    { new: true },
  );
  if (!room) return null;
  clearRoomTimer(roomId);
  await Player.updateMany({ roomId }, { $unset: { tokenHash: 1, tokenExpiresAt: 1 }, $set: { connected: false } });
  toGame(roomId, 'room:expired', { reason });
  toHostCtl(roomId, 'room:expired', { reason });
  return room;
}
