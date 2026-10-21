import mongoose from 'mongoose';
// One document per AI generation used in a month. The unique (user, month, slot) index is what makes the quota
// safe under parallel requests: two requests can never claim the same slot, so nobody can exceed the limit.
const usageSchema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, required: true }, month: { type: String, required: true }, slot: { type: Number, required: true }, at: { type: Date, default: Date.now } });
usageSchema.index({ userId: 1, month: 1, slot: 1 }, { unique: true });
export const Usage = mongoose.model('Usage', usageSchema);
