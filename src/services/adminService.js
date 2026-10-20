import { User, Quiz, Room, Player, Answer, GameResult, Session, AuthToken, AuditLog } from '../models/index.js';
import { AppError, notFound } from '../utils/errors.js';
import { escapeRegex } from '../utils/misc.js';
import { log } from '../utils/logger.js';
import { revokeAllForUser } from './authService.js';
import { forceExpireRoom, pushHostState } from './gameService.js';
import { broadcastRoster } from './playerService.js';
import { fullQuiz } from './quizService.js';
import { getIo, toPlayer } from '../sockets/broadcast.js';

const LIVE = ['LOBBY', 'QUESTION_ACTIVE', 'QUESTION_RESULT', 'LEADERBOARD'];
const pages = (total, limit) => Math.max(1, Math.ceil(total / limit));

/* ------------------------------------------------------------------ audit */
export async function audit(admin, action, target, details, ip) {
  try {
    const clean = details ? JSON.parse(JSON.stringify(details, (k, v) => (typeof v === 'string' ? v.slice(0, 300) : v))) : undefined;
    await AuditLog.create({
      adminId: admin?._id, adminEmail: admin?.email || 'system', action,
      targetType: target.type, targetId: target.id ? String(target.id) : undefined, targetLabel: target.label, details: clean, ip,
    });
  } catch (e) { log.error('audit write failed', e.message); }
}

/* ------------------------------------------------------------------ overview */
export async function stats() {
  const now = new Date();
  const day = 24 * 3600 * 1000;
  const since7 = new Date(now - 7 * day);
  const since14 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 13 * day);
  const [users, active, suspended, admins, newUsers, quizzes, published, games, participants, liveRooms, recent] = await Promise.all([
    User.countDocuments({}), User.countDocuments({ status: 'active' }), User.countDocuments({ status: 'suspended' }), User.countDocuments({ role: 'admin' }),
    User.countDocuments({ createdAt: { $gte: since7 } }), Quiz.countDocuments({}), Quiz.countDocuments({ status: 'published' }),
    GameResult.countDocuments({}), GameResult.aggregate([{ $group: { _id: null, n: { $sum: '$participantCount' } } }]),
    Room.countDocuments({ status: { $in: LIVE }, expiresAt: { $gt: now } }), GameResult.find({ completedAt: { $gte: since14 } }).select('completedAt participantCount').lean(),
  ]);
  const buckets = new Map();
  for (let i = 0; i < 14; i++) buckets.set(new Date(+since14 + i * day).toISOString().slice(0, 10), { games: 0, players: 0 });
  for (const g of recent) { const b = buckets.get(new Date(g.completedAt).toISOString().slice(0, 10)); if (b) { b.games++; b.players += g.participantCount; } }
  return {
    users: { total: users, active, suspended, admins, newLast7Days: newUsers },
    quizzes: { total: quizzes, published, drafts: quizzes - published },
    games: { completed: games, participants: participants[0]?.n ?? 0, live: liveRooms },
    activity: [...buckets].map(([date, v]) => ({ date, ...v })),
  };
}

/* ------------------------------------------------------------------ users */
const userRow = (u) => ({ id: String(u._id), fullName: u.fullName, email: u.email, role: u.role || 'host', status: u.status, emailVerified: !!u.emailVerified, createdAt: u.createdAt, suspendedReason: u.suspendedReason });

export async function listUsers({ page, limit, search, status, role }) {
  const filter = {};
  if (status) filter.status = status;
  if (role) filter.role = role;
  if (search) { const rx = { $regex: escapeRegex(search), $options: 'i' }; filter.$or = [{ fullName: rx }, { email: rx }]; }
  const [items, total] = await Promise.all([User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), User.countDocuments(filter)]);
  const rows = await Promise.all(items.map(async (u) => ({
    ...userRow(u), quizCount: await Quiz.countDocuments({ ownerId: u._id }), gameCount: await GameResult.countDocuments({ hostId: u._id }),
  })));
  return { items: rows, total, page, pages: pages(total, limit) };
}

async function getUser(id) {
  const u = await User.findById(id).lean();
  if (!u) throw notFound('User');
  return u;
}

