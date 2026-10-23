import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { boot, newHost, publishedQuiz, launch, sampleQuestions, request, mockFetch } from './helpers.js';

let app; let admin; let models; let settings; let billing; let env; let pro; let free;
const A = (p) => `/api/admin${p}`;
const SECRET = 'sk_test_unit_secret';
let mock; let verifyResults; let nextPlanCode = 0;
const sign = (raw) => crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
const hook = (event, data, { signature } = {}) => { const raw = JSON.stringify({ event, data }); return request(app.server).post('/api/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', signature ?? sign(raw)).send(raw); };

beforeAll(async () => {
  app = await boot();
  models = await import('../src/models/index.js');
  settings = await import('../src/services/settings.js');
  billing = await import('../src/services/billingService.js');
  env = (await import('../src/config/env.js')).env;
  await billing.seedPlans();
  admin = await newHost(app, { fullName: 'Billing Admin' });
  await models.User.updateOne({ email: admin.email }, { $set: { role: 'admin' } });
  pro = await models.Plan.findOne({ slug: 'pro' }).lean(); free = await models.Plan.findOne({ slug: 'free' }).lean();
  verifyResults = {};
  mock = mockFetch([
    [/api\.paystack\.co\/plan\/[A-Z_a-z0-9]+$/, () => ({ body: { status: true, data: {} } })],
    [/api\.paystack\.co\/plan$/, () => ({ body: { status: true, data: { plan_code: `PLN_${++nextPlanCode}` } } })],
    [/api\.paystack\.co\/transaction\/initialize/, ({ body }) => ({ body: { status: true, data: { authorization_url: `https://checkout.paystack.com/${body.reference}`, reference: body.reference } } })],
    [/api\.paystack\.co\/transaction\/verify\/(.+)$/, ({ url }) => { const ref = decodeURIComponent(url.split('/verify/')[1]); return { body: { status: true, data: verifyResults[ref] || { status: 'abandoned' } } }; }],
    [/api\.paystack\.co\/subscription\/disable/, () => ({ body: { status: true, data: {} } })],
  ]);
});
afterAll(async () => { mock.restore(); await app.close(); });
afterEach(() => { env.paystack.secretKey = SECRET; settings.resetSettingsCache(); });

const checkout = async (h, planId) => { const r = await h.post('/api/billing/checkout', { planId }); return r; };
const succeed = (ref, user, over = {}) => { verifyResults[ref] = { status: 'success', amount: 500000, currency: 'NGN', id: 111, reference: ref, customer: { customer_code: `CUS_${user.id.slice(-6)}`, email: user.email }, ...over }; };

