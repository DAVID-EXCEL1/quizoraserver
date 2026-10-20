import { clamp } from '../utils/misc.js';

/**
 * Points = Base Points × (Time Remaining / Total Time Limit)
 * All inputs are server-side epoch milliseconds. Remaining time is clamped to [0, limit].
 */
export function computePoints({ basePoints, timeLimitMs, deadlineMs, receivedAtMs }) {
  const remaining = clamp(deadlineMs - receivedAtMs, 0, timeLimitMs);
  return Math.round(basePoints * (remaining / timeLimitMs));
}

export function rankPlayers(players) {
  const sorted = [...players].sort((a, b) =>
    b.score - a.score
    || b.correctCount - a.correctCount
    || (a.answeredCount ? a.totalResponseMs / a.answeredCount : Infinity) - (b.answeredCount ? b.totalResponseMs / b.answeredCount : Infinity)
    || +new Date(a.joinedAt) - +new Date(b.joinedAt));
  return sorted.map((p, i) => ({ ...p, rank: i + 1 }));
}
