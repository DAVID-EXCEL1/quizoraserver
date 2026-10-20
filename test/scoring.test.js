import { describe, it, expect } from 'vitest';
import { computePoints, rankPlayers } from '../src/services/scoring.js';

describe('16. scoring formula', () => {
  const base = { basePoints: 1000, timeLimitMs: 20000 };
  it('matches the spec example: 15s of 20s remaining = 750', () => {
    expect(computePoints({ ...base, deadlineMs: 20000, receivedAtMs: 5000 })).toBe(750);
  });
  it('answering instantly gives full points; at the deadline gives zero', () => {
    expect(computePoints({ ...base, deadlineMs: 20000, receivedAtMs: 0 })).toBe(1000);
    expect(computePoints({ ...base, deadlineMs: 20000, receivedAtMs: 20000 })).toBe(0);
  });
  it('clamps: late answers get 0, early clock skew cannot exceed base points', () => {
    expect(computePoints({ ...base, deadlineMs: 20000, receivedAtMs: 25000 })).toBe(0);
    expect(computePoints({ ...base, deadlineMs: 20000, receivedAtMs: -5000 })).toBe(1000);
  });
  it('rounds to integers consistently', () => {
    expect(computePoints({ basePoints: 1000, timeLimitMs: 30000, deadlineMs: 30000, receivedAtMs: 1 })).toBe(1000); // 999.97
    expect(Number.isInteger(computePoints({ basePoints: 777, timeLimitMs: 15000, deadlineMs: 15000, receivedAtMs: 4321 }))).toBe(true);
  });
});

describe('21. ranking', () => {
  it('orders by score, then correct answers, then speed, then join time', () => {
    const t = (n) => new Date(2026, 0, 1, 0, 0, n);
    const ranked = rankPlayers([
      { nickname: 'c', score: 500, correctCount: 1, answeredCount: 1, totalResponseMs: 3000, joinedAt: t(3) },
      { nickname: 'a', score: 900, correctCount: 1, answeredCount: 1, totalResponseMs: 3000, joinedAt: t(1) },
      { nickname: 'b', score: 500, correctCount: 2, answeredCount: 2, totalResponseMs: 9000, joinedAt: t(2) },
      { nickname: 'd', score: 500, correctCount: 1, answeredCount: 1, totalResponseMs: 1000, joinedAt: t(4) },
    ]);
    expect(ranked.map((p) => p.nickname)).toEqual(['a', 'b', 'd', 'c']);
    expect(ranked.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
  });
});