describe('default plans and server-side limits', () => {
  it('seeds Free/Pro/Business and exposes them to hosts', async () => {
    const h = await newHost(app);
    const o = (await h.get('/api/billing')).body.data;
    expect(o.plans.map((p) => p.slug)).toEqual(['free', 'pro', 'business']);
    expect(o.entitlements).toMatchObject({ source: 'free', plan: { slug: 'free' }, limits: { maxPlayersPerGame: 10, maxQuizzes: 5 } });
    expect(o.currency).toBe('NGN'); expect(o.paymentsConfigured).toBe(true);
    expect(JSON.stringify(o)).not.toMatch(/sk_test|paystackPlanCode|emailToken/);
  });
  it('enforces quiz count and question limits with a clear upgrade message', async () => {
    const h = await newHost(app);
    for (let i = 0; i < 5; i++) expect((await h.post('/api/quizzes', { title: `Q${i}`, questions: sampleQuestions(1) })).status).toBe(201);
    const sixth = await h.post('/api/quizzes', { title: 'Q6', questions: [] });
    expect(sixth.status).toBe(402);
    expect(sixth.body.error).toMatchObject({ code: 'PLAN_LIMIT', details: { limit: 'maxQuizzes', max: 5 } });
    const first = (await h.get('/api/quizzes')).body.data.items[0];
    expect((await h.post(`/api/quizzes/${first.id}/duplicate`)).status).toBe(402);
    await h.delete(`/api/quizzes/${first.id}`);
    expect((await h.post('/api/quizzes', { title: 'fits now', questions: [] })).status).toBe(201);
    const h2 = await newHost(app);
    const tooMany = await h2.post('/api/quizzes', { title: 'Long', questions: sampleQuestions(11) });
    expect(tooMany.status).toBe(402); expect(tooMany.body.error.details.limit).toBe('maxQuestionsPerQuiz');
    const ok = await h2.post('/api/quizzes', { title: 'Ten', questions: sampleQuestions(10) });
    expect(ok.status).toBe(201);
    expect((await h2.put(`/api/quizzes/${ok.body.data.id}`, { title: 'Ten', questions: sampleQuestions(11) })).status).toBe(402);
  });
  it('caps players per game from the plan at launch; changing the plan later does not disturb a running room', async () => {
    const h = await newHost(app);
    await admin.patch(A(`/plans/${free._id}`), { limits: { maxPlayersPerGame: 2 } });
    const q = await publishedQuiz(h, { n: 1 });
    const g = await launch(h, q.id);
    expect((await models.Room.findOne({ code: g.room.code })).maxPlayers).toBe(2);
    const join = (n) => request(app.server).post(`/api/rooms/${g.room.code}/join`).send({ nickname: n });
    expect((await join('One')).status).toBe(201); expect((await join('Two')).status).toBe(201);
    const full = await join('Three');
    expect(full.status).toBe(409); expect(full.body.error).toMatchObject({ code: 'ROOM_FULL', message: expect.stringContaining('2 players') });
    await admin.patch(A(`/plans/${free._id}`), { limits: { maxPlayersPerGame: 5 } });
    expect((await join('Three')).status).toBe(409); // this game keeps the cap it launched with
    const g2 = await launch(h, q.id);
    expect((await models.Room.findOne({ code: g2.room.code })).maxPlayers).toBe(5); // new games pick up the new cap
    await admin.patch(A(`/plans/${free._id}`), { limits: { maxPlayersPerGame: 10 } });
  });
});

