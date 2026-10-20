// Deliberately tiny: never logs bodies, headers, cookies or tokens.
import { env } from '../config/env.js';
const quiet = env.isTest;
export const log = {
  info: (...a) => !quiet && console.log('[info]', ...a),
  warn: (...a) => !quiet && console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};
