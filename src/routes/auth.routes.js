import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { register, login } from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { registerSchema, loginSchema } from '../utils/userSchemas.js';

export const authRouter = Router();
// shortcut: counts live in this process; use a shared store before running multiple instances.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10,
  standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: { message: 'Too many authentication attempts; try again later' } },
});
authRouter.post('/register', authLimiter, validate(registerSchema), register);
authRouter.post('/login', authLimiter, validate(loginSchema), login);