describe('checkout and verification', () => {
  it('starts a Paystack checkout, then activates the plan only after a verified successful payment', async () => {
    const h = await newHost(app);
    const c = await checkout(h, String(pro._id));
    expect(c.status).toBe(200);
    expect(c.body.data.authorizationUrl).toContain(c.body.data.reference);
    const init = mock.calls.filter((x) => x.url.includes('/transaction/initialize')).at(-1).body;
    expect(init).toMatchObject({ email: h.email, amount: 500000, currency: 'NGN', callback_url: 'http://localhost:5173/billing/callback' });
    expect(init.plan).toMatch(/^PLN_/);
    const pay = await models.Payment.findOne({ reference: c.body.data.reference }).lean();
    expect(pay).toMatchObject({ status: 'pending', amountMinor: 500000, planName: 'Pro' });
    expect((await h.get('/api/billing')).body.data.entitlements.plan.slug).toBe('free'); // not yet

    const abandoned = await h.post('/api/billing/verify', { reference: c.body.data.reference });
    expect(abandoned.body.data.status).toBe('pending'); // user closed the tab: nothing activates
    succeed(c.body.data.reference, h.user);
    const v = await h.post('/api/billing/verify', { reference: c.body.data.reference });
    expect(v.body.data.status).toBe('success');
    expect(v.body.data.entitlements).toMatchObject({ source: 'subscription', plan: { slug: 'pro' }, limits: { maxPlayersPerGame: 100 } });
    await h.post('/api/billing/verify', { reference: c.body.data.reference }); // idempotent
    expect(await models.Subscription.countDocuments({ userId: h.user.id })).toBe(1);
    expect(await models.Payment.countDocuments({ userId: h.user.id, status: 'success' })).toBe(1);
    const sub = await models.Subscription.findOne({ userId: h.user.id }).lean();
    expect(+sub.currentPeriodEnd).toBeGreaterThan(Date.now() + 27 * 86400000);
    // the plan unlocks a bigger game right away
    const q = await publishedQuiz(h, { n: 1 });
    expect((await models.Room.findOne({ code: (await launch(h, q.id)).room.code })).maxPlayers).toBe(100);
  });
  it('recreates a stale cached Paystack plan code and retries checkout', async () => {
    const h = await newHost(app);
    const plan = await models.Plan.findById(pro._id);
    const originalCode = plan.paystackPlanCode;
    const originalMode = plan.paystackMode;
    await models.Plan.updateOne({ _id: plan._id }, { $set: { paystackPlanCode: 'PLN_STALE', paystackMode: 'test' } });
    let attempts = 0;
    const stalePlan = mockFetch([[/api\.paystack\.co\/transaction\/initialize/, ({ body }) => {
      attempts++;
      return attempts === 1
        ? { status: 400, body: { status: false, message: 'Plan ID/code specified is invalid' } }
        : { body: { status: true, data: { authorization_url: `https://checkout.paystack.com/${body.reference}`, reference: body.reference } } };
    }]]);
    let reference;
    try {
      const c = await checkout(h, String(pro._id));
      expect(c.status).toBe(200);
      reference = c.body.data.reference;
      expect(attempts).toBe(2);
      const refreshed = await models.Plan.findById(plan._id).lean();
      expect(refreshed.paystackPlanCode).not.toBe('PLN_STALE');
      expect(refreshed.paystackMode).toBe('test');
    } finally {
      stalePlan.restore();
      if (reference) await models.Payment.deleteOne({ reference });
      const update = {};
      if (originalCode === undefined) update.$unset = { ...(update.$unset || {}), paystackPlanCode: 1 };
      else update.$set = { ...(update.$set || {}), paystackPlanCode: originalCode };
      if (originalMode === undefined) update.$unset = { ...(update.$unset || {}), paystackMode: 1 };
      else update.$set = { ...(update.$set || {}), paystackMode: originalMode };
      await models.Plan.updateOne({ _id: plan._id }, update);
    }
  });
  it('recreates cached Paystack plans when switching from test to live credentials', async () => {
    const h = await newHost(app);
    const plan = await models.Plan.findOne({ slug: 'business' });
    const originalCode = plan.paystackPlanCode;
    const originalMode = plan.paystackMode;
    let reference;
    try {
      await models.Plan.updateOne({ _id: plan._id }, { $set: { paystackPlanCode: 'PLN_TEST_CACHED', paystackMode: 'test' } });
      env.paystack.secretKey = 'sk_live_unit_secret';

      const c = await checkout(h, String(plan._id));
      expect(c.status).toBe(200);
      reference = c.body.data.reference;
      const refreshed = await models.Plan.findById(plan._id).lean();
      expect(refreshed.paystackMode).toBe('live');
      expect(refreshed.paystackPlanCode).not.toBe('PLN_TEST_CACHED');
      expect(mock.calls.filter((x) => x.url.includes('/transaction/initialize')).at(-1).body.plan).toBe(refreshed.paystackPlanCode);
    } finally {
      if (reference) await models.Payment.deleteOne({ reference });
      const update = {};
      if (originalCode === undefined) update.$unset = { ...(update.$unset || {}), paystackPlanCode: 1 };
      else update.$set = { ...(update.$set || {}), paystackPlanCode: originalCode };
      if (originalMode === undefined) update.$unset = { ...(update.$unset || {}), paystackMode: 1 };
      else update.$set = { ...(update.$set || {}), paystackMode: originalMode };
      await models.Plan.updateOne({ _id: plan._id }, update);
    }
  });
  it("refuses payments that don't match (amount/currency) and another user's reference", async () => {
    const h = await newHost(app); const other = await newHost(app);
    const c = (await checkout(h, String(pro._id))).body.data;
    succeed(c.reference, h.user, { amount: 100 }); // underpaid
    const v = await h.post('/api/billing/verify', { reference: c.reference });
    expect(v.body.data.status).toBe('failed'); expect(v.body.data.entitlements.plan.slug).toBe('free');
    const c2 = (await checkout(h, String(pro._id))).body.data;
    succeed(c2.reference, h.user, { currency: 'USD' });
    expect((await h.post('/api/billing/verify', { reference: c2.reference })).body.data.status).toBe('failed');
    const c3 = (await checkout(h, String(pro._id))).body.data; succeed(c3.reference, h.user);
    expect((await other.post('/api/billing/verify', { reference: c3.reference })).status).toBe(404); // not theirs
    expect((await other.get('/api/billing')).body.data.entitlements.plan.slug).toBe('free');
  });
  it('rejects free/inactive/unknown plans, anonymous users, and reports an unconfigured gateway honestly', async () => {
    const h = await newHost(app);
    expect((await checkout(h, String(free._id))).body.error.code).toBe('FREE_PLAN');
    expect((await checkout(h, 'a'.repeat(24))).status).toBe(404);
    expect((await h.post('/api/billing/checkout', { planId: String(pro._id), price: 1 })).status).toBe(400); // client can't send a price
    expect((await request(app.server).post('/api/billing/checkout').send({ planId: String(pro._id) })).status).toBe(401);
    env.paystack.secretKey = '';
    expect((await checkout(h, String(pro._id))).body.error.code).toBe('PAYSTACK_NOT_CONFIGURED');
    expect((await h.get('/api/billing')).body.data.paymentsConfigured).toBe(false);
  });
});

