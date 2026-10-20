import { Answer, Player } from '../models/index.js';
import { rankPlayers } from './scoring.js';
import { joinUrl } from './roomService.js';

const OPT = (q) => q.options.map((o) => ({ key: o.key, text: o.text }));

/** What every client may see about an active question: never the correct answer. */
export function publicQuestion(room, idx = room.currentQuestionIndex) {
  const q = room.snapshot.questions[idx];
  if (!q) return null;
  return {
    id: q.qid, index: idx, total: room.snapshot.questions.length, text: q.text, imageUrl: q.imageUrl || null,
    options: OPT(q), timeLimit: q.timeLimit,
    startedAt: room.questionStartedAt ? +room.questionStartedAt : null,
    deadline: room.questionDeadline ? +room.questionDeadline : null,
  };
}

const lbRow = (p) => ({
  rank: p.rank, id: String(p._id), nickname: p.nickname, score: p.score, correctCount: p.correctCount, streak: p.streak, bestStreak: p.bestStreak,
});

export async function leaderboard(roomId) {
  const players = await Player.find({ roomId }).lean();
  return rankPlayers(players);
}

async function optionCounts(room) {
  const q = room.snapshot.questions[room.currentQuestionIndex];
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  if (!q) return { counts, answered: 0 };
  const answers = await Answer.find({ roomId: room._id, qid: q.qid }).select('optionKey').lean();
  for (const a of answers) counts[a.optionKey]++;
  return { counts, answered: answers.length };
}

const revealed = (room) => ['QUESTION_RESULT', 'LEADERBOARD'].includes(room.status);
const scored = (room) => room.scoredQuestionIndex >= room.currentQuestionIndex && room.currentQuestionIndex >= 0;

/** Authoritative state for one player (used for first load, reconnects and server restarts). */
export async function playerView(room, player) {
  const ranked = await leaderboard(room._id);
  const me = ranked.find((p) => String(p._id) === String(player._id));
  const view = {
    code: room.code, title: room.snapshot.title, status: room.status, serverNow: Date.now(),
    totalQuestions: room.snapshot.questions.length,
    questionIndex: room.currentQuestionIndex >= 0 ? room.currentQuestionIndex : null,
    playerCount: ranked.length,
    me: { id: String(player._id), nickname: player.nickname, score: me?.score ?? 0, rank: me?.rank ?? null, streak: me?.streak ?? 0, correctCount: me?.correctCount ?? 0 },
  };
  const q = room.snapshot.questions[room.currentQuestionIndex];
  if (room.status === 'QUESTION_ACTIVE') {
    view.question = publicQuestion(room);
    const mine = await Answer.findOne({ roomId: room._id, playerId: player._id, qid: q.qid }).select('optionKey').lean();
    view.myAnswer = mine ? { optionKey: mine.optionKey } : null;
  }
  if (revealed(room) && q) {
    view.question = { ...publicQuestion(room), deadline: +room.questionDeadline };
    if (scored(room)) {
      const mine = await Answer.findOne({ roomId: room._id, playerId: player._id, qid: q.qid }).lean();
      const { counts } = await optionCounts(room);
      view.result = {
        correctKey: q.correctKey, counts,
        answered: !!mine, optionKey: mine?.optionKey ?? null, isCorrect: !!mine?.isCorrect, points: mine?.points ?? 0,
      };
    } else view.result = { pending: true };
  }
  if (room.status === 'LEADERBOARD' || room.status === 'GAME_OVER') view.leaderboard = ranked.slice(0, 10).map(lbRow);
  if (room.status === 'GAME_OVER') view.podium = ranked.slice(0, 3).map(lbRow);
  return view;
}

/** Host's full picture of the room. */
export async function hostView(room) {
  const ranked = await leaderboard(room._id);
  const view = {
    id: String(room._id), code: room.code, title: room.snapshot.title, status: room.status, serverNow: Date.now(),
    joinUrl: joinUrl(room.code), expiresAt: +room.expiresAt,
    totalQuestions: room.snapshot.questions.length,
    questionIndex: room.currentQuestionIndex >= 0 ? room.currentQuestionIndex : null,
    isLastQuestion: room.currentQuestionIndex === room.snapshot.questions.length - 1,
    playerCount: ranked.length,
    players: [...ranked].sort((a, b) => +new Date(a.joinedAt) - +new Date(b.joinedAt)).map((p) => ({ id: String(p._id), nickname: p.nickname, connected: p.connected, score: p.score })),
  };
  if (['QUESTION_ACTIVE', 'QUESTION_RESULT', 'LEADERBOARD'].includes(room.status)) {
    view.question = publicQuestion(room);
    const { counts, answered } = await optionCounts(room);
    view.answeredCount = answered;
    if (revealed(room)) {
      const q = room.snapshot.questions[room.currentQuestionIndex];
      view.result = scored(room) ? { correctKey: q.correctKey, counts } : { pending: true };
    }
  }
  if (['QUESTION_RESULT', 'LEADERBOARD', 'GAME_OVER'].includes(room.status)) view.leaderboard = ranked.slice(0, 10).map(lbRow);
  if (room.status === 'GAME_OVER') view.podium = ranked.slice(0, 3).map(lbRow);
  return view;
}

export { lbRow };
