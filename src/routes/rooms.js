import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requirePlayer } from '../middleware/playerAuth.js';
import { csrfProtect } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import { pinLookupLimiter, joinLimiter } from '../middleware/rateLimit.js';
import { createRoomSchema, joinSchema, hostActionSchema, playerProfileSchema } from '../validators/game.js';
import { pin } from '../validators/common.js';
import * as rooms from '../services/roomService.js';
import * as players from '../services/playerService.js';
import * as game from '../services/gameService.js';
import { hostView, playerView } from '../services/views.js';
import { toHostCtl, toPlayer } from '../sockets/broadcast.js';
import { asyncHandler, ok } from '../utils/misc.js';
import { AppError } from '../utils/errors.js';

const r = Router();

// Normalise and validate :code once for every route.
r.param('code', (req, res, next, value) => {
  const p = pin.safeParse(value);
  if (!p.success) return next(new AppError(404, 'NOT_FOUND', 'Game not found'));
  req.params.code = p.data;
  next();
});

/* ---------- host ---------- */
async function hostPayload(room) {
  return { room: { id: String(room._id), code: room.code }, joinUrl: rooms.joinUrl(room.code), hostUrl: rooms.hostUrl(room.code), qrCode: await rooms.qrFor(room.code), state: await hostView(room) };
}

r.post('/', requireAuth, csrfProtect, validate(createRoomSchema), asyncHandler(async (req, res) => {
  const room = await rooms.createRoom(req.user, req.valid.body.quizId);
  ok(res, await hostPayload(room), 201);
}));

r.get('/:code/host', requireAuth, asyncHandler(async (req, res) => {
  ok(res, await hostPayload(await rooms.getOwnedRoom(req.params.code, req.user._id)));
}));

// REST twin of the socket command, useful as a fallback when a websocket is blocked.
r.post('/:code/host/command', requireAuth, csrfProtect, validate(hostActionSchema), asyncHandler(async (req, res) => {
  const room = await game.runHostAction(req.params.code, req.user._id, req.valid.body.action);
  ok(res, await hostView(room));
}));

/* ---------- players (no account) ---------- */
r.get('/:code/public', pinLookupLimiter, asyncHandler(async (req, res) => ok(res, await players.publicRoomInfo(req.params.code))));

r.post('/:code/join', joinLimiter, validate(joinSchema), asyncHandler(async (req, res) => {
  const existing = (req.get('x-player-token') || '').slice(0, 200) || undefined;
  const { player, room, token, reconnected } = await players.joinRoom(req.params.code, req.valid.body.nickname, existing, req.valid.body.sticker);
  if (!reconnected) {
    await players.broadcastRoster(room._id);
    toHostCtl(room._id, 'player:joined', { id: String(player._id), nickname: player.nickname });
    await game.pushHostState(room._id);
  }
  ok(res, { token, reconnected, player: { id: String(player._id), nickname: player.nickname }, state: await playerView(room, player) }, reconnected ? 200 : 201);
}));

r.get('/:code/state', requirePlayer, asyncHandler(async (req, res) => ok(res, await playerView(req.room, req.player))));

r.patch('/:code/me', requirePlayer, validate(playerProfileSchema), asyncHandler(async (req, res) => {
  const updated = await players.updateProfile(req.player, req.room, req.valid.body);
  await players.broadcastRoster(req.room._id);
  toHostCtl(req.room._id, 'player:updated', { id: String(updated._id), nickname: updated.nickname, sticker: updated.sticker });
  await game.pushHostState(req.room._id);
  toPlayer(updated._id, 'player:updated', { nickname: updated.nickname, sticker: updated.sticker });
  ok(res, { player: { id: String(updated._id), nickname: updated.nickname, sticker: updated.sticker } });
}));

export default r;
