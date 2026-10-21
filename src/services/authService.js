import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { User, Session, AuthToken } from '../models/index.js';
import { AppError, unauthorized } from '../utils/errors.js';
import { randomToken, sha256 } from '../utils/tokens.js';
import { emailConfigured, sendMail } from './mailer.js';
import { log } from '../utils/logger.js';

const dummyHash = bcrypt.hashSync('not-a-real-password-for-timing', env.bcryptRounds);
const VERIFY_TTL = 24 * 3600 * 1000;
const RESET_TTL = 60 * 60 * 1000;

export const publicUser = (u) => ({
  id: String(u._id), fullName: u.fullName, email: u.email, emailVerified: !!u.emailVerified, status: u.status, role: u.role || 'host', sticker: u.sticker || '',
  createdAt: u.createdAt,
});

// ---------- sessions ----------
export async function issueSession(user, { userAgent, familyId } = {}) {
  const refreshToken = randomToken(48);
  const fid = familyId || crypto.randomUUID();
  await Session.create({
    userId: user._id, familyId: fid, tokenHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + env.refreshTtlMs), userAgent: userAgent?.slice(0, 300),
  });
  const accessToken = jwt.sign({ sub: String(user._id), fid }, env.jwtAccessSecret, {
    algorithm: 'HS256', expiresIn: env.accessTtlSec, issuer: env.jwtIssuer, audience: env.jwtAudience,
  });
  return { accessToken, refreshToken, familyId: fid };
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret, { algorithms: ['HS256'], issuer: env.jwtIssuer, audience: env.jwtAudience });
}

export const revokeFamily = (familyId) => Session.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
export const revokeAllForUser = (userId) => Session.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
export const familyActive = async (familyId) => !!(await Session.exists({ familyId, revokedAt: null, expiresAt: { $gt: new Date() } }));

/** Resolve a verified access-token payload to an active user, or throw. */
export async function userFromAccessPayload(payload) {
  const user = await User.findById(payload.sub).lean();
  if (!user || user.status !== 'active') throw unauthorized('Account unavailable');
  if (user.passwordChangedAt && payload.iat * 1000 < +user.passwordChangedAt) throw unauthorized('Session expired', 'SESSION_EXPIRED');
  if (!(await familyActive(payload.fid))) throw unauthorized('Session expired', 'SESSION_EXPIRED');
  return user;
}

export async function refresh(rawRefresh, ctx) {
  if (!rawRefresh) throw unauthorized('No session', 'NO_SESSION');
  const session = await Session.findOne({ tokenHash: sha256(rawRefresh) });
  if (!session) throw unauthorized('Session expired', 'SESSION_EXPIRED');
  if (session.expiresAt <= new Date()) throw unauthorized('Session expired', 'SESSION_EXPIRED');
  if (session.revokedAt) {
    if (session.rotatedAt) {
      // A second tab racing a rotation is normal; a rotated token replayed later is theft.
      if (Date.now() - +session.rotatedAt < 10_000) throw unauthorized('Session was just refreshed', 'REFRESH_CONFLICT');
      await revokeFamily(session.familyId);
    }
    // Revoked by logout, password change or an admin: gone immediately, no grace.
    throw unauthorized('Session expired', 'SESSION_EXPIRED');
  }
  const now = new Date();
  const rotated = await Session.findOneAndUpdate({ _id: session._id, revokedAt: null }, { $set: { revokedAt: now, rotatedAt: now } });
  if (!rotated) throw unauthorized('Session was just refreshed', 'REFRESH_CONFLICT');
  const user = await User.findById(session.userId).lean();
  if (!user || user.status !== 'active') { await revokeFamily(session.familyId); throw unauthorized('Account unavailable'); }
  const tokens = await issueSession(user, { userAgent: ctx?.userAgent, familyId: session.familyId });
  return { user, ...tokens };
}

