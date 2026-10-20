export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'Not allowed') => new AppError(403, 'FORBIDDEN', msg);
export const unauthorized = (msg = 'Authentication required', code = 'UNAUTHENTICATED') => new AppError(401, code, msg);
