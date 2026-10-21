import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtect } from '../middleware/security.js';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { generateQuestions } from '../services/aiService.js';
import { asyncHandler, ok } from '../utils/misc.js';
import { AppError } from '../utils/errors.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 8 } });
const limiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => env.rateLimitDisabled, keyGenerator: (req) => String(req.user?._id || req.ip),
  handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many generations in a minute. Wait a moment.' } }) });

const bool = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true');
const body = z.object({
  text: z.string().max(60000).optional(),
  count: z.coerce.number().int().min(1).max(50).default(10),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  images: bool.default(true),
  timeLimit: z.coerce.number().refine((n) => [10, 15, 20, 30].includes(n)).default(20),
}).strict();

const r = Router();
r.use(requireAuth, csrfProtect);
r.post('/generate', limiter, (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  next(err.code === 'LIMIT_FILE_SIZE' ? new AppError(413, 'FILE_TOO_LARGE', 'Files can be up to 5 MB') : new AppError(400, 'BAD_UPLOAD', 'That upload couldn’t be read'));
}), asyncHandler(async (req, res) => {
  const parsed = body.parse(req.body || {});
  if (!req.file && !parsed.text) throw new AppError(400, 'NO_SOURCE', 'Paste some text or upload a document');
  ok(res, await generateQuestions(req.user, { ...parsed, file: req.file }));
}));
export default r;
