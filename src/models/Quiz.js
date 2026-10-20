import mongoose from 'mongoose';

const optionSchema = new mongoose.Schema({
  key: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  text: { type: String, default: '', maxlength: 120 },
}, { _id: false });

const questionSchema = new mongoose.Schema({
  text: { type: String, default: '', maxlength: 300 },
  options: { type: [optionSchema], validate: (v) => v.length === 4 },
  correctKey: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  timeLimit: { type: Number, enum: [10, 15, 20, 30], default: 20 },
  basePoints: { type: Number, default: 1000, min: 1, max: 10000 },
  imageUrl: { type: String, default: null, maxlength: 500 },
});

const quizSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: '', maxlength: 500 },
  status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  questions: { type: [questionSchema], default: [] },
}, { timestamps: true });
quizSchema.index({ ownerId: 1, updatedAt: -1 });

export const Quiz = mongoose.model('Quiz', quizSchema);
