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
    billing: await billingStats(),
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
  const [players, host] = await Promise.all([Player.find({ roomId: r._id }).sort({ joinedAt: 1 }).select('nickname sticker muted connected score joinedAt').lean(), User.findById(r.hostId).select('fullName email').lean()]);
  return {
    code: r.code, status: r.status, quizTitle: r.snapshot.title, createdAt: r.createdAt, expiresAt: r.expiresAt, expiredReason: r.expiredReason,
    questionIndex: r.currentQuestionIndex >= 0 ? r.currentQuestionIndex : null, totalQuestions: r.snapshot.questions.length,
    host: host ? { id: String(host._id), fullName: host.fullName, email: host.email } : null,
    chat: { mode: r.chatMode, enabled: r.features?.chat !== false },
    players: players.map((p) => ({ id: String(p._id), nickname: p.nickname, sticker: p.sticker || '', muted: !!p.muted, connected: p.connected, score: p.score, joinedAt: p.joinedAt })),
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

/* ================================================================== settings, stickers, billing, chat moderation */
import { Sticker, Plan, Subscription, Payment, ChatMessage } from '../models/index.js';
import { getSettings, updateSettings } from './settings.js';
import { entitlementsFor } from './entitlements.js';
import { messageView, setMuted as chatSetMuted, deleteMessage as chatDeleteMessage } from './chatService.js';
import { planView } from './billingService.js';
import * as ps from './paystack.js';
import { env } from '../config/env.js';

export async function saveSettings(admin, patch, ip) {
  const before = await getSettings();
  const after = await updateSettings(patch);
  const changes = [];
  for (const [group, vals] of Object.entries(patch)) for (const [k, v] of Object.entries(vals)) if (JSON.stringify(before[group][k]) !== JSON.stringify(v)) changes.push({ setting: `${group}.${k}`, value: k === 'blockedWords' ? `${v.length} words` : v }); // list, not dotted keys (invalid in MongoDB documents)
  if (changes.length) await audit(admin, 'settings.update', { type: 'system', label: 'Platform settings' }, { changes }, ip);
  return after;
}

/* ---- stickers ---- */
const stickerRow = (s) => ({ id: String(s._id), emoji: s.emoji, label: s.label, pack: s.pack, active: s.active, order: s.order });
export async function listStickers() { return (await Sticker.find({}).sort({ order: 1, createdAt: 1 }).lean()).map(stickerRow); }
export async function addSticker(admin, { emoji, label, pack }, ip) {
  const last = await Sticker.findOne({}).sort({ order: -1 }).select('order').lean();
  try { var s = await Sticker.create({ emoji, label, pack, order: (last?.order ?? -1) + 1 }); } catch (e) { if (e.code === 11000) throw new AppError(409, 'STICKER_EXISTS', 'That sticker already exists'); throw e; }
  await audit(admin, 'sticker.add', { type: 'system', id: s._id, label: `${emoji} ${label || ''}`.trim() }, { pack }, ip);
  return stickerRow(s);
}
export async function editSticker(admin, id, patch, ip) {
  const s = await Sticker.findByIdAndUpdate(id, { $set: patch }, { new: true });
  if (!s) throw notFound('Sticker');
  await audit(admin, 'sticker.update', { type: 'system', id, label: s.emoji }, patch, ip);
  return stickerRow(s);
}
export async function removeSticker(admin, id, ip) {
  const s = await Sticker.findByIdAndDelete(id);
  if (!s) throw notFound('Sticker');
  await audit(admin, 'sticker.delete', { type: 'system', id, label: s.emoji }, undefined, ip);
}

/* ---- plans ---- */
export async function listPlans() {
  const plans = await Plan.find({}).sort({ sortOrder: 1, priceMinor: 1 }).lean();
  const now = new Date();
  const liveSubscription = {
    status: { $in: ['active', 'non_renewing', 'past_due'] },
    $or: [{ currentPeriodEnd: null }, { currentPeriodEnd: { $gt: now } }],
  };
  const defaultPlan = plans.find((p) => p.isDefault);
  const [userCount, defaultPlanSubscribers] = defaultPlan
    ? await Promise.all([
      User.countDocuments({}),
      Subscription.distinct('userId', { ...liveSubscription, planId: { $ne: defaultPlan._id } }),
    ])
    : [0, []];
  return Promise.all(plans.map(async (p) => ({
    ...planView(p),
    subscribers: p.isDefault
      ? userCount - defaultPlanSubscribers.length
      : await Subscription.countDocuments({ ...liveSubscription, planId: p._id }),
  })));
}

async function syncPaystack(plan, { recreate = false, billingChanged = false } = {}) {
  if (!plan.paystackPlanCode) return 'skipped';
  const discardCachedPlan = async () => {
    await Plan.updateOne({ _id: plan._id }, { $unset: { paystackPlanCode: 1, paystackMode: 1 } });
    plan.paystackPlanCode = undefined;
    plan.paystackMode = undefined;
  };
  if (recreate || (!ps.paystackConfigured() && billingChanged) || (ps.paystackConfigured() && plan.paystackMode !== ps.paystackMode())) {
    await discardCachedPlan();
    return 'recreated';
  }
  if (!ps.paystackConfigured()) return 'skipped';
  try {
    await ps.updatePlan(plan.paystackPlanCode, { name: plan.name, amountMinor: plan.priceMinor, interval: plan.interval });
    return 'synced';
  } catch (e) {
    await discardCachedPlan();
    return `failed: ${e.message}`;
  }
}

export async function createPlan(admin, data, ip) {
  if (data.isDefault && data.priceMinor > 0) throw new AppError(400, 'DEFAULT_MUST_BE_FREE', 'The default plan must be free');
  try {
    if (data.isDefault) await Plan.updateMany({}, { $set: { isDefault: false } });
    var plan = await Plan.create(data);
  } catch (e) { if (e.code === 11000) throw new AppError(409, 'SLUG_TAKEN', 'A plan with that identifier already exists'); throw e; }
  await audit(admin, 'plan.create', { type: 'system', id: plan._id, label: plan.name }, { priceMinor: plan.priceMinor, currency: plan.currency }, ip);
  return planView(plan);
}

export async function updatePlan(admin, id, patch, ip) {
  const plan = await Plan.findById(id);
  if (!plan) throw notFound('Plan');
  if (plan.isDefault && patch.active === false) throw new AppError(409, 'DEFAULT_PLAN', 'The default plan can’t be deactivated. Make another plan the default first.');
  if (patch.isDefault === false && plan.isDefault) throw new AppError(409, 'DEFAULT_PLAN', 'Pick another plan as the default instead.');
  const price = patch.priceMinor ?? plan.priceMinor;
  if ((patch.isDefault || plan.isDefault) && price > 0) throw new AppError(400, 'DEFAULT_MUST_BE_FREE', 'The default plan must be free');
  const priceChanged = patch.priceMinor !== undefined && patch.priceMinor !== plan.priceMinor;
  const currencyChanged = patch.currency !== undefined && patch.currency !== plan.currency;
  const intervalChanged = patch.interval !== undefined && patch.interval !== plan.interval;
  if (patch.isDefault) await Plan.updateMany({ _id: { $ne: id } }, { $set: { isDefault: false } });
  const { limits, features, ...rest } = patch;
  Object.assign(plan, rest);
  if (limits) plan.limits = { ...plan.limits.toObject(), ...limits };
  if (features) plan.features = { ...plan.features.toObject(), ...features };
  try { await plan.save(); } catch (e) { if (e.code === 11000) throw new AppError(409, 'SLUG_TAKEN', 'A plan with that identifier already exists'); throw e; }
  const billingChanged = priceChanged || currencyChanged || intervalChanged;
  const paystackSync = billingChanged || patch.name
    ? await syncPaystack(plan, { recreate: currencyChanged, billingChanged })
    : 'unchanged';
  await audit(admin, 'plan.update', { type: 'system', id, label: plan.name }, { ...patch, paystackSync }, ip);
  return { plan: planView(plan), paystackSync };
}

export async function deletePlan(admin, id, ip) {
  const plan = await Plan.findById(id);
  if (!plan) throw notFound('Plan');
  if (plan.isDefault) throw new AppError(409, 'DEFAULT_PLAN', 'The default plan can’t be deleted');
  if (await Subscription.countDocuments({ planId: id })) throw new AppError(409, 'HAS_SUBSCRIBERS', 'This plan has subscribers. Deactivate it instead so they keep access.');
  await Plan.deleteOne({ _id: id });
  await audit(admin, 'plan.delete', { type: 'system', id, label: plan.name }, undefined, ip);
}

/* ---- payments & subscribers ---- */
export async function listPayments({ page, limit, status }) {
  const filter = status ? { status } : {};
  const [items, total] = await Promise.all([Payment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Payment.countDocuments(filter)]);
  const users = await User.find({ _id: { $in: items.map((p) => p.userId) } }).select('email fullName').lean();
  const map = new Map(users.map((u) => [String(u._id), u]));
  return { items: items.map((p) => ({ id: String(p._id), reference: p.reference, plan: p.planName, kind: p.kind, amountMinor: p.amountMinor, currency: p.currency, status: p.status, paidAt: p.paidAt, createdAt: p.createdAt, user: map.get(String(p.userId)) ? { id: String(p.userId), email: map.get(String(p.userId)).email, fullName: map.get(String(p.userId)).fullName } : null })), total, page, pages: pages(total, limit) };
}

export async function listSubscribers({ page, limit }) {
  const filter = { status: { $in: ['active', 'non_renewing', 'past_due'] } };
  const [items, total] = await Promise.all([Subscription.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Subscription.countDocuments(filter)]);
  const [users, plans] = await Promise.all([User.find({ _id: { $in: items.map((s) => s.userId) } }).select('email fullName').lean(), Plan.find({ _id: { $in: items.map((s) => s.planId) } }).select('name').lean()]);
  const um = new Map(users.map((u) => [String(u._id), u])); const pm = new Map(plans.map((p) => [String(p._id), p]));
  return { items: items.map((s) => ({ id: String(s._id), status: s.status, source: s.source, currentPeriodEnd: s.currentPeriodEnd, plan: pm.get(String(s.planId))?.name, user: um.get(String(s.userId)) ? { id: String(s.userId), email: um.get(String(s.userId)).email, fullName: um.get(String(s.userId)).fullName } : null })), total, page, pages: pages(total, limit) };
}

export async function billingStats() {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [paid, subscribers] = await Promise.all([Payment.find({ status: 'success' }).select('amountMinor currency paidAt').lean(), Subscription.countDocuments({ status: { $in: ['active', 'non_renewing', 'past_due'] }, source: 'paystack' })]);
  const total = {}; const last30 = {};
  for (const p of paid) { total[p.currency] = (total[p.currency] || 0) + p.amountMinor; if (p.paidAt >= since) last30[p.currency] = (last30[p.currency] || 0) + p.amountMinor; }
  return { revenueMinor: total, revenueLast30DaysMinor: last30, paidSubscribers: subscribers };
}

/* ---- per-user plan control ---- */
export async function userBilling(userId) {
  const [ent, sub] = await Promise.all([entitlementsFor(userId), Subscription.findOne({ userId }).lean()]);
  const u = await User.findById(userId).select('planOverrides').lean();
  return { entitlements: ent, subscription: sub ? { status: sub.status, source: sub.source, currentPeriodEnd: sub.currentPeriodEnd, planId: String(sub.planId) } : null, overrides: u?.planOverrides || {} };
}

export async function grantPlan(admin, userId, planId, endsAt, ip) {
  const [t, plan] = await Promise.all([getUser(userId), Plan.findById(planId)]);
  if (!plan) throw notFound('Plan');
  const existing = await Subscription.findOne({ userId }).lean();
  if (existing?.source === 'paystack' && ['active', 'past_due'].includes(existing.status) && (!existing.currentPeriodEnd || existing.currentPeriodEnd > new Date())) {
    throw new AppError(409, 'HAS_PAID_SUBSCRIPTION', 'This user has an active paid subscription. Ask them to cancel it first, or use limit overrides instead.');
  }
  await Subscription.updateOne({ userId }, { $set: { planId, status: 'active', source: 'admin', currentPeriodEnd: endsAt || null }, $unset: { paystackSubscriptionCode: 1, emailToken: 1 } }, { upsert: true });
  await audit(admin, 'user.grant_plan', { type: 'user', id: userId, label: t.email }, { plan: plan.name, endsAt: endsAt ? endsAt.toISOString() : 'never' }, ip);
}

export async function revokePlan(admin, userId, ip) {
  const t = await getUser(userId);
  const sub = await Subscription.findOne({ userId });
  if (!sub) throw new AppError(404, 'NO_SUBSCRIPTION', 'This user has no plan to revoke');
  await Subscription.updateOne({ _id: sub._id }, { $set: { status: 'canceled', currentPeriodEnd: new Date() } });
  await audit(admin, 'user.revoke_plan', { type: 'user', id: userId, label: t.email }, { was: sub.source }, ip);
}

export async function setOverrides(admin, userId, overrides, ip) {
  const t = await getUser(userId);
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== null && v !== undefined));
  await User.updateOne({ _id: userId }, Object.keys(clean).length ? { $set: { planOverrides: clean } } : { $unset: { planOverrides: 1 } });
  await audit(admin, 'user.set_limits', { type: 'user', id: userId, label: t.email }, clean, ip);
}

/* ---- chat moderation ---- */
export async function roomChat(code) {
  const r = await roomByCode(code);
  const rows = await ChatMessage.find({ roomId: r._id }).sort({ createdAt: -1 }).limit(100).lean();
  return rows.reverse().map((m) => ({ ...messageView(m), deleted: m.deleted, deletedBy: m.deletedBy || null }));
}
export async function deleteChat(admin, code, messageId, ip) {
  const r = await roomByCode(code);
  const m = await ChatMessage.findOne({ _id: messageId, roomId: r._id }).lean();
  if (!m) throw notFound('Message');
  await chatDeleteMessage(r._id, messageId, `admin:${admin.email}`);
  await audit(admin, 'chat.delete', { type: 'room', id: r._id, label: `${r.code} · ${m.nickname}` }, { text: m.text }, ip);
}
export async function mutePlayer(admin, code, playerId, muted, ip) {
  const r = await roomByCode(code);
  const p = await chatSetMuted(r._id, playerId, muted);
  await audit(admin, muted ? 'player.mute' : 'player.unmute', { type: 'player', id: playerId, label: `${p.nickname} in ${r.code}` }, undefined, ip);
}
