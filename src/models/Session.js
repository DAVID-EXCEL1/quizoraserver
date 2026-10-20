import mongoose from 'mongoose';

// One row per refresh token. Rotation creates a new row in the same family; reuse of a
// rotated token revokes the whole family.
const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  familyId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  userAgent: { type: String, maxlength: 300 },
}, { timestamps: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const Session = mongoose.model('Session', sessionSchema);