describe('Paystack webhooks', () => {
  it('rejects missing, wrong and tampered signatures', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'x' } });
    expect((await request(app.server).post('/api/webhooks/paystack').set('Content-Type', 'application/json').send(raw)).status).toBe(401);
    expect((await hook('charge.success', { reference: 'x' }, { signature: 'f'.repeat(128) })).status).toBe(401);
    const tampered = await request(app.server).post('/api/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sign(raw)).send(raw.replace('"x"', '"y"'));
    expect(tampered.status).toBe(401);
    expect((await hook('charge.success', { reference: 'x' })).status).toBe(200); // valid signature, unknown reference: acknowledged, nothing happens
  });
  it('activates from a signed charge.success (idempotent), always for the payer — never from metadata', async () => {
    const h = await newHost(app); const victim = await newHost(app);
    const ref = (await checkout(h, String(pro._id))).body.data.reference;
    const body = { reference: ref, status: 'success', amount: 500000, currency: 'NGN', id: 9, customer: { customer_code: 'CUS_A', email: h.email }, metadata: { userId: victim.user.id, planId: String(pro._id) } };
    expect((await hook('charge.success', body)).status).toBe(200);
    expect((await hook('charge.success', body)).status).toBe(200); // Paystack retries deliveries
    expect((await h.get('/api/billing')).body.data.entitlements.plan.slug).toBe('pro');
    expect((await victim.get('/api/billing')).body.data.entitlements.plan.slug).toBe('free'); // spoofed metadata ignored
    expect(await models.Payment.countDocuments({ reference: ref, status: 'success' })).toBe(1);
  });
  it('handles subscription lifecycle: create, renewal (once), payment failure, cancel at period end, expiry', async () => {
    const h = await newHost(app);
    const ref = (await checkout(h, String(pro._id))).body.data.reference;
    const customer = { customer_code: 'CUS_LIFE', email: h.email };
    await hook('charge.success', { reference: ref, status: 'success', amount: 500000, currency: 'NGN', id: 1, customer });
    const next = new Date(Date.now() + 29 * 86400000).toISOString();
    await hook('subscription.create', { subscription_code: 'SUB_1', email_token: 'tok_secret', next_payment_date: next, customer, plan: { plan_code: pro.paystackPlanCode } });
    let sub = await models.Subscription.findOne({ userId: h.user.id }).select('+emailToken').lean();
    expect(sub).toMatchObject({ paystackSubscriptionCode: 'SUB_1', emailToken: 'tok_secret', status: 'active' });
    expect(Math.abs(+sub.currentPeriodEnd - +new Date(next))).toBeLessThan(1000);

    const renewal = { reference: 'renew_1', status: 'success', amount: 500000, currency: 'NGN', id: 2, customer, plan: { plan_code: pro.paystackPlanCode } };
    await hook('charge.success', renewal); await hook('charge.success', renewal);
    sub = await models.Subscription.findOne({ userId: h.user.id }).lean();
    expect(+sub.currentPeriodEnd).toBeGreaterThan(+new Date(next) + 27 * 86400000); // extended exactly once
    expect(await models.Payment.countDocuments({ reference: 'renew_1' })).toBe(1);

    await hook('invoice.payment_failed', { customer });
    expect((await models.Subscription.findOne({ userId: h.user.id })).status).toBe('past_due');
    expect((await h.get('/api/billing')).body.data.entitlements.plan.slug).toBe('pro'); // still paid up until the period ends

    const cancel = await h.post('/api/billing/cancel');
    expect(cancel.body.data.status).toBe('non_renewing');
    expect(mock.calls.filter((x) => x.url.endsWith('/subscription/disable')).at(-1).body).toEqual({ code: 'SUB_1', token: 'tok_secret' });
    expect((await h.get('/api/billing')).body.data.entitlements).toMatchObject({ plan: { slug: 'pro' }, subscriptionStatus: 'non_renewing' });
    await hook('subscription.not_renew', { customer });

    await models.Subscription.updateOne({ userId: h.user.id }, { $set: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    expect((await h.get('/api/billing')).body.data.entitlements).toMatchObject({ source: 'free', plan: { slug: 'free' } }); // lapsed
    expect((await newHost(app).then((x) => x.post('/api/billing/cancel'))).status).toBe(404);
  });
});

