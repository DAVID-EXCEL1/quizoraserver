import { z } from 'zod';
import { objectId } from './common.js';

const locationOptions = z.array(z.string().trim().min(1).max(50)).max(30).optional().default([]);
export const createRoomSchema = z.object({
  quizId: objectId,
  showQuestionsToPlayers: z.boolean().optional().default(true),
  chatEnabled: z.boolean().optional().default(true),
  locationOptions,
}).strict().superRefine((v, ctx) => {
  if (new Set(v.locationOptions.map((x) => x.toLowerCase())).size !== v.locationOptions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['locationOptions'], message: 'Locations must be unique' });
  }
});

const RESERVED = new Set(['host', 'admin', 'administrator', 'moderator', 'mod', 'dextquiz', 'quizora', 'system', 'staff', 'support', 'teacher', 'null', 'undefined']);
export const nicknameSchema = z.string()
  .transform((s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim())
  .pipe(z.string()
    .min(2, 'Nickname must be at least 2 characters')
    .max(20, 'Nickname must be at most 20 characters')
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.\-']*$/u, 'Use letters, numbers, spaces, . _ - or \' only')
    .refine((s) => !RESERVED.has(s.toLowerCase()), 'That nickname is reserved'));

const stickerField = z.string().trim().min(1).max(16);
export const joinSchema = z.object({ nickname: nicknameSchema, sticker: stickerField.optional(), location: z.string().trim().min(1).max(50).optional() }).strict();
export const playerProfileSchema = z.object({ nickname: nicknameSchema.optional(), sticker: stickerField.optional() }).strict().refine((v) => v.nickname !== undefined || v.sticker !== undefined, 'Nothing to change');

export const answerSchema = z.object({
  questionIndex: z.number().int().min(0).max(1000),
  optionKey: z.enum(['A', 'B', 'C', 'D']),
}).strict();

export const hostActionSchema = z.object({ action: z.enum(['start', 'close', 'leaderboard', 'next', 'end']) }).strict();
export const questionVisibilitySchema = z.object({ showQuestionsToPlayers: z.boolean() }).strict();
