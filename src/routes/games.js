import { Router } from 'express';
import { GameResult, Room } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { pageQuery, objectId } from '../validators/common.js';
import { asyncHandler, ok, escapeRegex } from '../utils/misc.js';
import { AppError, notFound } from '../utils/errors.js';

const r = Router();

const summary = (g) => ({
  id: String(g._id), roomCode: g.roomCode, quizTitle: g.quizTitle, completedAt: g.completedAt, participantCount: g.participantCount,
  totalQuestions: g.totalQuestions, winner: g.rankings?.[0] ? { nickname: g.rankings[0].nickname, score: g.rankings[0].score } : null,
  podium: (g.rankings || []).slice(0, 3),
});

// Host history: always filtered by the authenticated host.
r.get('/games', requireAuth, validate(pageQuery, 'query'), asyncHandler(async (req, res) => {
  const { page, limit, search } = req.valid.query;
  const filter = { hostId: req.user._id };
  if (search) filter.$or = [{ quizTitle: { $regex: escapeRegex(search), $options: 'i' } }, { roomCode: search.toUpperCase() }];
  const [items, total] = await Promise.all([
    GameResult.find(filter).select('-questionStats').sort({ completedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    GameResult.countDocuments(filter),
  ]);
  ok(res, { items: items.map(summary), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

r.get('/games/:id', requireAuth, asyncHandler(async (req, res) => {
  if (!objectId.safeParse(req.params.id).success) throw notFound('Game');
  const g = await GameResult.findOne({ _id: req.params.id, hostId: req.user._id }).lean();
  if (!g) throw notFound('Game');
  ok(res, { ...summary(g), rankings: g.rankings, questionStats: g.questionStats });
}));

// Public results for players: only nicknames and scores, only once the game is complete.
r.get('/results/:code', asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw notFound('Results');
  const g = await GameResult.findOne({ roomCode: code }).sort({ completedAt: -1 }).lean();
  if (!g) {
    const live = await Room.findOne({ code }).select('status').lean();
    if (live && live.status !== 'EXPIRED') throw new AppError(409, 'GAME_NOT_FINISHED', 'This game has not finished yet');
    throw notFound('Results');
  }
  ok(res, {
    roomCode: g.roomCode, quizTitle: g.quizTitle, completedAt: g.completedAt, participantCount: g.participantCount,
    totalQuestions: g.totalQuestions, podium: g.rankings.slice(0, 3), rankings: g.rankings,
  });
}));

export default r;
