import { z } from 'zod';

// Password policy (documented in README): 10-72 bytes, at least one lowercase letter,
// one uppercase letter and one digit. 72 is bcrypt's hard input limit.
export const password = z.string()
  .min(10, 'Password must be at least 10 characters')
  .refine((p) => Buffer.byteLength(p) <= 72, 'Password is too long (max 72 bytes)')
  .refine((p) => /[a-z]/.test(p), 'Password needs a lowercase letter')
  .refine((p) => /[A-Z]/.test(p), 'Password needs an uppercase letter')
  .refine((p) => /\d/.test(p), 'Password needs a number');

const email = z.string().trim().toLowerCase().email('Enter a valid email').max(254);
const fullName = z.string().trim().min(2, 'Enter your full name').max(80);

export const registerSchema = z.object({
  fullName, email, password, confirmPassword: z.string(),
}).strict().refine((v) => v.password === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

export const loginSchema = z.object({ email, password: z.string().min(1).max(200) }).strict();
export const forgotSchema = z.object({ email }).strict();
export const resetSchema = z.object({
  token: z.string().min(20).max(200), password, confirmPassword: z.string(),
}).strict().refine((v) => v.password === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });
export const tokenSchema = z.object({ token: z.string().min(20).max(200) }).strict();
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200), password, confirmPassword: z.string(),
}).strict().refine((v) => v.password === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });
export const profileSchema = z.object({ fullName: fullName.optional(), sticker: z.string().trim().max(16).optional() }).strict()
  .refine((v) => v.fullName !== undefined || v.sticker !== undefined, 'Nothing to change');
