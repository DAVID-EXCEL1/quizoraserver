import mongoose from 'mongoose';

const answerSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
  qid: { type: String, required: true },
  questionIndex: { type: Number, required: true },
  optionKey: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  receivedAt: { type: Date, required: true }, // server clock only
  // Filled in by the scorer when the question closes
  isCorrect: { type: Boolean, default: null },
  points: { type: Number, default: 0 },
  responseMs: { type: Number, default: null },
  scoredAt: Date,
});
// One answer per player per question, enforced by the database.
answerSchema.index({ roomId: 1, playerId: 1, qid: 1 }, { unique: true });
answerSchema.index({ roomId: 1, qid: 1 });

export const Answer = mongoose.model('Answer', answerSchema);
