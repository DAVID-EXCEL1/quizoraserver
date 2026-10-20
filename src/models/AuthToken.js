import mongoose from 'mongoose';

// Email-verification and password-reset tokens. Only the SHA-256 hash is stored.
const authTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['verify_email', 'reset_password'], required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
}, { timestamps: true });
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export const AuthToken = mongoose.model('AuthToken', authTokenSchema);
