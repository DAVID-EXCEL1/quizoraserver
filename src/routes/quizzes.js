import { Router } from 'express';
import * as svc from '../services/quizService.js';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtect } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import { quizSchema, quizListQuery } from '../validators/quiz.js';
import { objectId } from '../validators/common.js';
import { asyncHandler, ok } from '../utils/misc.js';
import { AppError } from '../utils/errors.js';

const r = Router();
r.use(requireAuth, csrfProtect);

const idParam = (req, res, next) => {
  const p = objectId.safeParse(req.params.id);
  if (!p.success) return next(new AppError(404, 'NOT_FOUND', 'Quiz not found'));
  next();
};

r.get('/', validate(quizListQuery, 'query'), asyncHandler(async (req, res) => ok(res, await svc.list(req.user._id, req.valid.query))));
r.post('/', validate(quizSchema), asyncHandler(async (req, res) => ok(res, await svc.create(req.user._id, req.valid.body), 201)));
r.get('/:id', idParam, asyncHandler(async (req, res) => ok(res, svc.fullQuiz(await svc.getOwned(req.user._id, req.params.id)))));
r.put('/:id', idParam, validate(quizSchema), asyncHandler(async (req, res) => ok(res, await svc.update(req.user._id, req.params.id, req.valid.body))));
r.delete('/:id', idParam, asyncHandler(async (req, res) => { await svc.remove(req.user._id, req.params.id); ok(res, { deleted: true }); }));
r.post('/:id/duplicate', idParam, asyncHandler(async (req, res) => ok(res, await svc.duplicate(req.user._id, req.params.id), 201)));
r.post('/:id/publish', idParam, asyncHandler(async (req, res) => ok(res, await svc.setStatus(req.user._id, req.params.id, 'published'))));
r.post('/:id/unpublish', idParam, asyncHandler(async (req, res) => ok(res, await svc.setStatus(req.user._id, req.params.id, 'draft'))));

export default r;
