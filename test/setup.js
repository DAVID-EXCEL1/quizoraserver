// Runs before every test file, before any app module is imported.
// MONGODB_URI_TEST should be a server URL WITHOUT a database name, e.g. mongodb://127.0.0.1:27017
const base = (process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017').replace(/\/+$/, '');
const dbName = `quizora_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
process.env.MONGODB_URI = `${base}/${dbName}`;
process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4';
process.env.RATE_LIMIT_DISABLED ??= 'true';
process.env.SCORING_DELAY_MS = '25';
process.env.DEADLINE_GRACE_MS = '100';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit_secret';
process.env.GROQ_API_KEY = 'gsk_unit_test';
process.env.PEXELS_API_KEY = 'px_unit_test';
