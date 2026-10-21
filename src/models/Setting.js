import mongoose from 'mongoose';
// Admin-editable platform settings, one document per group (features, chat, billing, ai).
const settingSchema = new mongoose.Schema({ key: { type: String, required: true, unique: true }, value: { type: mongoose.Schema.Types.Mixed, default: {} } }, { timestamps: true });
export const Setting = mongoose.model('Setting', settingSchema);
