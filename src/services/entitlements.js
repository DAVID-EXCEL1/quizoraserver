import { User, Plan, Subscription } from '../models/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { getSettings } from './settings.js';

// Used when billing is switched off or no default plan exists: generous, bounded only by the server ceiling.
const BUILTIN = { name: 'Standard', slug: 'standard', limits: { maxPlayersPerGame: -1, maxQuizzes: -1, maxQuestionsPerQuiz: -1, maxAiQuestionsPerGeneration: 20, aiGenerationsPerMonth: -1 }, features: { chat: true, stickers: true, ai: true } };
const LIMIT_KEYS = ['maxPlayersPerGame', 'maxQuizzes', 'maxQuestionsPerQuiz', 'maxAiQuestionsPerGeneration', 'aiGenerationsPerMonth'];
const LIVE_SUB = ['active', 'non_renewing', 'past_due'];

/** What this host is currently allowed to do, resolved on the server every time. */
export async function entitlementsFor(userId) {
  const settings = await getSettings();
  const user = await User.findById(userId).select('planOverrides').lean();
  let plan = null; let source = 'free'; let periodEnd = null; let sub = null;
  if (settings.features.billing) {
    sub = await Subscription.findOne({ userId }).lean();
    if (sub && LIVE_SUB.includes(sub.status) && (!sub.currentPeriodEnd || sub.currentPeriodEnd > new Date())) {
      plan = await Plan.findById(sub.planId).lean();
      source = sub.source === 'admin' ? 'admin_grant' : 'subscription'; periodEnd = sub.currentPeriodEnd;
    }
    if (!plan) { source = 'free'; plan = await Plan.findOne({ isDefault: true }).lean(); }
  }
  const base = plan || BUILTIN;
  const limits = { ...base.limits };
  if (!Number.isInteger(limits.maxAiQuestionsPerGeneration)) {
    const quizLimit = base.limits?.maxQuestionsPerQuiz || 20;
    limits.maxAiQuestionsPerGeneration = base.isDefault ? 20 : quizLimit === -1 ? 100 : Math.min(100, Math.max(20, quizLimit));
  }
  for (const k of LIMIT_KEYS) if (Number.isInteger(user?.planOverrides?.[k])) limits[k] = user.planOverrides[k];
  limits.maxAiQuestionsPerGeneration = Math.min(100, Math.max(1, limits.maxAiQuestionsPerGeneration));
  limits.maxPlayersPerGame = limits.maxPlayersPerGame === -1 ? env.maxPlayersCeiling : Math.min(limits.maxPlayersPerGame, env.maxPlayersCeiling);
  const features = {
    chat: !!(settings.features.chat && base.features?.chat),
    stickers: !!(settings.features.stickers && base.features?.stickers),
    ai: !!(settings.features.ai && base.features?.ai),
  };
  return {
    plan: plan ? { id: String(plan._id), name: plan.name, slug: plan.slug } : { id: null, name: base.name, slug: base.slug },
    source, periodEnd, subscriptionStatus: sub?.status || null,
    autoRenew: sub ? (sub.autoRenew ?? Boolean(sub.paystackSubscriptionCode)) : false,
    limits, features, overridden: LIMIT_KEYS.filter((k) => Number.isInteger(user?.planOverrides?.[k])),
  };
}

export const limitReached = (max, used) => max !== -1 && used >= max;

export function planLimit(key, max, message) {
  return new AppError(402, 'PLAN_LIMIT', message, { limit: key, max });
}
