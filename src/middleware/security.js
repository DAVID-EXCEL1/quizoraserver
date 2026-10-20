import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { safeEqual } from '../utils/tokens.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Reject browser requests that originate from an origin we don't trust. */
export function originCheck(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !env.allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
    return next(new AppError(403, 'BAD_ORIGIN', 'Request origin is not allowed'));
  }
  next();
}

/**
 * Double-submit CSRF protection for cookie-authenticated requests.
 * The token lives in an HttpOnly cookie; the SPA gets the same value from
 * GET /api/auth/csrf (readable only by allowed origins via CORS) and echoes it
 * in X-CSRF-Token.
 */
export function csrfProtect(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const cookie = req.cookies?.qz_csrf;
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !safeEqual(cookie, header)) {
    return next(new AppError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token'));
  }
  next();
}
