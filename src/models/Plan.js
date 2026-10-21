import mongoose from 'mongoose';
// -1 means "unlimited" for every limit. Prices are in the currency's minor unit (kobo for NGN).
const planSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  slug: { type: String, required: true, unique: true, lowercase: true, maxlength: 40 },
  description: { type: String, default: '', maxlength: 300 },
  priceMinor: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'NGN', maxlength: 3 },
  interval: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
  limits: {
    maxPlayersPerGame: { type: Number, default: 10 },
    maxQuizzes: { type: Number, default: 5 },
    maxQuestionsPerQuiz: { type: Number, default: 10 },
    aiGenerationsPerMonth: { type: Number, default: 3 },
  },
  features: { chat: { type: Boolean, default: true }, stickers: { type: Boolean, default: true }, ai: { type: Boolean, default: true } },
  active: { type: Boolean, default: true },
  isDefault: { type: Boolean, default: false }, // the plan everyone without a subscription gets
  sortOrder: { type: Number, default: 0 },
  paystackPlanCode: { type: String },
}, { timestamps: true });
export const Plan = mongoose.model('Plan', planSchema);
