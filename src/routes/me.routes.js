import { Router } from 'express';
import { getMe, updateMe } from '../controllers/me.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { profileSchema } from '../utils/userSchemas.js';

export const meRouter = Router();
meRouter.use(authenticate);
meRouter.get('/', getMe);
meRouter.patch('/', validate(profileSchema), updateMe);
