import 'dotenv/config';

const e = process.env;
const nodeEnv = e.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const trimSlash = (s) => s.replace(/\/+$/, '');

function secret(name, devFallback) {
  const v = e[name];
  if (v && v.length >= 32) return v;
  if (isProd) throw new Error(`${name} must be set to a random string of at least 32 characters`);
  return devFallback;
}

const clientUrl = trimSlash(e.CLIENT_URL || 'http://localhost:5173');
const sameSite = (e.COOKIE_SAMESITE || 'lax').toLowerCase();

export const env = {
  nodeEnv,
  isProd,
  isTest: nodeEnv === 'test',
  port: num(e.PORT, 4000),
  mongoUri: e.MONGODB_URI || 'mongodb://127.0.0.1:27017/quizora',
  clientUrl,
  serverUrl: trimSlash(e.SERVER_URL || `http://localhost:${num(e.PORT, 4000)}`),
  allowedOrigins: (e.CORS_ORIGINS || clientUrl).split(',').map((s) => trimSlash(s.trim())).filter(Boolean),
  trustProxy: num(e.TRUST_PROXY, 0),

  jwtAccessSecret: secret('JWT_ACCESS_SECRET', 'dev-only-access-secret-change-me-0123456789abcdef'),
  jwtIssuer: 'quizora',
  jwtAudience: 'quizora-host',
  accessTtlSec: 15 * 60,
  refreshTtlMs: num(e.REFRESH_TTL_DAYS, 14) * 24 * 3600 * 1000,
  bcryptRounds: num(e.BCRYPT_ROUNDS, 12),
  maxFailedLogins: 5,
  lockoutMs: 15 * 60 * 1000,
  cookie: {
    domain: e.COOKIE_DOMAIN || undefined,
    sameSite,
    secure: isProd || sameSite === 'none',
  },

  rateLimitDisabled: bool(e.RATE_LIMIT_DISABLED, false),

  roomInactivityMs: num(e.ROOM_INACTIVITY_MINUTES, 120) * 60 * 1000,
  finishedRoomRetentionMs: num(e.ROOM_RETENTION_DAYS, 7) * 24 * 3600 * 1000,
  finishedPlayerTokenMs: 30 * 60 * 1000,
  maxPlayersPerRoom: num(e.MAX_PLAYERS_PER_ROOM, 200),
  scoringDelayMs: num(e.SCORING_DELAY_MS, 250),
  deadlineGraceMs: num(e.DEADLINE_GRACE_MS, 300),
  autoCloseWhenAllAnswered: bool(e.AUTO_CLOSE_WHEN_ALL_ANSWERED, true),

  enableWorker: bool(e.ENABLE_WORKER, true),
  sweepIntervalMs: num(e.SWEEP_INTERVAL_MS, 1000),
  cleanupIntervalMs: num(e.CLEANUP_INTERVAL_MS, 60 * 1000),

  smtp: {
    host: e.SMTP_HOST || '',
    port: num(e.SMTP_PORT, 587),
    user: e.SMTP_USER || '',
    pass: e.SMTP_PASS || '',
    from: e.EMAIL_FROM || 'Dextquiz <no-reply@localhost>',
  },
  devLogEmailLinks: bool(e.DEV_LOG_EMAIL_LINKS, false) && !isProd,

  cloudinary: {
    cloudName: e.CLOUDINARY_CLOUD_NAME || '',
    apiKey: e.CLOUDINARY_API_KEY || '',
    apiSecret: e.CLOUDINARY_API_SECRET || '',
  },
  redisUrl: e.REDIS_URL || '',
  maxPlayersCeiling: num(e.MAX_PLAYERS_CEILING, 1000),
  paystack: { secretKey: e.PAYSTACK_SECRET_KEY || '', publicKey: e.PAYSTACK_PUBLIC_KEY || '', baseUrl: (e.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/+$/, '') },
  groq: { apiKey: e.GROQ_API_KEY || '', model: e.GROQ_MODEL || 'openai/gpt-oss-120b', baseUrl: (e.GROQ_BASE_URL || 'https://api.groq.com').replace(/\/+$/, '') },
  pexelsKey: e.PEXELS_API_KEY || '',
  pexelsBaseUrl: (e.PEXELS_BASE_URL || 'https://api.pexels.com').replace(/\/+$/, ''),
};
