import { Router } from 'express';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtect } from '../middleware/security.js';
import { AppError } from '../utils/errors.js';
import { ok } from '../utils/misc.js';

const r = Router();

/**
 * Signed direct-upload parameters for Cloudinary. The API secret never leaves the server;
 * the browser uploads straight to Cloudinary with this one-time signature.
 * The client enforces file type/size for UX; Cloudinary enforces it via the signed params.
 */
r.post('/sign', requireAuth, csrfProtect, (req, res, next) => {
  const c = env.cloudinary;
  if (!c.cloudName || !c.apiKey || !c.apiSecret) {
    return next(new AppError(503, 'UPLOADS_NOT_CONFIGURED', 'Image uploads are not configured on this server'));
  }
  const params = {
    allowed_formats: 'jpg,jpeg,png,webp,gif',
    folder: `quizora/${req.user._id}`,
    timestamp: Math.floor(Date.now() / 1000),
  };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + c.apiSecret).digest('hex');
  ok(res, { uploadUrl: `https://api.cloudinary.com/v1_1/${c.cloudName}/image/upload`, apiKey: c.apiKey, signature, maxBytes: 5 * 1024 * 1024, params });
});

export default r;