describe('admin billing controls', () => {
  it('counts default Free users even though they have no subscription record', async () => {
    const counts = async () => (await admin.get(A('/plans'))).body.data;
    const before = await counts();
    const freeBefore = before.find((p) => p.slug === 'free').subscribers;
    const proBefore = before.find((p) => p.slug === 'pro').subscribers;
    const u = await newHost(app);

    let after = await counts();
    expect(after.find((p) => p.slug === 'free').subscribers).toBe(freeBefore + 1);

    await admin.post(A(`/users/${u.user.id}/plan`), { planId: String(pro._id) });
    after = await counts();
    expect(after.find((p) => p.slug === 'free').subscribers).toBe(freeBefore);
    expect(after.find((p) => p.slug === 'pro').subscribers).toBe(proBefore + 1);

    await admin.post(A(`/users/${u.user.id}/plan`), { planId: String(free._id) });
    after = await counts();
    expect(after.find((p) => p.slug === 'free').subscribers).toBe(freeBefore + 1);
    expect(after.find((p) => p.slug === 'pro').subscribers).toBe(proBefore);
  });
  it('creates, edits, defaults and deletes plans, syncing price changes to Paystack', async () => {
    const created = await admin.post(A('/plans'), { name: 'Team', slug: 'team', priceMinor: 900000, limits: { maxPlayersPerGame: 250 }, features: { ai: false } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Team', currency: 'NGN', limits: { maxPlayersPerGame: 250, maxQuizzes: 5 }, features: { ai: false, chat: true } });
    expect((await admin.post(A('/plans'), { name: 'Dup', slug: 'team' })).body.error.code).toBe('SLUG_TAKEN');
    expect((await admin.post(A('/plans'), { name: 'Bad', slug: 'Bad Slug!' })).status).toBe(400);
    expect((await admin.post(A('/plans'), { name: 'Weird', slug: 'weird', limits: { maxQuizzes: -5 } })).status).toBe(400);
    expect((await admin.post(A('/plans'), { name: 'Paid default', slug: 'pd', priceMinor: 100, isDefault: true })).body.error.code).toBe('DEFAULT_MUST_BE_FREE');

    // price change on a plan that already exists at Paystack is pushed there (existing subscribers keep their price)
    const before = mock.calls.filter((c) => c.method === 'PUT').length;
    const upd = await admin.patch(A(`/plans/${pro._id}`), { priceMinor: 600000, name: 'Pro+' });
    expect(upd.body.data.paystackSync).toBe('synced');
    const put = mock.calls.filter((c) => c.method === 'PUT').at(-1);
    expect(mock.calls.filter((c) => c.method === 'PUT').length).toBe(before + 1);
    expect(put.body).toMatchObject({ amount: 600000, name: 'Pro+', update_existing_subscriptions: false });
    await admin.patch(A(`/plans/${pro._id}`), { priceMinor: 500000, name: 'Pro' });

    expect((await admin.patch(A(`/plans/${free._id}`), { active: false })).body.error.code).toBe('DEFAULT_PLAN');
    expect((await admin.patch(A(`/plans/${free._id}`), { priceMinor: 100 })).body.error.code).toBe('DEFAULT_MUST_BE_FREE');
    expect((await admin.delete(A(`/plans/${free._id}`))).body.error.code).toBe('DEFAULT_PLAN');
    expect((await admin.delete(A(`/plans/${pro._id}`))).body.error.code).toBe('HAS_SUBSCRIBERS');
    expect((await admin.delete(A(`/plans/${created.body.data.id}`))).status).toBe(200);
    const nobody = await newHost(app);
    expect((await nobody.get(A('/plans'))).status).toBe(403);
    expect((await nobody.patch(A(`/plans/${pro._id}`), { priceMinor: 1 })).status).toBe(403);
  });
  it('shows Paystack sync failure without losing the local edit', async () => {
    const m2 = mockFetch([[/api\.paystack\.co\/plan\/.+/, () => ({ status: 400, body: { status: false, message: 'Plan locked' } })]]);
    try {
      const r = await admin.patch(A(`/plans/${pro._id}`), { priceMinor: 550000 });
      expect(r.status).toBe(200); expect(r.body.data.paystackSync).toMatch(/failed: Plan locked/);
      expect((await models.Plan.findById(pro._id)).priceMinor).toBe(550000);
      expect((await models.Plan.findById(pro._id)).paystackPlanCode).toBeUndefined();
    } finally { m2.restore(); }
    // restore the shared mock stack that m2 wrapped
    await admin.patch(A(`/plans/${pro._id}`), { priceMinor: 500000 });
    const h = await newHost(app);
    const c = await checkout(h, String(pro._id));
    expect(c.status).toBe(200);
    expect((await models.Plan.findById(pro._id)).paystackMode).toBe('test');
  });
  it('grants and revokes plans, sets per-user limits, and keeps paid subscriptions safe', async () => {
    const u = await newHost(app);
    const biz = await models.Plan.findOne({ slug: 'business' });
    const soon = new Date(Date.now() + 7 * 86400000).toISOString();
    expect((await admin.post(A(`/users/${u.user.id}/plan`), { planId: String(biz._id), endsAt: soon })).status).toBe(200);
    expect((await u.get('/api/billing')).body.data.entitlements).toMatchObject({ source: 'admin_grant', plan: { slug: 'business' }, limits: { maxPlayersPerGame: 500 } });
    expect((await admin.post(A(`/users/${u.user.id}/plan`), { planId: String(biz._id), endsAt: '2001-01-01T00:00:00.000Z' })).status).toBe(400);
    expect((await admin.delete(A(`/users/${u.user.id}/plan`))).status).toBe(200);
    expect((await u.get('/api/billing')).body.data.entitlements.source).toBe('free');
    expect((await admin.delete(A(`/users/${u.user.id}/plan`))).status).toBe(200); // already canceled row can be revoked again harmlessly
    // overrides
    expect((await admin.put(A(`/users/${u.user.id}/limits`), { maxPlayersPerGame: 40, maxQuizzes: -1 })).status).toBe(200);
    const ent = (await u.get('/api/billing')).body.data.entitlements;
    expect(ent.limits).toMatchObject({ maxPlayersPerGame: 40, maxQuizzes: -1 }); expect(ent.overridden).toEqual(expect.arrayContaining(['maxPlayersPerGame', 'maxQuizzes']));
    expect((await admin.put(A(`/users/${u.user.id}/limits`), { maxPlayersPerGame: 999999 })).status).toBe(400);
    await admin.put(A(`/users/${u.user.id}/limits`), {});
    expect((await u.get('/api/billing')).body.data.entitlements.limits.maxPlayersPerGame).toBe(10);
    expect((await admin.get(A(`/users/${u.user.id}/billing`))).body.data.entitlements.plan.slug).toBe('free');
    // a paying customer can't be overwritten by a grant
    const payer = await newHost(app);
    const ref = (await checkout(payer, String(pro._id))).body.data.reference; succeed(ref, payer.user); await payer.post('/api/billing/verify', { reference: ref });
    expect((await admin.post(A(`/users/${payer.user.id}/plan`), { planId: String(biz._id) })).body.error.code).toBe('HAS_PAID_SUBSCRIPTION');
    expect((await u.post(A(`/users/${u.user.id}/plan`), { planId: String(biz._id) })).status).toBe(403); // hosts can't grant themselves anything
  });
  it('lists payments and subscribers and reports revenue on the overview', async () => {
    const pays = (await admin.get(A('/payments?status=success'))).body.data;
    expect(pays.items.length).toBeGreaterThanOrEqual(2);
    expect(pays.items[0]).toMatchObject({ status: 'success', currency: 'NGN', user: { email: expect.any(String) } });
    const subs = (await admin.get(A('/subscribers'))).body.data;
    expect(subs.items.some((s) => s.plan === 'Pro')).toBe(true);
    const stats = (await admin.get(A('/stats'))).body.data;
    expect(stats.billing.revenueMinor.NGN).toBeGreaterThanOrEqual(1000000);
    expect(stats.billing.paidSubscribers).toBeGreaterThanOrEqual(1);
  });
  it('switching billing off removes plan limits platform-wide (and is audited)', async () => {
    const h = await newHost(app);
    expect((await h.get('/api/billing')).body.data.entitlements.limits.maxQuizzes).toBe(5);
    await admin.put(A('/settings'), { features: { billing: false } }); settings.resetSettingsCache();
    const o = (await h.get('/api/billing')).body.data;
    expect(o.billingEnabled).toBe(false);
    expect(o.entitlements.limits.maxQuizzes).toBe(-1);
    expect((await checkout(h, String(pro._id))).body.error.code).toBe('BILLING_OFF');
    await admin.put(A('/settings'), { features: { billing: true }, billing: { currency: 'GHS' } }); settings.resetSettingsCache();
    expect((await request(app.server).get('/api/config')).body.data.currency).toBe('GHS');
    await admin.put(A('/settings'), { billing: { currency: 'NGN' } });
    expect((await admin.put(A('/settings'), { billing: { currency: 'XXX' } })).status).toBe(400);
    const audit = (await admin.get(A('/audit?action=settings&limit=10'))).body.data.items;
    expect(audit.some((a) => a.details?.changes?.some((c) => c.setting === 'features.billing'))).toBe(true);
  });
});
