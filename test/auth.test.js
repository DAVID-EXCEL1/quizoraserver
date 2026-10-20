import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, newHost, request, uniqueEmail, PASSWORD } from './helpers.js';

let app;
const mails = [];
beforeAll(async () => { app = await boot(); });
afterAll(async () => { await app.close(); });

const register = (body) => request(app.server).post('/api/auth/register').send(body);
const good = () => { const email = uniqueEmail(); return { fullName: 'Test Host', email, password: PASSWORD, confirmPassword: PASSWORD }; };

describe('1. host registration', () => {
  it('creates an account, hashes the password, sets HttpOnly cookies', async () => {
    const body = good();
    const res = await register(body);
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(body.email);
    expect(res.body.data.emailDelivery).toBe('not_configured'); // honest: no SMTP in tests
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/qz_at=.*HttpOnly/);
    expect(cookies).toMatch(/qz_rt=.*HttpOnly/);
    const { User } = await import('../src/models/index.js');
    const u = await User.findOne({ email: body.email }).select('+passwordHash').lean();
    expect(u.passwordHash).not.toContain(PASSWORD);
    expect(u.passwordHash).toMatch(/^\$2[aby]\$/);
  });
  it('enforces the password policy and confirmation', async () => {
    expect((await register({ ...good(), password: 'short1A', confirmPassword: 'short1A' })).status).toBe(400);
    expect((await register({ ...good(), password: 'alllowercase123', confirmPassword: 'alllowercase123' })).status).toBe(400);
    const r = await register({ ...good(), confirmPassword: 'Different1Password' });
    expect(r.status).toBe(400);
    expect(r.body.error.details.confirmPassword).toBeTruthy();
  });
  it('normalizes email case', async () => {
    const b = good(); b.email = b.email.toUpperCase();
    const res = await register(b);
    expect(res.body.data.user.email).toBe(b.email.toLowerCase());
  });
});

describe('2. duplicate email', () => {
  it('rejects a second account with the same email (any casing)', async () => {
    const b = good();
    expect((await register(b)).status).toBe(201);
    expect((await register(b)).status).toBe(409);
    expect((await register({ ...b, email: b.email.toUpperCase() })).status).toBe(409);
  });
});