export async function userDetail(id) {
  const u = await getUser(id);
  const now = new Date();
  const [quizzes, games, live, sessions] = await Promise.all([
    Quiz.find({ ownerId: id }).select('title status updatedAt questions.correctKey').sort({ updatedAt: -1 }).limit(50).lean(),
    GameResult.find({ hostId: id }).select('-questionStats').sort({ completedAt: -1 }).limit(10).lean(),
    Room.find({ hostId: id, status: { $in: LIVE }, expiresAt: { $gt: now } }).select('code status snapshot.title createdAt').lean(),
    Session.countDocuments({ userId: id, revokedAt: null, expiresAt: { $gt: now } }),
  ]);
  return {
    user: userRow(u), activeSessions: sessions,
    quizzes: quizzes.map((q) => ({ id: String(q._id), title: q.title, status: q.status, questionCount: q.questions.length, updatedAt: q.updatedAt })),
    games: games.map((g) => ({ id: String(g._id), roomCode: g.roomCode, quizTitle: g.quizTitle, completedAt: g.completedAt, participantCount: g.participantCount, winner: g.rankings?.[0]?.nickname || null })),
    liveRooms: live.map((r) => ({ code: r.code, status: r.status, quizTitle: r.snapshot.title })),
  };
}

async function endHostedRooms(userId, reason) {
  const rooms = await Room.find({ hostId: userId, status: { $in: LIVE } }).select('_id').lean();
  for (const r of rooms) await forceExpireRoom(r._id, reason);
  return rooms.length;
}
const dropHostSockets = (userId) => getIo()?.in(`host:${userId}`).disconnectSockets(true);

function guardTarget(admin, target, { allowAdmin = false } = {}) {
  if (String(admin._id) === String(target._id)) throw new AppError(400, 'CANNOT_TARGET_SELF', 'You can’t do that to your own account');
  if (!allowAdmin && target.role === 'admin') throw new AppError(409, 'TARGET_IS_ADMIN', 'This user is an administrator. Remove their admin role first.');
}

export async function suspendUser(admin, id, reason, ip) {
  const t = await getUser(id);
  guardTarget(admin, t);
  if (t.status === 'suspended') throw new AppError(409, 'ALREADY_SUSPENDED', 'This account is already suspended');
  await User.updateOne({ _id: id }, { $set: { status: 'suspended', suspendedReason: reason || undefined } });
  await revokeAllForUser(id);
  const ended = await endHostedRooms(id, 'host_suspended');
  dropHostSockets(id);
  await audit(admin, 'user.suspend', { type: 'user', id, label: t.email }, { reason, endedLiveGames: ended }, ip);
}

export async function reinstateUser(admin, id, ip) {
  const t = await getUser(id);
  if (t.status !== 'suspended') throw new AppError(409, 'NOT_SUSPENDED', 'This account isn’t suspended');
  await User.updateOne({ _id: id }, { $set: { status: 'active', failedLoginCount: 0, lockUntil: null }, $unset: { suspendedReason: 1 } });
  await audit(admin, 'user.reinstate', { type: 'user', id, label: t.email }, undefined, ip);
}

export async function verifyUserEmail(admin, id, ip) {
  const t = await getUser(id);
  await User.updateOne({ _id: id }, { $set: { emailVerified: true } });
  await audit(admin, 'user.verify_email', { type: 'user', id, label: t.email }, undefined, ip);
}

export async function revokeUserSessions(admin, id, ip) {
  const t = await getUser(id);
  await revokeAllForUser(id);
  dropHostSockets(id);
  await audit(admin, 'user.revoke_sessions', { type: 'user', id, label: t.email }, undefined, ip);
}

export async function setUserRole(admin, id, role, ip) {
  const t = await getUser(id);
  if (String(admin._id) === String(t._id)) throw new AppError(400, 'CANNOT_TARGET_SELF', 'You can’t change your own role');
  if ((t.role || 'host') === role) throw new AppError(409, 'NO_CHANGE', `This user is already ${role === 'admin' ? 'an administrator' : 'a host'}`);
  if (role === 'host' && (await User.countDocuments({ role: 'admin', status: 'active' })) <= 1) {
    throw new AppError(409, 'LAST_ADMIN', 'At least one active administrator must remain');
  }
  if (role === 'admin' && t.status !== 'active') throw new AppError(409, 'NOT_ACTIVE', 'Reinstate this account before making it an administrator');
  await User.updateOne({ _id: id }, { $set: { role } });
  await audit(admin, role === 'admin' ? 'user.promote' : 'user.demote', { type: 'user', id, label: t.email }, { role }, ip);
}

