import mongoose from 'mongoose';
const paymentSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true }, // idempotency key
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  planId: { type: mongoose.Schema.Types.ObjectId },
  planName: String,
  kind: { type: String, enum: ['checkout', 'renewal'], default: 'checkout' },
  amountMinor: { type: Number, required: true },
  currency: { type: String, required: true },
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  paidAt: Date,
  paystackTransactionId: String,
}, { timestamps: true });
paymentSchema.index({ createdAt: -1 });
export const Payment = mongoose.model('Payment', paymentSchema);
