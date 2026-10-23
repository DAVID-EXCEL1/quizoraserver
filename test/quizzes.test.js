import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, newHost, publishedQuiz, sampleQuestions, launch } from './helpers.js';

let app; let a; let b;
beforeAll(async () => { app = await boot(); a = await newHost(app); b = await newHost(app); });
afterAll(async () => { await app.close(); });

describe('7. quiz CRUD', () => {
  it('creates, edits, publishes, duplicates and deletes', async () => {
    const c = await a.post('/api/quizzes', { title: 'Web Dev', description: 'd', questions: sampleQuestions(2) });
    expect(c.status).toBe(201);
    expect(c.body.data.status).toBe('draft');
    const id = c.body.data.id;

    const e = await a.put(`/api/quizzes/${id}`, { title: 'Web Dev 2', description: 'd2', questions: sampleQuestions(3, 20) });
    expect(e.status).toBe(200);
    expect(e.body.data.questions).toHaveLength(3);
    expect(e.body.data.questions[0].timeLimit).toBe(20);

    expect((await a.post(`/api/quizzes/${id}/publish`)).body.data.status).toBe('published');

    const d = await a.post(`/api/quizzes/${id}/duplicate`);
    expect(d.status).toBe(201);
    expect(d.body.data.id).not.toBe(id);
    expect(d.body.data.status).toBe('draft');
    expect(d.body.data.title).toContain('(copy)');

    const list = await a.get('/api/quizzes?search=web');
    expect(list.body.data.total).toBeGreaterThanOrEqual(2);

    expect((await a.delete(`/api/quizzes/${id}`)).status).toBe(200);
    expect((await a.get(`/api/quizzes/${id}`)).status).toBe(404);
  });

  it('validates structure: 4 options, one correct answer, allowed time limits, image host', async () => {
    const q = sampleQuestions(1)[0];
    const bad = async (patch) => (await a.post('/api/quizzes', { title: 'x', questions: [{ ...q, ...patch }] })).status;
    expect(await bad({ options: q.options.slice(0, 3) })).toBe(400);
    expect(await bad({ correctKey: 'E' })).toBe(400);
    expect(await bad({ timeLimit: 25 })).toBe(400);
    expect(await bad({ imageUrl: 'https://evil.example/x.png' })).toBe(400);
    expect(await bad({ imageUrl: 'http://res.cloudinary.com/x.png' })).toBe(400);
    expect(await bad({ imageUrl: 'https://res.cloudinary.com/demo/image/upload/x.png' })).toBe(201);
    expect(await bad({ unexpected: true })).toBe(400); // strict schema
  });

  it('refuses to publish incomplete quizzes with specific problems', async () => {
    const c = await a.post('/api/quizzes', { title: 'Draft', questions: [] });
    const p = await a.post(`/api/quizzes/${c.body.data.id}/publish`);
    expect(p.status).toBe(422);
    expect(p.body.error.details.problems.length).toBeGreaterThan(0);
    const blank = sampleQuestions(1); blank[0].options[2].text = '';
    const c2 = await a.post('/api/quizzes', { title: 'Blank', questions: blank });
    expect((await a.post(`/api/quizzes/${c2.body.data.id}/publish`)).status).toBe(422);
  });

  it('paginates and filters by status', async () => {
    const pub = await a.get('/api/quizzes?status=published&limit=1');
    expect(pub.body.data.items.every((x) => x.status === 'published')).toBe(true);
    expect(pub.body.data.items.length).toBeLessThanOrEqual(1);
  });
  it('keeps existing quizzes after a downgrade, blocks new ones, and requires over-limit quizzes to be deleted before editing', async () => {
    const host = await newHost(app);
    const { Plan, Subscription } = await import('../src/models/index.js');
    const pro = await Plan.findOne({ slug: 'pro' });
    await Subscription.create({ userId: host.user.id, planId: pro._id, source: 'admin', status: 'active' });
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const created = await host.post('/api/quizzes', { title: `Pro quiz ${i + 1}`, questions: sampleQuestions(1) });
      expect(created.status).toBe(201);
      ids.push(created.body.data.id);
    }

    await Subscription.updateOne({ userId: host.user.id }, { $set: { status: 'canceled', currentPeriodEnd: new Date() } });
    const list = await host.get('/api/quizzes');
    expect(list.body.data.total).toBe(6);
    expect(list.body.data.items.map((quiz) => quiz.id)).toEqual(expect.arrayContaining(ids));
    expect((await host.post('/api/quizzes', { title: 'Another quiz', questions: sampleQuestions(1) })).body.error.code).toBe('PLAN_LIMIT');

    const blockedEdit = await host.put(`/api/quizzes/${ids[0]}`, { title: 'Edited', description: '', questions: sampleQuestions(1) });
    expect(blockedEdit.status).toBe(402);
    expect(blockedEdit.body.error).toMatchObject({ code: 'PLAN_LIMIT', details: { limit: 'maxQuizzes', max: 5 } });
    expect(blockedEdit.body.error.message).toContain('Delete 1 extra quiz');

    expect((await host.delete(`/api/quizzes/${ids[0]}`)).status).toBe(200);
    expect((await host.put(`/api/quizzes/${ids[1]}`, { title: 'Edited', description: '', questions: sampleQuestions(1) })).status).toBe(200);
    expect((await host.get('/api/quizzes')).body.data.total).toBe(5);
  });
});

describe('8. ownership enforcement', () => {
  it("another host cannot read, edit, publish, duplicate, delete or launch someone else's quiz", async () => {
    const q = await publishedQuiz(a, { title: 'Private' });
    const id = q.id;
    expect((await b.get(`/api/quizzes/${id}`)).status).toBe(404);
    expect((await b.put(`/api/quizzes/${id}`, { title: 'hax', questions: [] })).status).toBe(404);
    expect((await b.post(`/api/quizzes/${id}/unpublish`)).status).toBe(404);
    expect((await b.post(`/api/quizzes/${id}/duplicate`)).status).toBe(404);
    expect((await b.delete(`/api/quizzes/${id}`)).status).toBe(404);
    expect((await b.post('/api/rooms', { quizId: id })).status).toBe(404);
    expect((await a.get(`/api/quizzes/${id}`)).body.data.title).toBe('Private'); // untouched
    expect((await b.get('/api/quizzes')).body.data.items.some((x) => x.id === id)).toBe(false);
  });
  it('treats malformed ids as not found', async () => {
    expect((await a.get('/api/quizzes/not-an-id')).status).toBe(404);
    expect((await a.get('/api/quizzes/%7B%22$ne%22:1%7D')).status).toBe(404);
  });
  it('cannot launch drafts', async () => {
    const c = await a.post('/api/quizzes', { title: 'Draft', questions: sampleQuestions(1) });
    expect((await a.post('/api/rooms', { quizId: c.body.data.id })).status).toBe(422);
  });
});

describe('snapshot immutability', () => {
  it('editing or deleting a quiz does not change a launched game', async () => {
    const q = await publishedQuiz(a, { title: 'Snapshot Me' });
    const g = await launch(a, q.id);
    await a.put(`/api/quizzes/${q.id}`, { title: 'Changed', questions: sampleQuestions(1) });
    await a.delete(`/api/quizzes/${q.id}`);
    const { Room } = await import('../src/models/index.js');
    const room = await Room.findById(g.room.id).lean();
    expect(room.snapshot.title).toBe('Snapshot Me');
    expect(room.snapshot.questions).toHaveLength(3);
  });
});
