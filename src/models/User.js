import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
  emailVerified: { type: Boolean, default: false },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  failedLoginCount: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null },
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
