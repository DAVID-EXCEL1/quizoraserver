import { z } from 'zod';

const KEYS = ['A', 'B', 'C', 'D'];

// Question images may only come from Cloudinary (https), which stops hosts from
// hot-linking arbitrary third-party URLs that could track players.
const imageUrl = z.string().url().max(500)
  .refine((u) => { try { const x = new URL(u); return x.protocol === 'https:' && ['res.cloudinary.com', 'images.pexels.com'].includes(x.hostname); } catch { return false; } },
    'Image must be uploaded through DextQuiz or come from the built-in photo search')
  .nullish()
  .transform((v) => v || null);

const option = z.object({ key: z.enum(KEYS), text: z.string().trim().max(120) }).strict();

export const questionSchema = z.object({
  text: z.string().trim().max(300),
  options: z.array(option).length(4)
    .refine((o) => o.every((x, i) => x.key === KEYS[i]), 'Options must be A, B, C, D in order'),
  correctKey: z.enum(KEYS),
  timeLimit: z.union([z.literal(10), z.literal(15), z.literal(20), z.literal(30)]).default(20),
  basePoints: z.number().int().min(1).max(10000).default(1000),
  imageUrl,
}).strict();

export const quizSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(100),
  description: z.string().trim().max(500).optional().default(''),
  questions: z.array(questionSchema).max(100).default([]),
}).strict();

export const quizListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  search: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'published']).optional(),
});

/** Returns a list of problems that prevent publishing/launching; empty = OK. */
export function publishProblems(quiz) {
  const problems = [];
  if (!quiz.questions?.length) problems.push('Add at least one question');
  quiz.questions?.forEach((q, i) => {
    const n = i + 1;
    if (!q.text?.trim()) problems.push(`Question ${n}: question text is empty`);
    if (q.options.some((o) => !o.text?.trim())) problems.push(`Question ${n}: all four answers need text`);
    if (!q.options.some((o) => o.key === q.correctKey)) problems.push(`Question ${n}: choose the correct answer`);
  });
  return problems;
}
