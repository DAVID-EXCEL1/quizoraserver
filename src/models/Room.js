import mongoose from 'mongoose';

export const ROOM_STATUS = ['LOBBY', 'QUESTION_ACTIVE', 'QUESTION_RESULT', 'LEADERBOARD', 'GAME_OVER', 'EXPIRED'];

const snapshotQuestion = new mongoose.Schema({
  qid: { type: String, required: true },
  text: String,
  options: [{ _id: false, key: String, text: String }],
  correctKey: String,
  timeLimit: Number,
  basePoints: Number,
  imageUrl: { type: String, default: null },
}, { _id: false });

const roomSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, match: /^[A-Z0-9]{6}$/ },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' }, // reference only; content lives in the snapshot
  // Immutable copy of the quiz at launch. Never rewritten after creation.
  snapshot: {
    title: { type: String, required: true },
    description: String,
    questions: [snapshotQuestion],
  },
  maxPlayers: { type: Number }, // from the host's plan at launch
  features: { chat: { type: Boolean, default: true }, stickers: { type: Boolean, default: true } },
  chatMode: { type: String, enum: ['on', 'between', 'off'], default: 'between' },
  showQuestionsToPlayers: { type: Boolean, default: true },
  locationOptions: { type: [String], default: [] },
  status: { type: String, enum: ROOM_STATUS, default: 'LOBBY' },
  currentQuestionIndex: { type: Number, default: -1 },
  scoredQuestionIndex: { type: Number, default: -1 },
  scoringPending: { type: Boolean, default: false }, // set when a question closes, cleared once scored (crash repair)
  resultPending: { type: Boolean, default: false }, // set at GAME_OVER, cleared once GameResult is saved
  questionStartedAt: Date,
  questionDeadline: Date,
  questionClosedAt: Date,
  startedAt: Date,
  lastActivityAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  completedAt: Date,
  expiredAt: Date,
  expiredReason: String,
  purgeAt: Date, // TTL: the room document is deleted after this; GameResult is kept.
}, { timestamps: { createdAt: true, updatedAt: false } });

roomSchema.index({ hostId: 1, createdAt: -1 });
roomSchema.index({ status: 1, expiresAt: 1 });
roomSchema.index({ status: 1, questionDeadline: 1 });
roomSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const Room = mongoose.model('Room', roomSchema);
