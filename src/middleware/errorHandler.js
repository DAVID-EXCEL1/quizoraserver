import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { log } from '../utils/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

export function zodDetails(err) {
  const fields = {};
  for (const i of err.issues) {
    const k = i.path.join('.') || '_';
    fields[k] ||= i.message;
  }
  return fields;
}

export function toErrorBody(err) {
  if (err instanceof ZodError) return { status: 400, body: { code: 'VALIDATION_ERROR', message: 'Please check the highlighted fields', details: zodDetails(err) } };
  if (err instanceof AppError) return { status: err.status, body: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
  if (err?.name === 'CastError') return { status: 400, body: { code: 'BAD_REQUEST', message: 'Invalid identifier' } };
  if (err?.code === 11000) return { status: 409, body: { code: 'CONFLICT', message: 'Duplicate value' } };
  if (err?.type === 'entity.parse.failed') return { status: 400, body: { code: 'BAD_JSON', message: 'Malformed JSON body' } };
  if (err?.type === 'entity.too.large') return { status: 413, body: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } };
  return null;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const mapped = toErrorBody(err);
  if (mapped) return res.status(mapped.status).json({ error: mapped.body });
  log.error(`${req.method} ${req.path}`, err?.message);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
