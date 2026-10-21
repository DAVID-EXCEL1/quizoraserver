import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { csrfProtect } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import { objectId, pin } from '../validators/common.js';
import * as svc from '../services/adminService.js';
import { asyncHandler, ok } from '../utils/misc.js';
import { AppError } from '../utils/errors.js';
import { getSettings } from '../services/settings.js';
import { env } from '../config/env.js';

const r = Router();
r.use(requireAuth, csrfProtect, requireAdmin);

const paging = { page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(15), search: z.string().trim().max(100).optional() };
const userQuery = z.object({ ...paging, status: z.enum(['active', 'suspended']).optional(), role: z.enum(['host', 'admin']).optional() });
const quizQuery = z.object({ ...paging, status: z.enum(['draft', 'published']).optional() });
const auditQuery = z.object({ ...paging, action: z.string().trim().max(40).regex(/^[a-z_.]*$/).optional() });
const reasonBody = z.object({ reason: z.string().trim().max(300).optional() }).strict();
const roleBody = z.object({ role: z.enum(['host', 'admin']) }).strict();

const id = (req, res, next) => (objectId.safeParse(req.params.id).success ? next() : next(new AppError(404, 'NOT_FOUND', 'Not found')));
const code = (req, res, next) => { const p = pin.safeParse(req.params.code); if (!p.success) return next(new AppError(404, 'NOT_FOUND', 'Game not found')); req.params.code = p.data; next(); };
const ip = (req) => req.ip;
const done = (res) => ok(res, { done: true });

r.get('/me', (req, res) => ok(res, { admin: true }));
r.get('/stats', asyncHandler(async (req, res) => ok(res, await svc.stats())));

// users
r.get('/users', validate(userQuery, 'query'), asyncHandler(async (req, res) => ok(res, await svc.listUsers(req.valid.query))));
r.get('/users/:id', id, asyncHandler(async (req, res) => ok(res, await svc.userDetail(req.params.id))));
r.post('/users/:id/suspend', id, validate(reasonBody), asyncHandler(async (req, res) => { await svc.suspendUser(req.user, req.params.id, req.valid.body.reason, ip(req)); done(res); }));
r.post('/users/:id/reinstate', id, asyncHandler(async (req, res) => { await svc.reinstateUser(req.user, req.params.id, ip(req)); done(res); }));
r.post('/users/:id/verify-email', id, asyncHandler(async (req, res) => { await svc.verifyUserEmail(req.user, req.params.id, ip(req)); done(res); }));
r.post('/users/:id/revoke-sessions', id, asyncHandler(async (req, res) => { await svc.revokeUserSessions(req.user, req.params.id, ip(req)); done(res); }));
r.post('/users/:id/role', id, validate(roleBody), asyncHandler(async (req, res) => { await svc.setUserRole(req.user, req.params.id, req.valid.body.role, ip(req)); done(res); }));
r.delete('/users/:id', id, asyncHandler(async (req, res) => { await svc.deleteUser(req.user, req.params.id, ip(req)); done(res); }));

// quizzes
r.get('/quizzes', validate(quizQuery, 'query'), asyncHandler(async (req, res) => ok(res, await svc.listQuizzes(req.valid.query))));
r.get('/quizzes/:id', id, asyncHandler(async (req, res) => ok(res, await svc.quizDetail(req.params.id))));
r.post('/quizzes/:id/unpublish', id, validate(reasonBody), asyncHandler(async (req, res) => { await svc.unpublishQuiz(req.user, req.params.id, req.valid.body.reason, ip(req)); done(res); }));
r.delete('/quizzes/:id', id, validate(reasonBody), asyncHandler(async (req, res) => { await svc.deleteQuiz(req.user, req.params.id, req.valid.body.reason, ip(req)); done(res); }));