export async function deleteUser(admin, id, ip) {
  const t = await getUser(id);
  guardTarget(admin, t);
  await endHostedRooms(id, 'host_deleted');
  dropHostSockets(id);
  const quizzes = await Quiz.deleteMany({ ownerId: id });
  await Session.deleteMany({ userId: id });
  await AuthToken.deleteMany({ userId: id });
  await User.deleteOne({ _id: id });
  // Finished game results are historical records and are kept.
  await audit(admin, 'user.delete', { type: 'user', id, label: t.email }, { quizzesDeleted: quizzes.deletedCount }, ip);
}

/* ------------------------------------------------------------------ quizzes */
export async function listQuizzes({ page, limit, search, status }) {
  const filter = {};
  if (status) filter.status = status;
  if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };
  const [items, total] = await Promise.all([
    Quiz.find(filter).select('ownerId title status updatedAt questions.correctKey').sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Quiz.countDocuments(filter),
  ]);
  const owners = await User.find({ _id: { $in: items.map((q) => q.ownerId) } }).select('fullName email').lean();
  const map = new Map(owners.map((o) => [String(o._id), o]));
  return {
    items: items.map((q) => ({ id: String(q._id), title: q.title, status: q.status, questionCount: q.questions.length, updatedAt: q.updatedAt, owner: map.get(String(q.ownerId)) ? { id: String(q.ownerId), fullName: map.get(String(q.ownerId)).fullName, email: map.get(String(q.ownerId)).email } : null })),
    total, page, pages: pages(total, limit),
  };
}

export async function quizDetail(id) {
  const q = await Quiz.findById(id);
  if (!q) throw notFound('Quiz');
  const owner = await User.findById(q.ownerId).select('fullName email').lean();
  return { ...fullQuiz(q), owner: owner ? { id: String(owner._id), fullName: owner.fullName, email: owner.email } : null };
}

export async function unpublishQuiz(admin, id, reason, ip) {
  const q = await Quiz.findById(id);
  if (!q) throw notFound('Quiz');
  if (q.status !== 'published') throw new AppError(409, 'NOT_PUBLISHED', 'This quiz isn’t published');
  q.status = 'draft'; await q.save();
  await audit(admin, 'quiz.unpublish', { type: 'quiz', id, label: q.title }, { reason, owner: String(q.ownerId) }, ip);
}

export async function deleteQuiz(admin, id, reason, ip) {
  const q = await Quiz.findById(id);
  if (!q) throw notFound('Quiz');
  await Quiz.deleteOne({ _id: id }); // running games keep their own snapshot
  await audit(admin, 'quiz.delete', { type: 'quiz', id, label: q.title }, { reason, owner: String(q.ownerId) }, ip);
}

/* ------------------------------------------------------------------ live rooms & players */
export async function liveRooms() {
  const now = new Date();
  const rooms = await Room.find({ status: { $in: LIVE }, expiresAt: { $gt: now } }).sort({ createdAt: -1 }).limit(100).lean();
  const hosts = await User.find({ _id: { $in: rooms.map((r) => r.hostId) } }).select('fullName email').lean();
  const hmap = new Map(hosts.map((h) => [String(h._id), h]));
  return Promise.all(rooms.map(async (r) => ({
    code: r.code, status: r.status, quizTitle: r.snapshot.title, createdAt: r.createdAt, expiresAt: r.expiresAt,
    questionIndex: r.currentQuestionIndex >= 0 ? r.currentQuestionIndex : null, totalQuestions: r.snapshot.questions.length,
    playerCount: await Player.countDocuments({ roomId: r._id }),
    host: hmap.get(String(r.hostId)) ? { id: String(r.hostId), fullName: hmap.get(String(r.hostId)).fullName, email: hmap.get(String(r.hostId)).email } : null,
  })));
}

async function roomByCode(code) {
  const r = await Room.findOne({ code });
  if (!r) throw notFound('Game');
  return r;
}

