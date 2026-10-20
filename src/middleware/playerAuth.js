import { authenticatePlayerToken } from '../services/playerService.js';
import { unauthorized } from '../utils/errors.js';
import { normalizePin } from '../utils/tokens.js';

/** Anonymous player auth: room-scoped bearer token. Grants no host permissions. */
export async function requirePlayer(req, res, next) {
  try {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) throw unauthorized('Player session required', 'NO_PLAYER_SESSION');
    const { player, room } = await authenticatePlayerToken(token, normalizePin(req.params.code));
    req.player = player;
    req.room = room;
    next();
  } catch (err) { next(err); }
}
