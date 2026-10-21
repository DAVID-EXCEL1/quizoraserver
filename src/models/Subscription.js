import mongoose from 'mongoose';
// One row per user. "admin" source = comped/granted by an administrator.
const subSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  status: { type: String, enum: ['active', 'non_renewing', 'past_due', 'canceled'], default: 'active' },
  source: { type: String, enum: ['paystack', 'admin'], default: 'paystack' },
  currentPeriodEnd: { type: Date, default: null }, // null = no expiry (admin grants only)
  paystackCustomerCode: { type: String, index: true },
  paystackSubscriptionCode: { type: String },
  emailToken: { type: String, select: false },
  lastPaymentAt: Date,
}, { timestamps: true });
export const Subscription = mongoose.model('Subscription', subSchema);
