import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const make = (windowMs, limit, message) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.rateLimitDisabled,
  handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } }),
});

export const apiLimiter = make(60_000, 600, 'Too many requests, slow down');
export const authLimiter = make(15 * 60_000, 30, 'Too many attempts. Try again in a few minutes.');
export const forgotLimiter = make(60 * 60_000, 8, 'Too many reset requests. Try again later.');
export const pinLookupLimiter = make(60_000, 30, 'Too many PIN lookups. Slow down.');
export const joinLimiter = make(60_000, 20, 'Too many join attempts. Slow down.');

/** Tiny in-memory limiter for socket events (per socket). */
export function socketAllow(socket, key, max, windowMs) {
  if (env.rateLimitDisabled) return true;
  const now = Date.now();
  socket.data.rl ||= {};
  const b = (socket.data.rl[key] ||= []);
  while (b.length && now - b[0] > windowMs) b.shift();
  if (b.length >= max) return false;
  b.push(now);
  return true;
}
