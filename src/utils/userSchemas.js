import { z } from 'zod';

// Match Mongoose's UTF-16 name limit even when Zod counts Unicode code points.
const name = z.string().trim().min(1).refine((value) => value.length <= 100);
const email = z.string().trim().toLowerCase().pipe(z.email());
const password = z.string().min(8).refine((value) => Buffer.byteLength(value, 'utf8') <= 72);
export const interestSchema = z.string().trim().toLowerCase().refine((value) => value.length <= 100);
const interests = z.array(interestSchema).refine((values) => new Set(values.filter(Boolean)).size <= 20);

export const registerSchema = z.object({ name, email, password, interests: interests.default([]) });
export const loginSchema = z.object({ email, password });
export const profileSchema = z.object({ name, interests }).partial()
  .refine((value) => Object.keys(value).length > 0);

const role = z.enum(['user', 'admin']);
export const adminCreateSchema = registerSchema.extend({ role: role.default('user') });
export const adminUpdateSchema = z.object({ name, email, password, interests, role }).partial()
  .refine((value) => Object.keys(value).length > 0);
