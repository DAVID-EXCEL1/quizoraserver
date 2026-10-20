import { Router } from 'express';
import { env } from '../config/env.js';
import { User } from '../models/index.js';
import * as auth from '../services/authService.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtect } from '../middleware/security.js';
import { authLimiter, forgotLimiter } from '../middleware/rateLimit.js';
import * as v from '../validators/auth.js';
import { asyncHandler, ok } from '../utils/misc.js';
import { randomToken } from '../utils/tokens.js';
import { emailConfigured } from '../services/mailer.js';

const r = Router();
const base = () => ({ httpOnly: true, secure: env.cookie.secure, sameSite: env.cookie.sameSite, domain: env.cookie.domain });

function setSessionCookies(res, { accessToken, refreshToken }) {
  res.cookie('qz_at', accessToken, { ...base(), path: '/', maxAge: env.accessTtlSec * 1000 });
  res.cookie('qz_rt', refreshToken, { ...base(), path: '/api/auth', maxAge: env.refreshTtlMs });
  const csrf = randomToken(24);
  res.cookie('qz_csrf', csrf, { ...base(), path: '/', maxAge: env.refreshTtlMs });
  return csrf;
}
function clearSessionCookies(res) {
  for (const [name, path] of [['qz_at', '/'], ['qz_rt', '/api/auth'], ['qz_csrf', '/']]) {
    res.clearCookie(name, { ...base(), path });
  }
}
const ua = (req) => req.get('user-agent');

r.get('/csrf', (req, res) => {
  let t = req.cookies?.qz_csrf;
  if (!t) {
    t = randomToken(24);
    res.cookie('qz_csrf', t, { ...base(), path: '/', maxAge: env.refreshTtlMs });
  }
  ok(res, { csrfToken: t, emailDeliveryConfigured: emailConfigured() });
});

r.post('/register', authLimiter, validate(v.registerSchema), asyncHandler(async (req, res) => {
  const { user, emailDelivery } = await auth.register(req.valid.body);
  const session = await auth.issueSession(user, { userAgent: ua(req) });
  const csrfToken = setSessionCookies(res, session);
  ok(res, { user: auth.publicUser(user), csrfToken, emailDelivery }, 201);
}));

r.post('/login', authLimiter, validate(v.loginSchema), asyncHandler(async (req, res) => {
  const user = await auth.login(req.valid.body);
  const session = await auth.issueSession(user, { userAgent: ua(req) });
  const csrfToken = setSessionCookies(res, session);
  ok(res, { user: auth.publicUser(user), csrfToken });
}));

r.post('/refresh', csrfProtect, asyncHandler(async (req, res) => {
  try {
    const s = await auth.refresh(req.cookies?.qz_rt, { userAgent: ua(req) });
    const csrfToken = setSessionCookies(res, s);
    ok(res, { user: auth.publicUser(s.user), csrfToken });
  } catch (err) {
    if (err.code !== 'REFRESH_CONFLICT') clearSessionCookies(res);
    throw err;
  }
}));

r.post('/logout', csrfProtect, asyncHandler(async (req, res) => {
  const raw = req.cookies?.qz_rt;
  if (raw) {
    const { Session } = await import('../models/index.js');
    const { sha256 } = await import('../utils/tokens.js');
    const s = await Session.findOne({ tokenHash: sha256(raw) });
    if (s) await auth.revokeFamily(s.familyId);
  }
  clearSessionCookies(res);
  ok(res, { loggedOut: true });
}));

r.post('/forgot-password', forgotLimiter, validate(v.forgotSchema), asyncHandler(async (req, res) => {
  await auth.requestPasswordReset(req.valid.body.email);
  ok(res, { message: 'If an account exists for that email, a reset link is on its way.' });
}));

r.post('/reset-password', authLimiter, validate(v.resetSchema), asyncHandler(async (req, res) => {
  await auth.resetPassword(req.valid.body.token, req.valid.body.password);
  ok(res, { message: 'Password updated. Please sign in.' });
}));

r.post('/verify-email', authLimiter, validate(v.tokenSchema), asyncHandler(async (req, res) => {
  await auth.verifyEmail(req.valid.body.token);
  ok(res, { verified: true });
}));

// ---- authenticated ----
r.use(requireAuth, csrfProtect);

r.get('/me', (req, res) => ok(res, { user: auth.publicUser(req.user), emailDeliveryConfigured: emailConfigured() }));

r.patch('/me', validate(v.profileSchema), asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.user._id, { $set: { fullName: req.valid.body.fullName } }, { new: true });
  ok(res, { user: auth.publicUser(user) });
}));

r.post('/resend-verification', authLimiter, asyncHandler(async (req, res) => {
  if (req.user.emailVerified) return ok(res, { emailDelivery: 'already_verified' });
  const emailDelivery = await auth.sendVerificationEmail(req.user);
  ok(res, { emailDelivery });
}));

r.patch('/password', authLimiter, validate(v.changePasswordSchema), asyncHandler(async (req, res) => {
  const s = await auth.changePassword(req.user._id, req.valid.body.currentPassword, req.valid.body.password, { userAgent: ua(req) });
  const csrfToken = setSessionCookies(res, s);
  ok(res, { message: 'Password changed. Other devices were signed out.', csrfToken });
}));

r.post('/logout-all', asyncHandler(async (req, res) => {
  await auth.revokeAllForUser(req.user._id);
  clearSessionCookies(res);
  ok(res, { loggedOut: true });
}));

export default r;
