import mongoose from 'mongoose';

// Append-only record of administrative actions. There is deliberately no update/delete route for it.
const auditSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, index: true },
  adminEmail: { type: String, required: true },
  action: { type: String, required: true, index: true }, // e.g. user.suspend, quiz.delete, room.end
  targetType: { type: String, enum: ['user', 'quiz', 'room', 'player', 'game', 'system'], required: true },
  targetId: String,
  targetLabel: { type: String, maxlength: 200 },
  details: { type: mongoose.Schema.Types.Mixed },
  ip: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
auditSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditSchema);
