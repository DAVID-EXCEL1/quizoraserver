import mongoose from 'mongoose';
const stickerSchema = new mongoose.Schema({
  emoji: { type: String, required: true, unique: true, maxlength: 16 },
  label: { type: String, default: '', maxlength: 40 },
  pack: { type: String, default: 'General', maxlength: 40 },
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
}, { timestamps: true });
export const Sticker = mongoose.model('Sticker', stickerSchema);