// live rooms
r.get('/rooms', asyncHandler(async (req, res) => ok(res, await svc.liveRooms())));
r.get('/rooms/:code', code, asyncHandler(async (req, res) => ok(res, await svc.roomDetail(req.params.code))));
r.post('/rooms/:code/end', code, validate(reasonBody), asyncHandler(async (req, res) => { await svc.endRoom(req.user, req.params.code, req.valid.body.reason, ip(req)); done(res); }));
r.post('/rooms/:code/players/:playerId/kick', code, (req, res, n) => (objectId.safeParse(req.params.playerId).success ? n() : n(new AppError(404, 'NOT_FOUND', 'Player not found'))), validate(reasonBody),
  asyncHandler(async (req, res) => { await svc.kickPlayer(req.user, req.params.code, req.params.playerId, req.valid.body.reason, ip(req)); done(res); }));

// finished games
r.get('/games', validate(z.object(paging), 'query'), asyncHandler(async (req, res) => ok(res, await svc.listGames(req.valid.query))));
r.delete('/games/:id', id, validate(reasonBody), asyncHandler(async (req, res) => { await svc.deleteGame(req.user, req.params.id, req.valid.body.reason, ip(req)); done(res); }));

// audit log: read-only by design
r.get('/audit', validate(auditQuery, 'query'), asyncHandler(async (req, res) => ok(res, await svc.listAudit(req.valid.query))));


/* ---- platform settings ---- */
const settingsBody = z.object({
  features: z.object({ chat: z.boolean(), stickers: z.boolean(), ai: z.boolean(), billing: z.boolean() }).partial().strict().optional(),
  chat: z.object({ maxLength: z.number().int().min(20).max(500), defaultMode: z.enum(['on', 'between', 'off']), cooldownMs: z.number().int().min(0).max(10000), blockedWords: z.array(z.string().trim().min(1).max(40)).max(300) }).partial().strict().optional(),
  billing: z.object({ currency: z.enum(['NGN', 'GHS', 'ZAR', 'KES', 'USD']) }).partial().strict().optional(),
  ai: z.object({ maxQuestions: z.number().int().min(1).max(50), imagesEnabled: z.boolean() }).partial().strict().optional(),
}).strict();
r.get('/settings', asyncHandler(async (req, res) => ok(res, { settings: await getSettings(), integrations: { paystack: !!env.paystack.secretKey, groq: !!env.groq.apiKey, pexels: !!env.pexelsKey, smtp: !!env.smtp.host, cloudinary: !!env.cloudinary.cloudName } })));
r.put('/settings', validate(settingsBody), asyncHandler(async (req, res) => ok(res, { settings: await svc.saveSettings(req.user, Object.fromEntries(Object.entries(req.valid.body).filter(([, v]) => v)), ip(req)) })));

/* ---- stickers ---- */
const emojiField = z.string().trim().min(1).max(16).refine((v) => /\p{Extended_Pictographic}/u.test(v), 'Use an emoji');
r.get('/stickers', asyncHandler(async (req, res) => ok(res, await svc.listStickers())));
r.post('/stickers', validate(z.object({ emoji: emojiField, label: z.string().trim().max(40).default(''), pack: z.string().trim().min(1).max(40).default('General') }).strict()), asyncHandler(async (req, res) => ok(res, await svc.addSticker(req.user, req.valid.body, ip(req)), 201)));
r.patch('/stickers/:id', id, validate(z.object({ label: z.string().trim().max(40), pack: z.string().trim().min(1).max(40), active: z.boolean(), order: z.number().int().min(0).max(100000) }).partial().strict()), asyncHandler(async (req, res) => ok(res, await svc.editSticker(req.user, req.params.id, req.valid.body, ip(req)))));
r.delete('/stickers/:id', id, asyncHandler(async (req, res) => { await svc.removeSticker(req.user, req.params.id, ip(req)); done(res); }));

