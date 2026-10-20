import { z } from 'zod';
import { objectId } from './common.js';

export const createRoomSchema = z.object({ quizId: objectId }).strict();

const RESERVED = new Set(['host', 'admin', 'administrator', 'moderator', 'mod', 'quizora', 'system', 'staff', 'support', 'teacher', 'null', 'undefined']);
export const nicknameSchema = z.string()
  .transform((s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim())
  .pipe(z.string()
    .min(2, 'Nickname must be at least 2 characters')
    .max(20, 'Nickname must be at most 20 characters')
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.\-']*$/u, 'Use letters, numbers, spaces, . _ - or \' only')
    .refine((s) => !RESERVED.has(s.toLowerCase()), 'That nickname is reserved'));

export const joinSchema = z.object({ nickname: nicknameSchema }).strict();

export const answerSchema = z.object({
  questionIndex: z.number().int().min(0).max(1000),
  optionKey: z.enum(['A', 'B', 'C', 'D']),
}).strict();

export const hostActionSchema = z.object({ action: z.enum(['start', 'close', 'leaderboard', 'next', 'end']) }).strict();
