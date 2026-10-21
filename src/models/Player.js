import mongoose from 'mongoose';

const playerSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  nickname: { type: String, required: true, minlength: 2, maxlength: 20 },
  nicknameKey: { type: String, required: true },
  tokenHash: { type: String, index: true }, // SHA-256 of the anonymous session token; unset on cleanup
  tokenExpiresAt: Date,
  sticker: { type: String, default: '' },
  muted: { type: Boolean, default: false },
  nickChanges: { type: Number, default: 0 },
  lastChatAt: { type: Date, default: null },
  joinedAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  connected: { type: Boolean, default: false },
  score: { type: Number, default: 0 },
  correctCount: { type: Number, default: 0 },
  answeredCount: { type: Number, default: 0 },
  streak: { type: Number, default: 0 },
  bestStreak: { type: Number, default: 0 },
  totalResponseMs: { type: Number, default: 0 },
  lastScoredIndex: { type: Number, default: -1 }, // guards against scoring a question twice
});
playerSchema.index({ roomId: 1, nicknameKey: 1 }, { unique: true });

export const Player = mongoose.model('Player', playerSchema);
