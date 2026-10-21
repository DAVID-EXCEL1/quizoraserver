import http from 'node:http';
import request from 'supertest';
import { io as ioc } from 'socket.io-client';
import mongoose from 'mongoose';

export const PASSWORD = 'Str0ngPassw0rd!';
let seq = 0;
export const uniqueEmail = (p = 'host') => `${p}${Date.now()}${seq++}@example.com`;

export async function boot() {
  const { connectDb } = await import('../src/config/db.js');
  const { createApp } = await import('../src/app.js');
  const { initSockets } = await import('../src/sockets/index.js');
  await connectDb();
  const server = http.createServer(createApp());
  const io = initSockets(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const sockets = [];
  return {
    server, port, url: `http://127.0.0.1:${port}`,
    track: (s) => { sockets.push(s); return s; },
    async close() {
      sockets.forEach((s) => s.disconnect());
      await new Promise((r) => setTimeout(r, 200)); // let server-side disconnect handlers finish
      io.close();
      await mongoose.connection.dropDatabase().catch(() => {});
      await mongoose.disconnect();
    },
  };
}

/** A logged-in host with cookie jar + CSRF header handled for you. */
export async function newHost(app, { email = uniqueEmail(), fullName = 'Alex Chen' } = {}) {
  const agent = request.agent(app.server);
  const res = await agent.post('/api/auth/register').send({ fullName, email, password: PASSWORD, confirmPassword: PASSWORD });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  const cookie = res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const h = { agent, email, user: res.body.data.user, csrf, cookie };
  for (const m of ['post', 'put', 'patch', 'delete']) h[m] = (path, body) => { const r = agent[m](path).set('X-CSRF-Token', h.csrf); return body === undefined ? r : r.send(body); };
  h.get = (path) => agent.get(path);
  return h;
}

export const sampleQuestions = (n = 3, timeLimit = 10) => Array.from({ length: n }, (_, i) => ({
  text: `Question ${i + 1}?`,
  options: [{ key: 'A', text: 'Alpha' }, { key: 'B', text: 'Beta' }, { key: 'C', text: 'Gamma' }, { key: 'D', text: 'Delta' }],
  correctKey: ['A', 'B', 'C', 'D'][i % 4], timeLimit, basePoints: 1000, imageUrl: null,
}));

export async function publishedQuiz(host, { n = 3, title = 'Test Quiz', timeLimit = 10 } = {}) {
  const c = await host.post('/api/quizzes', { title, description: '', questions: sampleQuestions(n, timeLimit) });
  if (c.status !== 201) throw new Error(`quiz create ${c.status} ${JSON.stringify(c.body)}`);
  const p = await host.post(`/api/quizzes/${c.body.data.id}/publish`);
  if (p.status !== 200) throw new Error(`publish ${p.status} ${JSON.stringify(p.body)}`);
  return p.body.data;
}

export async function launch(host, quizId) {
  const r = await host.post('/api/rooms', { quizId });
  if (r.status !== 201) throw new Error(`launch ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

export async function joinPlayer(app, code, nickname, token) {
  const r = request(app.server).post(`/api/rooms/${code}/join`);
  if (token) r.set('X-Player-Token', token);
  return r.send({ nickname });
}

export function connect(app, auth, extraHeaders = {}) {
  const s = ioc(app.url, { auth, extraHeaders, transports: ['websocket'], reconnection: false, forceNew: true });
  app.track(s);
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(Object.assign(new Error(e.message), { data: e.data })));
  });
}
export const connectHost = (app, host) => connect(app, { role: 'host' }, { cookie: host.cookie });
export const connectPlayer = (app, code, token) => connect(app, { role: 'player', roomCode: code, token });

export const ack = (s, evt, payload) => s.timeout(4000).emitWithAck(evt, payload);
export const once = (s, evt, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${evt}`)), ms);
  s.once(evt, (d) => { clearTimeout(t); res(d); });
});
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export { request };

/** Replace global fetch for specific outbound URLs (Paystack/Groq/Pexels); everything else passes through. */
export function mockFetch(handlers) {
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    for (const [rx, fn] of handlers) {
      if (!rx.test(u)) continue;
      const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
      calls.push({ url: u, method: opts.method || 'GET', body, headers: opts.headers });
      const out = await fn({ url: u, body, headers: opts.headers });
      return new Response(JSON.stringify(out.body ?? out), { status: out.status || 200, headers: { 'content-type': 'application/json' } });
    }
    return real(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** Minimal valid multi-line PDF for upload tests. */
export function makePdf(lines) {
  const esc = (s) => s.replace(/[()\\]/g, '\\$&');
  const content = `BT /F1 10 Tf 40 750 Td 12 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj${o}endobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
