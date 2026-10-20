export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const ok = (res, data, status = 200) => res.status(status).json({ data });
