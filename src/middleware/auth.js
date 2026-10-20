import { verifyAccessToken, userFromAccessPayload } from '../services/authService.js';
import { unauthorized } from '../utils/errors.js';

/** Host authentication: short-lived access JWT in an HttpOnly cookie, re-checked against the DB. */
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.qz_at;
    if (!token) throw unauthorized();
    let payload;
    try { payload = verifyAccessToken(token); } catch { throw unauthorized('Session expired', 'TOKEN_EXPIRED'); }
    req.user = await userFromAccessPayload(payload);
    req.auth = { familyId: payload.fid };
    next();
  } catch (err) { next(err); }
}
