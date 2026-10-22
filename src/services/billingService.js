import { Plan, Subscription, Payment, User, Quiz, Usage } from '../models/index.js';
import { env } from '../config/env.js';
import { AppError, notFound } from '../utils/errors.js';
import { randomToken } from '../utils/tokens.js';
import { log } from '../utils/logger.js';
import { entitlementsFor } from './entitlements.js';
import { getSettings } from './settings.js';
import * as ps from './paystack.js';

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export function addInterval(from, interval) {
  const d = new Date(from);
  if (interval === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export const planView = (p) => ({
  id: String(p._id), name: p.name, slug: p.slug, description: p.description, priceMinor: p.priceMinor, currency: p.currency, interval: p.interval,
  limits: p.limits, features: p.features, active: p.active, isDefault: p.isDefault, sortOrder: p.sortOrder, hasPaystackPlan: !!p.paystackPlanCode,
});

/** Seed three sensible plans on first run. Admins can change or replace all of them. */
export async function seedPlans() {
  if (await Plan.countDocuments({}) > 0) return 0;
  const { billing } = await getSettings();
  const base = { currency: billing.currency };
  await Plan.insertMany([
    { ...base, name: 'Free', slug: 'free', description: 'Try Quizora with small groups.', priceMinor: 0, isDefault: true, sortOrder: 0, limits: { maxPlayersPerGame: 10, maxQuizzes: 5, maxQuestionsPerQuiz: 10, aiGenerationsPerMonth: 3 }, features: { chat: true, stickers: true, ai: true } },
    { ...base, name: 'Pro', slug: 'pro', description: 'For teachers, trainers and communities.', priceMinor: 500000, sortOrder: 1, limits: { maxPlayersPerGame: 100, maxQuizzes: 100, maxQuestionsPerQuiz: 50, aiGenerationsPerMonth: 50 }, features: { chat: true, stickers: true, ai: true } },
    { ...base, name: 'Business', slug: 'business', description: 'Large events and organisations.', priceMinor: 1500000, sortOrder: 2, limits: { maxPlayersPerGame: 500, maxQuizzes: -1, maxQuestionsPerQuiz: 100, aiGenerationsPerMonth: 300 }, features: { chat: true, stickers: true, ai: true } },
  ]);
  return 3;
}

export async function overview(user) {
  const [ent, plans, sub, quizzes, usage, settings] = await Promise.all([
    entitlementsFor(user._id), Plan.find({ active: true }).sort({ sortOrder: 1, priceMinor: 1 }).lean(), Subscription.findOne({ userId: user._id }).lean(),
    Quiz.countDocuments({ ownerId: user._id }), Usage.countDocuments({ userId: user._id, month: monthKey() }), getSettings(),
  ]);
  return {
    billingEnabled: settings.features.billing, paymentsConfigured: ps.paystackConfigured(), currency: settings.billing.currency,
    entitlements: ent, usage: { quizzes, aiThisMonth: usage },
    subscription: sub ? { status: sub.status, source: sub.source, currentPeriodEnd: sub.currentPeriodEnd, planId: String(sub.planId) } : null,
    plans: plans.map(planView),
  };
}

async function ensurePaystackPlan(plan) {
  if (plan.paystackPlanCode) return plan.paystackPlanCode;
  const data = await ps.createPlan({ name: plan.name, amountMinor: plan.priceMinor, currency: plan.currency, interval: plan.interval });
  await Plan.updateOne({ _id: plan._id }, { $set: { paystackPlanCode: data.plan_code } });
  return data.plan_code;
}

export async function startCheckout(user, planId) {
  const settings = await getSettings();
  if (!settings.features.billing) throw new AppError(403, 'BILLING_OFF', 'Billing is turned off');
  const plan = await Plan.findOne({ _id: planId, active: true });
  if (!plan) throw notFound('Plan');
  if (plan.isDefault || plan.priceMinor <= 0) throw new AppError(400, 'FREE_PLAN', 'That plan is free; there’s nothing to pay for');
  const planCode = await ensurePaystackPlan(plan);
  const reference = `qz_${randomToken(12)}`;
  await Payment.create({ reference, userId: user._id, planId: plan._id, planName: plan.name, amountMinor: plan.priceMinor, currency: plan.currency, status: 'pending' });
  const tx = await ps.initTransaction({
    email: user.email, amountMinor: plan.priceMinor, currency: plan.currency, planCode, reference,
    callbackUrl: `${env.clientUrl}/billing/callback`, metadata: { planId: String(plan._id) }, // metadata is informational; our Payment row is the source of truth
  });
  return { authorizationUrl: tx.authorization_url, reference };
}

/** Idempotent: only the caller that flips pending -> success activates the plan. Never trusts client or webhook metadata for who/what. */
export async function activateFromTransaction(payment, tx) {
  if (tx.status !== 'success') return { activated: false, reason: tx.status };
  if (tx.currency !== payment.currency || Number(tx.amount) < payment.amountMinor) {
    await Payment.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed' } });
    log.error('payment amount/currency mismatch for', payment.reference);
    return { activated: false, reason: 'mismatch' };
  }
  const won = await Payment.findOneAndUpdate({ _id: payment._id, status: 'pending' }, { $set: { status: 'success', paidAt: new Date(), paystackTransactionId: String(tx.id ?? '') } });
  if (!won) return { activated: false, reason: 'already_processed' };
  const plan = await Plan.findById(payment.planId).lean();
  await Subscription.updateOne({ userId: payment.userId }, {
    $set: { planId: payment.planId, status: 'active', source: 'paystack', currentPeriodEnd: addInterval(new Date(), plan?.interval), paystackCustomerCode: tx.customer?.customer_code, lastPaymentAt: new Date() },
  }, { upsert: true });
  return { activated: true };
}

export async function verifyAndActivate(user, reference) {
  const payment = await Payment.findOne({ reference, userId: user._id }); // another user's reference looks like "not found"
  if (!payment) throw notFound('Payment');
  if (payment.status === 'pending') {
    const tx = await ps.verifyTransaction(reference);
    await activateFromTransaction(payment, tx);
  }
  return { status: (await Payment.findById(payment._id)).status, entitlements: await entitlementsFor(user._id) };
}

export async function cancelSubscription(user) {
  const sub = await Subscription.findOne({ userId: user._id }).select('+emailToken');
  if (!sub || sub.source !== 'paystack') throw new AppError(404, 'NO_SUBSCRIPTION', 'You don’t have a paid subscription to cancel');
  if (sub.paystackSubscriptionCode && sub.emailToken) await ps.disableSubscription({ code: sub.paystackSubscriptionCode, token: sub.emailToken });
  await Subscription.updateOne({ _id: sub._id }, { $set: { status: 'non_renewing' } }); // access continues until the period ends
  return { status: 'non_renewing', currentPeriodEnd: sub.currentPeriodEnd };
}

/* ------------------------------------------------------------------ webhooks */
async function userForCustomer(customer) {
  if (!customer) return null;
  const sub = customer.customer_code ? await Subscription.findOne({ paystackCustomerCode: customer.customer_code }) : null;
  if (sub) return { userId: sub.userId, sub };
  const u = customer.email ? await User.findOne({ email: String(customer.email).toLowerCase() }).select('_id').lean() : null;
  return u ? { userId: u._id, sub: await Subscription.findOne({ userId: u._id }) } : null;
}

async function onCharge(data) {
  const payment = await Payment.findOne({ reference: data.reference });
  if (payment) return activateFromTransaction(payment, data);
  if (data.status !== 'success') return null;
  // A renewal charge made by Paystack's subscription engine: extend the matching subscription.
  const found = await userForCustomer(data.customer);
  if (!found?.sub || found.sub.source !== 'paystack') return null;
  const plan = (data.plan?.plan_code && await Plan.findOne({ paystackPlanCode: data.plan.plan_code })) || await Plan.findById(found.sub.planId);
  if (!plan) return null;
  try {
    await Payment.create({ reference: data.reference, userId: found.userId, planId: plan._id, planName: plan.name, kind: 'renewal', amountMinor: Number(data.amount), currency: data.currency, status: 'success', paidAt: new Date(), paystackTransactionId: String(data.id ?? '') });
  } catch (e) { if (e.code === 11000) return null; throw e; } // duplicate delivery of the same event
  const from = found.sub.currentPeriodEnd && found.sub.currentPeriodEnd > new Date() ? found.sub.currentPeriodEnd : new Date();
  await Subscription.updateOne({ _id: found.sub._id }, { $set: { planId: plan._id, status: 'active', currentPeriodEnd: addInterval(from, plan.interval), lastPaymentAt: new Date() } });
  return { renewed: true };
}

async function onSubscriptionCreate(data) {
  const found = await userForCustomer(data.customer);
  if (!found) return null;
  const plan = data.plan?.plan_code ? await Plan.findOne({ paystackPlanCode: data.plan.plan_code }) : null;
  const set = { paystackSubscriptionCode: data.subscription_code, emailToken: data.email_token, paystackCustomerCode: data.customer?.customer_code };
  if (data.next_payment_date) set.currentPeriodEnd = new Date(data.next_payment_date);
  if (found.sub) return Subscription.updateOne({ _id: found.sub._id }, { $set: set });
  if (!plan) return null;
  return Subscription.updateOne({ userId: found.userId }, { $set: { ...set, planId: plan._id, status: 'active', source: 'paystack' } }, { upsert: true });
}

async function onSubscriptionEnd(data) {
  const found = await userForCustomer(data.customer);
  if (found?.sub?.source === 'paystack') await Subscription.updateOne({ _id: found.sub._id }, { $set: { status: 'non_renewing' } });
}

async function onPaymentFailed(data) {
  const found = await userForCustomer(data.customer || data.subscription?.customer);
  if (found?.sub?.source === 'paystack' && found.sub.status === 'active') await Subscription.updateOne({ _id: found.sub._id }, { $set: { status: 'past_due' } });
}

export async function handleWebhook(event) {
  switch (event?.event) {
    case 'charge.success': return onCharge(event.data);
    case 'subscription.create': return onSubscriptionCreate(event.data);
    case 'subscription.disable': case 'subscription.not_renew': return onSubscriptionEnd(event.data);
    case 'invoice.payment_failed': return onPaymentFailed(event.data);
    default: return null; // acknowledged and ignored
  }
}
