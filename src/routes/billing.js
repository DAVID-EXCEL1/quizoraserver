import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtect } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import { objectId } from '../validators/common.js';
import * as billing from '../services/billingService.js';
import { validSignature } from '../services/paystack.js';
import { getSettings } from '../services/settings.js';
import { groupedActive } from '../services/stickers.js';
import { paystackConfigured } from '../services/paystack.js';
import { env } from '../config/env.js';
import { asyncHandler, ok } from '../utils/misc.js';
import { log } from '../utils/logger.js';

const r = Router();
r.use(requireAuth, csrfProtect);
r.get('/', asyncHandler(async (req, res) => ok(res, await billing.overview(req.user))));
r.post('/checkout', validate(z.object({ planId: objectId }).strict()), asyncHandler(async (req, res) => ok(res, await billing.startCheckout(req.user, req.valid.body.planId))));
r.post('/verify', validate(z.object({ reference: z.string().min(6).max(80) }).strict()), asyncHandler(async (req, res) => ok(res, await billing.verifyAndActivate(req.user, req.valid.body.reference))));
r.post('/cancel', asyncHandler(async (req, res) => ok(res, await billing.cancelSubscription(req.user))));
export default r;

/** Mounted in app.js BEFORE express.json(): the signature is computed over the exact raw bytes. */
export const paystackWebhook = [
  express.raw({ type: '*/*', limit: '200kb' }),
  async (req, res) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || !validSignature(raw, req.get('x-paystack-signature'))) return res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid signature' } });
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed body' } }); }
    try { await billing.handleWebhook(event); } catch (e) { log.error('webhook handling failed', event?.event, e.message); return res.status(500).json({ error: { code: 'WEBHOOK_FAILED', message: 'Try again' } }); }
    res.json({ received: true });
  },
];

/** Public, non-secret config the SPA needs (feature switches, sticker packs). */
export const publicConfig = asyncHandler(async (req, res) => {
  const s = await getSettings();
  ok(res, { features: s.features, chat: { maxLength: s.chat.maxLength }, currency: s.billing.currency, paymentsConfigured: paystackConfigured(), aiMaxQuestions: s.ai.maxQuestions, stickers: s.features.stickers ? await groupedActive() : [], maxPlayersCeiling: env.maxPlayersCeiling });
});