describe('3/4. login', () => {
  it('accepts correct credentials', async () => {
    const b = good(); await register(b);
    const res = await request(app.server).post('/api/auth/login').send({ email: b.email, password: PASSWORD });
    expect(res.status).toBe(200);
  });
  it('rejects wrong password and unknown email with the same generic error', async () => {
    const b = good(); await register(b);
    const wrong = await request(app.server).post('/api/auth/login').send({ email: b.email, password: 'Wrong-Password1' });
    const unknown = await request(app.server).post('/api/auth/login').send({ email: uniqueEmail('nobody'), password: 'Wrong-Password1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });
  it('locks the account after repeated failures (brute-force protection)', async () => {
    const b = good(); await register(b);
    for (let i = 0; i < 5; i++) await request(app.server).post('/api/auth/login').send({ email: b.email, password: 'Wrong-Password1' });
    const res = await request(app.server).post('/api/auth/login').send({ email: b.email, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });
  it('rejects NoSQL operator injection in the login body', async () => {
    const res = await request(app.server).post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    expect(res.status).toBe(400);
  });
});

describe('6. protected routes, CSRF and sessions', () => {
  it('rejects unauthenticated access', async () => {
    for (const p of ['/api/dashboard', '/api/quizzes', '/api/games', '/api/auth/me']) {
      expect((await request(app.server).get(p)).status).toBe(401);
    }
    expect((await request(app.server).post('/api/rooms').send({ quizId: 'a'.repeat(24) })).status).toBe(401);
  });
  it('requires a CSRF token on state-changing authenticated requests', async () => {
    const h = await newHost(app);
    const noToken = await h.agent.post('/api/quizzes').send({ title: 'x', questions: [] });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_FAILED');
    expect((await h.post('/api/quizzes', { title: 'x', questions: [] })).status).toBe(201);
    const wrong = await h.agent.post('/api/quizzes').set('X-CSRF-Token', 'nope').send({ title: 'x' });
    expect(wrong.status).toBe(403);
  });
  it('rejects requests from untrusted origins', async () => {
    const h = await newHost(app);
    const res = await h.post('/api/quizzes', { title: 'x', questions: [] }).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
  it('rotates refresh tokens, detects replay of an old token, and logs out', async () => {
    const h = await newHost(app);
    const oldRt = h.cookie.split('; ').find((c) => c.startsWith('qz_rt='));
    const r1 = await h.post('/api/auth/refresh');
    expect(r1.status).toBe(200);
    h.csrf = r1.body.data.csrfToken;
    expect((await h.get('/api/auth/me')).status).toBe(200);

    // Replay the old (already rotated) refresh token after the grace window.
    const { Session } = await import('../src/models/index.js');
    const { sha256 } = await import('../src/utils/tokens.js');
    await Session.updateOne({ tokenHash: sha256(oldRt.split('=')[1]) }, { $set: { revokedAt: new Date(Date.now() - 60_000), rotatedAt: new Date(Date.now() - 60_000) } });
    const replay = await request(app.server).post('/api/auth/refresh').set('Cookie', `${oldRt}; qz_csrf=abc`).set('X-CSRF-Token', 'abc');
    expect(replay.status).toBe(401);
    // whole family is now dead, including the newest token
    expect((await h.get('/api/auth/me')).status).toBe(401);
  });
  it('a token revoked by logout/admin is rejected at once as expired (no refresh grace window)', async () => {
    const h = await newHost(app);
    const rt = h.cookie.split('; ').find((c) => c.startsWith('qz_rt='));
    const { User } = await import('../src/models/index.js');
    const { revokeAllForUser } = await import('../src/services/authService.js');
    await revokeAllForUser((await User.findOne({ email: h.email }))._id);
    const r = await request(app.server).post('/api/auth/refresh').set('Cookie', `${rt}; qz_csrf=abc`).set('X-CSRF-Token', 'abc');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('SESSION_EXPIRED'); // not REFRESH_CONFLICT
    expect(r.headers['set-cookie'].join(';')).toMatch(/qz_at=;/); // cookies cleared
  });
  it('two tabs refreshing at once is a harmless conflict, not a sign-out', async () => {
    const h = await newHost(app);
    const rt = h.cookie.split('; ').find((c) => c.startsWith('qz_rt='));
    const call = () => request(app.server).post('/api/auth/refresh').set('Cookie', `${rt}; qz_csrf=abc`).set('X-CSRF-Token', 'abc');
    const first = await call();
    const second = await call();
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('REFRESH_CONFLICT');
    expect(second.headers['set-cookie']).toBeUndefined(); // cookies untouched
  });
  it('logout invalidates the session server-side', async () => {
    const h = await newHost(app);
    const at = h.cookie.split('; ').find((c) => c.startsWith('qz_at='));
    expect((await h.post('/api/auth/logout')).status).toBe(200);
    const stolen = await request(app.server).get('/api/auth/me').set('Cookie', at);
    expect(stolen.status).toBe(401); // revoked family, even though the JWT hasn't expired
  });
});

describe('5. password recovery', () => {
  it('reports honestly when email delivery is not configured', async () => {
    const res = await request(app.server).post('/api/auth/forgot-password').send({ email: uniqueEmail() });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('EMAIL_NOT_CONFIGURED');
  });

  it('issues single-use hashed tokens that expire, and revokes sessions on reset', async () => {
    const { setMailTransport } = await import('../src/services/mailer.js');
    setMailTransport({ sendMail: async (m) => { mails.push(m); } });
    const h = await newHost(app);
    mails.length = 0;

    // identical response for unknown accounts, and no mail sent for them
    const unknown = await request(app.server).post('/api/auth/forgot-password').send({ email: uniqueEmail('ghost') });
    expect(unknown.status).toBe(200);
    expect(mails.filter((m) => m.subject.includes('Reset'))).toHaveLength(0);

    const res = await request(app.server).post('/api/auth/forgot-password').send({ email: h.email });
    expect(res.status).toBe(200);
    const mail = mails.find((m) => m.subject.includes('Reset'));
    const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');

    const { AuthToken } = await import('../src/models/index.js');
    const { sha256 } = await import('../src/utils/tokens.js');
    expect(await AuthToken.countDocuments({ tokenHash: token })).toBe(0); // raw token never stored
    expect(await AuthToken.countDocuments({ tokenHash: sha256(token) })).toBe(1);

    const newPw = 'An0ther-Strong-Pass';
    const ok = await request(app.server).post('/api/auth/reset-password').send({ token, password: newPw, confirmPassword: newPw });
    expect(ok.status).toBe(200);
    const reuse = await request(app.server).post('/api/auth/reset-password').send({ token, password: newPw + 'x', confirmPassword: newPw + 'x' });
    expect(reuse.status).toBe(400); // single use

    expect((await h.get('/api/auth/me')).status).toBe(401); // old sessions revoked
    expect((await request(app.server).post('/api/auth/login').send({ email: h.email, password: PASSWORD })).status).toBe(401);
    expect((await request(app.server).post('/api/auth/login').send({ email: h.email, password: newPw })).status).toBe(200);
  });

  it('rejects expired reset tokens', async () => {
    const h = await newHost(app);
    mails.length = 0;
    await request(app.server).post('/api/auth/forgot-password').send({ email: h.email });
    const token = new URL(mails.at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    const { AuthToken } = await import('../src/models/index.js');
    await AuthToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app.server).post('/api/auth/reset-password').send({ token, password: 'An0ther-Strong-Pass', confirmPassword: 'An0ther-Strong-Pass' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('verifies email via a single-use token', async () => {
    const email = uniqueEmail();
    mails.length = 0;
    const r = await register({ fullName: 'Verify Me', email, password: PASSWORD, confirmPassword: PASSWORD });
    expect(r.body.data.emailDelivery).toBe('sent');
    const token = new URL(mails.at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    expect((await request(app.server).post('/api/auth/verify-email').send({ token })).status).toBe(200);
    expect((await request(app.server).post('/api/auth/verify-email').send({ token })).status).toBe(400);
  });

  it('change-password signs out other devices but keeps this one', async () => {
    const h = await newHost(app);
    const other = request.agent(app.server);
    await other.post('/api/auth/login').send({ email: h.email, password: PASSWORD });
    const r = await h.patch('/api/auth/password', { currentPassword: PASSWORD, password: 'Fresh-Password-99', confirmPassword: 'Fresh-Password-99' });
    expect(r.status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
    expect((await h.get('/api/auth/me')).status).toBe(200);
  });
});
