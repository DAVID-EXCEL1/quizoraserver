import { forbidden } from '../utils/errors.js';

/** Must run after requireAuth: req.user is re-read from the database on every request, so a demoted admin loses access immediately. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return next(forbidden('Administrator access required'));
  next();
}
