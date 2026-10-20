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

export default r;
