import { Router } from 'express';
import { Quiz, GameResult, Room } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ok } from '../utils/misc.js';
import { publicUser } from '../services/authService.js';

const r = Router();

r.get('/', requireAuth, asyncHandler(async (req, res) => {
  const hostId = req.user._id;
  const now = new Date();
  const [totalQuizzes, totalGames, participants, recentQuizzes, recentGames, live] = await Promise.all([
    Quiz.countDocuments({ ownerId: hostId }),
    GameResult.countDocuments({ hostId }),
    GameResult.aggregate([{ $match: { hostId } }, { $group: { _id: null, n: { $sum: '$participantCount' } } }]),
    Quiz.find({ ownerId: hostId }).select('title status updatedAt questions.correctKey').sort({ updatedAt: -1 }).limit(6).lean(),
    GameResult.find({ hostId }).select('-questionStats').sort({ completedAt: -1 }).limit(5).lean(),
    Room.find({ hostId, status: { $in: ['LOBBY', 'QUESTION_ACTIVE', 'QUESTION_RESULT', 'LEADERBOARD'] }, expiresAt: { $gt: now } })
      .select('code status snapshot.title createdAt').sort({ createdAt: -1 }).limit(5).lean(),
  ]);
  ok(res, {
    user: publicUser(req.user),
    stats: { totalQuizzes, totalGames, totalParticipants: participants[0]?.n ?? 0 },
    recentQuizzes: recentQuizzes.map((q) => ({ id: String(q._id), title: q.title, status: q.status, questionCount: q.questions.length, updatedAt: q.updatedAt })),
    recentGames: recentGames.map((g) => ({
      id: String(g._id), roomCode: g.roomCode, quizTitle: g.quizTitle, completedAt: g.completedAt, participantCount: g.participantCount,
      winner: g.rankings?.[0] ? { nickname: g.rankings[0].nickname, score: g.rankings[0].score } : null, podium: g.rankings.slice(0, 3),
    })),
    liveGames: live.map((x) => ({ code: x.code, status: x.status, quizTitle: x.snapshot.title, createdAt: x.createdAt })),
  });
}));

export default r;
