import { z } from 'zod';
export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
export const pin = z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{6}$/, 'Room PIN must be 6 letters/numbers'));
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  search: z.string().trim().max(100).optional(),
});