export async function roomDetail(code) {
  const r = await roomByCode(code);
  const [players, host] = await Promise.all([Player.find({ roomId: r._id }).sort({ joinedAt: 1 }).select('nickname connected score joinedAt').lean(), User.findById(r.hostId).select('fullName email').lean()]);
  return {
    code: r.code, status: r.status, quizTitle: r.snapshot.title, createdAt: r.createdAt, expiresAt: r.expiresAt, expiredReason: r.expiredReason,
    questionIndex: r.currentQuestionIndex >= 0 ? r.currentQuestionIndex : null, totalQuestions: r.snapshot.questions.length,
    host: host ? { id: String(host._id), fullName: host.fullName, email: host.email } : null,
    players: players.map((p) => ({ id: String(p._id), nickname: p.nickname, connected: p.connected, score: p.score, joinedAt: p.joinedAt })),
  };
}

export async function endRoom(admin, code, reason, ip) {
  const r = await roomByCode(code);
  const ended = await forceExpireRoom(r._id, 'admin_ended');
  if (!ended) throw new AppError(409, 'NOT_LIVE', 'This game isn’t live any more');
  await audit(admin, 'room.end', { type: 'room', id: r._id, label: `${r.code} · ${r.snapshot.title}` }, { reason, host: String(r.hostId) }, ip);
}

export async function kickPlayer(admin, code, playerId, reason, ip) {
  const r = await roomByCode(code);
  if (!LIVE.includes(r.status)) throw new AppError(409, 'NOT_LIVE', 'This game isn’t live any more');
  const p = await Player.findOne({ _id: playerId, roomId: r._id }); // must belong to this room
  if (!p) throw notFound('Player');
  toPlayer(p._id, 'player:kicked', { reason: 'removed_by_admin' });
  await Answer.deleteMany({ roomId: r._id, playerId: p._id });
  await Player.deleteOne({ _id: p._id });
  getIo()?.in(`player:${p._id}`).disconnectSockets(true);
  await broadcastRoster(r._id);
  await pushHostState(r._id);
  await audit(admin, 'player.kick', { type: 'player', id: p._id, label: `${p.nickname} in ${r.code}` }, { reason }, ip);
}

/* ------------------------------------------------------------------ finished games */
export async function listGames({ page, limit, search }) {
  const filter = {};
  if (search) filter.$or = [{ quizTitle: { $regex: escapeRegex(search), $options: 'i' } }, { roomCode: search.toUpperCase() }];
  const [items, total] = await Promise.all([GameResult.find(filter).select('-questionStats').sort({ completedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), GameResult.countDocuments(filter)]);
  const hosts = await User.find({ _id: { $in: items.map((g) => g.hostId) } }).select('fullName email').lean();
  const hmap = new Map(hosts.map((h) => [String(h._id), h]));
  return {
    items: items.map((g) => ({ id: String(g._id), roomCode: g.roomCode, quizTitle: g.quizTitle, completedAt: g.completedAt, participantCount: g.participantCount, winner: g.rankings?.[0]?.nickname || null, host: hmap.get(String(g.hostId)) ? { fullName: hmap.get(String(g.hostId)).fullName, email: hmap.get(String(g.hostId)).email } : null })),
    total, page, pages: pages(total, limit),
  };
}

export async function deleteGame(admin, id, reason, ip) {
  const g = await GameResult.findById(id).select('roomCode quizTitle hostId').lean();
  if (!g) throw notFound('Game');
  await GameResult.deleteOne({ _id: id });
  await audit(admin, 'game.delete', { type: 'game', id, label: `${g.roomCode} · ${g.quizTitle}` }, { reason, host: String(g.hostId) }, ip);
}

/* ------------------------------------------------------------------ audit log */
export async function listAudit({ page, limit, search, action }) {
  const filter = {};
  if (action) filter.action = { $regex: `^${escapeRegex(action)}` };
  if (search) { const rx = { $regex: escapeRegex(search), $options: 'i' }; filter.$or = [{ adminEmail: rx }, { targetLabel: rx }]; }
  const [items, total] = await Promise.all([AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), AuditLog.countDocuments(filter)]);
  return {
    items: items.map((a) => ({ id: String(a._id), at: a.createdAt, adminEmail: a.adminEmail, action: a.action, targetType: a.targetType, targetId: a.targetId, targetLabel: a.targetLabel, details: a.details || null, ip: a.ip })),
    total, page, pages: pages(total, limit),
  };
}
