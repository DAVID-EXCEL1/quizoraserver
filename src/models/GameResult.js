import mongoose from 'mongoose';

const rankingSchema = new mongoose.Schema({
  rank: Number,
  nickname: String,
  sticker: String,
  score: Number,
  correctCount: Number,
  answeredCount: Number,
  bestStreak: Number,
  avgResponseMs: Number,
}, { _id: false });

const questionStatSchema = new mongoose.Schema({
  index: Number,
  text: String,
  correctKey: String,
  answered: Number,
  correct: Number,
  counts: { A: Number, B: Number, C: Number, D: Number },
}, { _id: false });

// Self-contained record of a finished game. Survives room cleanup and quiz edits/deletes.
const gameResultSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  roomCode: { type: String, required: true, index: true },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quizId: mongoose.Schema.Types.ObjectId,
  quizTitle: { type: String, required: true },
  totalQuestions: Number,
  completedAt: { type: Date, required: true },
  participantCount: { type: Number, default: 0 },
  rankings: [rankingSchema],
  questionStats: [questionStatSchema],
}, { timestamps: { createdAt: true, updatedAt: false } });
gameResultSchema.index({ hostId: 1, completedAt: -1 });

export const GameResult = mongoose.model('GameResult', gameResultSchema);