/* ---- plans & billing ---- */
const lim = (max) => z.number().int().min(-1).max(max);
const planFields = {
  name: z.string().trim().min(1).max(60), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/, 'Use letters, numbers and dashes'), description: z.string().trim().max(300),
  priceMinor: z.number().int().min(0).max(1_000_000_000), currency: z.enum(['NGN', 'GHS', 'ZAR', 'KES', 'USD']), interval: z.enum(['monthly', 'yearly']),
  limits: z.object({ maxPlayersPerGame: lim(env.maxPlayersCeiling), maxQuizzes: lim(100000), maxQuestionsPerQuiz: lim(1000), aiGenerationsPerMonth: lim(100000) }).partial().strict(),
  features: z.object({ chat: z.boolean(), stickers: z.boolean(), ai: z.boolean() }).partial().strict(),
  active: z.boolean(), isDefault: z.boolean(), sortOrder: z.number().int().min(0).max(1000),
};
const planCreate = z.object({ ...planFields, description: planFields.description.default(''), priceMinor: planFields.priceMinor.default(0), interval: planFields.interval.default('monthly'), currency: planFields.currency.default('NGN'),
  limits: planFields.limits.default({}), features: planFields.features.default({}), active: planFields.active.default(true), isDefault: planFields.isDefault.default(false), sortOrder: planFields.sortOrder.default(0) }).strict();
r.get('/plans', asyncHandler(async (req, res) => ok(res, await svc.listPlans())));
r.post('/plans', validate(planCreate), asyncHandler(async (req, res) => ok(res, await svc.createPlan(req.user, req.valid.body, ip(req)), 201)));
r.patch('/plans/:id', id, validate(z.object(planFields).partial().strict()), asyncHandler(async (req, res) => ok(res, await svc.updatePlan(req.user, req.params.id, req.valid.body, ip(req)))));
r.delete('/plans/:id', id, asyncHandler(async (req, res) => { await svc.deletePlan(req.user, req.params.id, ip(req)); done(res); }));
r.get('/payments', validate(z.object({ ...paging, status: z.enum(['pending', 'success', 'failed']).optional() }), 'query'), asyncHandler(async (req, res) => ok(res, await svc.listPayments(req.valid.query))));
r.get('/subscribers', validate(z.object(paging), 'query'), asyncHandler(async (req, res) => ok(res, await svc.listSubscribers(req.valid.query))));

r.get('/users/:id/billing', id, asyncHandler(async (req, res) => ok(res, await svc.userBilling(req.params.id))));
r.post('/users/:id/plan', id, validate(z.object({ planId: objectId, endsAt: z.string().datetime().optional() }).strict()), asyncHandler(async (req, res) => {
  const endsAt = req.valid.body.endsAt ? new Date(req.valid.body.endsAt) : null;
  if (endsAt && endsAt <= new Date()) throw new AppError(400, 'BAD_DATE', 'The end date must be in the future');
  await svc.grantPlan(req.user, req.params.id, req.valid.body.planId, endsAt, ip(req)); done(res);
}));
r.delete('/users/:id/plan', id, asyncHandler(async (req, res) => { await svc.revokePlan(req.user, req.params.id, ip(req)); done(res); }));
r.put('/users/:id/limits', id, validate(z.object({ maxPlayersPerGame: lim(env.maxPlayersCeiling).nullable(), maxQuizzes: lim(100000).nullable(), maxQuestionsPerQuiz: lim(1000).nullable(), aiGenerationsPerMonth: lim(100000).nullable() }).partial().strict()),
  asyncHandler(async (req, res) => { await svc.setOverrides(req.user, req.params.id, req.valid.body, ip(req)); done(res); }));

/* ---- chat moderation inside a live room ---- */
r.get('/rooms/:code/chat', code, asyncHandler(async (req, res) => ok(res, await svc.roomChat(req.params.code))));
r.delete('/rooms/:code/chat/:messageId', code, (req, res, n) => (objectId.safeParse(req.params.messageId).success ? n() : n(new AppError(404, 'NOT_FOUND', 'Message not found'))), asyncHandler(async (req, res) => { await svc.deleteChat(req.user, req.params.code, req.params.messageId, ip(req)); done(res); }));
r.post('/rooms/:code/players/:playerId/mute', code, (req, res, n) => (objectId.safeParse(req.params.playerId).success ? n() : n(new AppError(404, 'NOT_FOUND', 'Player not found'))), validate(z.object({ muted: z.boolean() }).strict()),
  asyncHandler(async (req, res) => { await svc.mutePlayer(req.user, req.params.code, req.params.playerId, req.valid.body.muted, ip(req)); done(res); }));

export default r;
