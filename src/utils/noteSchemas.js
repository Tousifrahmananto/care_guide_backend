import { z } from 'zod';

// Match the model's UTF-16 limits; preserve content whitespace.
const title = z.string().trim().min(1).refine((value) => value.length <= 200);
const content = z.string().refine((value) => value.length <= 10000);

export const createNoteSchema = z.object({ title, content: content.optional() });
export const updateNoteSchema = z.object({ title, content }).partial()
  .refine((value) => Object.keys(value).length > 0);
