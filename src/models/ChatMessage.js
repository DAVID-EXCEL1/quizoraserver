import mongoose from 'mongoose';
const chatSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, required: true },
  authorType: { type: String, enum: ['player', 'host', 'system'], required: true },
  authorId: { type: mongoose.Schema.Types.ObjectId },
  nickname: { type: String, required: true, maxlength: 80 },
  sticker: { type: String, default: '' },
  text: { type: String, required: true, maxlength: 500 },
  deleted: { type: Boolean, default: false },
  deletedBy: { type: String },
}, { timestamps: { createdAt: true, updatedAt: false } });
chatSchema.index({ roomId: 1, createdAt: 1 });
export const ChatMessage = mongoose.model('ChatMessage', chatSchema);