// ---------- one-time email tokens ----------
async function createAuthToken(user, type, ttl) {
  await AuthToken.updateMany({ userId: user._id, type, usedAt: null }, { $set: { usedAt: new Date() } });
  const raw = randomToken(32);
  await AuthToken.create({ userId: user._id, type, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + ttl) });
  return raw;
}
async function consumeAuthToken(raw, type) {
  const now = new Date();
  const doc = await AuthToken.findOneAndUpdate(
    { tokenHash: sha256(raw), type, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
  );
  if (!doc) throw new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
  return doc;
}

/** Returns 'sent' | 'not_configured' | 'failed'. Never claims success it didn't achieve. */
export async function sendVerificationEmail(user) {
  if (!emailConfigured()) return 'not_configured';
  try {
    const raw = await createAuthToken(user, 'verify_email', VERIFY_TTL);
    const link = `${env.clientUrl}/verify-email?token=${raw}`;
    await sendMail({
      to: user.email, subject: 'Verify your Dextquiz email',
      text: `Hi ${user.fullName},\n\nConfirm your email to start hosting games:\n${link}\n\nThis link expires in 24 hours.`,
      html: `<p>Hi ${escapeHtml(user.fullName)},</p><p><a href="${link}">Confirm your email</a> to start hosting games. This link expires in 24 hours.</p>`,
    });
    return 'sent';
  } catch (err) {
    log.error('verification email failed:', err.message);
    return 'failed';
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- account flows ----------
export async function register({ fullName, email, password }) {
  const passwordHash = await bcrypt.hash(password, env.bcryptRounds);
  let user;
  try {
    user = await User.create({ fullName, email, passwordHash });
  } catch (err) {
    if (err.code === 11000) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }
  const emailDelivery = await sendVerificationEmail(user);
  return { user, emailDelivery };
}

export async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user) {
    await bcrypt.compare(password, dummyHash); // equalise timing
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
  }
  const good = await bcrypt.compare(password, user.passwordHash);
  if (!good) {
    await User.updateOne({ _id: user._id }, { $inc: { failedLoginCount: 1 } }); // atomic increment
    const updated = await User.findById(user._id).select('failedLoginCount').lean();
    if (updated.failedLoginCount >= env.maxFailedLogins) {
      await User.updateOne({ _id: user._id }, { $set: { lockUntil: new Date(Date.now() + env.lockoutMs), failedLoginCount: 0 } });
    }
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'active') throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
  await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lockUntil: null } });
  return user;
}

export async function requestPasswordReset(email) {
  if (!emailConfigured()) throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Password recovery email is not configured on this server. Contact the administrator.');
  const user = await User.findOne({ email });
  if (!user || user.status !== 'active') return; // identical response either way
  try {
    const raw = await createAuthToken(user, 'reset_password', RESET_TTL);
    const link = `${env.clientUrl}/reset-password?token=${raw}`;
    await sendMail({
      to: user.email, subject: 'Reset your Dextquiz password',
      text: `Use this link to choose a new password (valid for 1 hour, single use):\n${link}\n\nIf you didn't ask for this, ignore this email.`,
      html: `<p><a href="${link}">Choose a new password</a> (valid for 1 hour, single use). If you didn't ask for this, ignore this email.</p>`,
    });
  } catch (err) {
    log.error('reset email failed:', err.message);
    throw new AppError(502, 'EMAIL_FAILED', 'We could not send the reset email. Please try again later.');
  }
}

async function setPassword(userId, newPassword) {
  const passwordHash = await bcrypt.hash(newPassword, env.bcryptRounds);
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await User.updateOne({ _id: userId }, { $set: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockUntil: null } });
  await revokeAllForUser(userId);
}

export async function resetPassword(rawToken, newPassword) {
  const t = await consumeAuthToken(rawToken, 'reset_password');
  await setPassword(t.userId, newPassword);
}

export async function verifyEmail(rawToken) {
  const t = await consumeAuthToken(rawToken, 'verify_email');
  await User.updateOne({ _id: t.userId }, { $set: { emailVerified: true } });
}

export async function changePassword(userId, current, next, ctx) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !(await bcrypt.compare(current, user.passwordHash))) {
    throw new AppError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect', { currentPassword: 'Current password is incorrect' });
  }
  await setPassword(userId, next);
  // Everything else was revoked; give this device a fresh session.
  return issueSession(user, { userAgent: ctx?.userAgent });
}
